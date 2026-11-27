import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { randomBytes } from "crypto";
import { BlinkshopEscrow } from "../target/types/blinkshop_escrow";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("blinkshop-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.BlinkshopEscrow as Program<BlinkshopEscrow>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  const buyer = Keypair.generate();
  const merchant = Keypair.generate();
  const rentPayer = Keypair.generate(); // stands in for the BlinkShop sponsor
  const stranger = Keypair.generate();

  const USDC = (n: number) => new BN(n * 1_000_000);
  let mint: PublicKey;
  let buyerToken: PublicKey;
  let merchantToken: PublicKey;

  const orderPda = (id: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("order"), merchant.publicKey.toBuffer(), id],
      program.programId
    )[0];
  const vaultPda = (order: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), order.toBuffer()],
      program.programId
    )[0];

  const balance = async (ata: PublicKey) => Number((await getAccount(connection, ata)).amount);

  async function airdrop(to: PublicKey) {
    const sig = await connection.requestAirdrop(to, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function expectFail(p: Promise<unknown>, label: string) {
    try {
      await p;
    } catch {
      return;
    }
    assert.fail(`expected failure: ${label}`);
  }

  async function createOrder(amount = 25, shipWindow = 3600, protection = 3600) {
    const id = randomBytes(32);
    const order = orderPda(id);
    const vault = vaultPda(order);
    await program.methods
      .createOrder(Array.from(id), USDC(amount), new BN(shipWindow), new BN(protection))
      .accounts({
        buyer: buyer.publicKey,
        rentPayer: rentPayer.publicKey,
        merchant: merchant.publicKey,
        mint,
        buyerToken,
        order,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer, rentPayer])
      .rpc();
    return { id, order, vault };
  }

  const settleAccounts = (order: PublicKey, vault: PublicKey, caller: Keypair, dest: PublicKey) => ({
    caller: caller.publicKey,
    order,
    mint,
    vault,
    destinationToken: dest,
    rentPayer: rentPayer.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  });

  before(async () => {
    for (const k of [buyer, merchant, rentPayer, stranger]) await airdrop(k.publicKey);
    mint = await createMint(connection, payer, payer.publicKey, null, 6);
    buyerToken = await createAccount(connection, payer, mint, buyer.publicKey);
    merchantToken = await createAccount(connection, payer, mint, merchant.publicKey);
    await mintTo(connection, payer, mint, buyerToken, payer, 1_000_000_000);
  });

  it("happy path: create -> ship -> buyer confirms -> merchant paid", async () => {
    const buyerBefore = await balance(buyerToken);
    const { order, vault } = await createOrder(25);

    assert.equal(await balance(vault), 25_000_000);
    assert.equal(await balance(buyerToken), buyerBefore - 25_000_000);

    await program.methods
      .markShipped()
      .accounts({ merchant: merchant.publicKey, order })
      .signers([merchant])
      .rpc();

    const merchantBefore = await balance(merchantToken);
    await program.methods
      .confirmReceipt()
      .accounts(settleAccounts(order, vault, buyer, merchantToken))
      .signers([buyer])
      .rpc();

    assert.equal(await balance(merchantToken), merchantBefore + 25_000_000);
    assert.isNull(await connection.getAccountInfo(vault), "vault should be closed");
    const data = await program.account.order.fetch(order);
    assert.isTrue("released" in data.status);
  });

  it("buyer cannot confirm before the merchant ships", async () => {
    const { order, vault } = await createOrder(5);
    await expectFail(
      program.methods
        .confirmReceipt()
        .accounts(settleAccounts(order, vault, buyer, merchantToken))
        .signers([buyer])
        .rpc(),
      "confirm before shipped"
    );
  });

  it("a stranger cannot mark shipped or confirm", async () => {
    const { order, vault } = await createOrder(5);
    await expectFail(
      program.methods
        .markShipped()
        .accounts({ merchant: stranger.publicKey, order })
        .signers([stranger])
        .rpc(),
      "stranger marks shipped"
    );
    await program.methods
      .markShipped()
      .accounts({ merchant: merchant.publicKey, order })
      .signers([merchant])
      .rpc();
    await expectFail(
      program.methods
        .confirmReceipt()
        .accounts(settleAccounts(order, vault, stranger, merchantToken))
        .signers([stranger])
        .rpc(),
      "stranger confirms"
    );
  });

  it("funds cannot be redirected to a wrong destination", async () => {
    const { order, vault } = await createOrder(5);
    await program.methods
      .markShipped()
      .accounts({ merchant: merchant.publicKey, order })
      .signers([merchant])
      .rpc();
    // buyer tries to "confirm" but send the money back to their own account
    await expectFail(
      program.methods
        .confirmReceipt()
        .accounts(settleAccounts(order, vault, buyer, buyerToken))
        .signers([buyer])
        .rpc(),
      "wrong destination"
    );
  });

  it("merchant can refund (cancel) an order", async () => {
    const { order, vault } = await createOrder(10);
    const before = await balance(buyerToken);
    await program.methods
      .refund()
      .accounts(settleAccounts(order, vault, merchant, buyerToken))
      .signers([merchant])
      .rpc();
    assert.equal(await balance(buyerToken), before + 10_000_000);
    const data = await program.account.order.fetch(order);
    assert.isTrue("refunded" in data.status);
  });

  it("buyer can reclaim only after the ship window passes", async () => {
    const { order, vault } = await createOrder(10, 2, 3600);
    await expectFail(
      program.methods
        .refund()
        .accounts(settleAccounts(order, vault, buyer, buyerToken))
        .signers([buyer])
        .rpc(),
      "buyer refund too early"
    );
    await sleep(3500);
    const before = await balance(buyerToken);
    await program.methods
      .refund()
      .accounts(settleAccounts(order, vault, buyer, buyerToken))
      .signers([buyer])
      .rpc();
    assert.equal(await balance(buyerToken), before + 10_000_000);
  });

  it("merchant can claim only after the protection window passes", async () => {
    const { order, vault } = await createOrder(10, 3600, 2);
    await program.methods
      .markShipped()
      .accounts({ merchant: merchant.publicKey, order })
      .signers([merchant])
      .rpc();
    await expectFail(
      program.methods
        .claim()
        .accounts(settleAccounts(order, vault, stranger, merchantToken))
        .signers([stranger])
        .rpc(),
      "claim too early"
    );
    await sleep(3500);
    const before = await balance(merchantToken);
    // anyone may trigger it; funds can only go to the merchant
    await program.methods
      .claim()
      .accounts(settleAccounts(order, vault, stranger, merchantToken))
      .signers([stranger])
      .rpc();
    assert.equal(await balance(merchantToken), before + 10_000_000);
  });

  it("buyer can be fee payer and rent_payer with a single signature (Blink flow)", async () => {
    const id = randomBytes(32);
    const order = orderPda(id);
    const vault = vaultPda(order);
    const tx = await program.methods
      .createOrder(Array.from(id), USDC(4), new BN(3600), new BN(3600))
      .accounts({
        buyer: buyer.publicKey,
        rentPayer: buyer.publicKey,
        merchant: merchant.publicKey,
        mint,
        buyerToken,
        order,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    tx.feePayer = buyer.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(buyer);
    assert.equal(tx.signatures.length, 1, "buyer is the only signer");

    const usdcBefore = await balance(buyerToken);
    const solBefore = await connection.getBalance(buyer.publicKey);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");

    const vaultRent = (await connection.getAccountInfo(vault))!.lamports;
    const orderRent = (await connection.getAccountInfo(order))!.lamports;
    assert.equal(await balance(vault), 4_000_000);
    assert.equal(await balance(buyerToken), usdcBefore - 4_000_000);
    const created = await program.account.order.fetch(order);
    assert.isTrue(created.rentPayer.equals(buyer.publicKey));
    assert.isTrue(created.buyer.equals(buyer.publicKey));
    assert.isTrue("funded" in created.status);
    // buyer paid the fee plus rent for both accounts
    const solAfterCreate = await connection.getBalance(buyer.publicKey);
    assert.isAtLeast(solBefore - solAfterCreate, vaultRent + orderRent);

    // settlement closes the vault and returns its rent to the buyer (= rent_payer)
    await program.methods
      .refund()
      .accounts({
        ...settleAccounts(order, vault, merchant, buyerToken),
        rentPayer: buyer.publicKey,
      })
      .signers([merchant])
      .rpc();
    assert.isNull(await connection.getAccountInfo(vault), "vault should be closed");
    assert.equal(await balance(buyerToken), usdcBefore);
    assert.equal(
      await connection.getBalance(buyer.publicKey),
      solAfterCreate + vaultRent
    );
  });

  it("rejects zero amount and an out-of-range window", async () => {
    const id = randomBytes(32);
    const order = orderPda(id);
    const base = {
      buyer: buyer.publicKey,
      rentPayer: rentPayer.publicKey,
      merchant: merchant.publicKey,
      mint,
      buyerToken,
      order,
      vault: vaultPda(order),
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    await expectFail(
      program.methods
        .createOrder(Array.from(id), new BN(0), new BN(3600), new BN(3600))
        .accounts(base)
        .signers([buyer, rentPayer])
        .rpc(),
      "zero amount"
    );
    await expectFail(
      program.methods
        .createOrder(Array.from(id), USDC(1), new BN(0), new BN(3600))
        .accounts(base)
        .signers([buyer, rentPayer])
        .rpc(),
      "zero window"
    );
  });
});
