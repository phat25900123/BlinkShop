import { createHash } from "node:crypto";

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeCreateOrderData } from "../lib/backend/escrow";
import {
  createBuyerFundedEscrowOrderTransaction,
  createSponsoredEscrowOrderTransaction,
  SponsoredCheckoutError,
  type SponsoredCheckoutDependencies,
} from "../lib/backend/sponsored-checkout";

const escrowProgramId = new PublicKey("3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw");
const orderPda = (merchantKey: PublicKey, orderId: string) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("order"),
      merchantKey.toBuffer(),
      createHash("sha256").update(orderId).digest(),
    ],
    escrowProgramId,
  )[0];
const vaultPda = (order: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), order.toBuffer()],
    escrowProgramId,
  )[0];

const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const buyer = Keypair.generate().publicKey;
const merchant = Keypair.generate().publicKey;
const merchantB = Keypair.generate().publicKey;
const sponsor = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

describe("sponsored Privy transaction construction", () => {
  beforeEach(() => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("MERCHANT_WALLET", merchant.toBase58());
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    vi.stubEnv("ESCROW_PROGRAM_ID", escrowProgramId.toBase58());
    vi.stubEnv("SHIP_WINDOW_SECONDS", "");
    vi.stubEnv("PROTECTION_WINDOW_SECONDS", "");
    vi.stubEnv(
      "SOLANA_SPONSOR_SECRET_KEY_BASE64",
      Buffer.from(sponsor.secretKey).toString("base64"),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function dependencies(
    accounts: "both" | "buyer-only" | "none",
    selectedMerchant = merchant,
  ): Promise<SponsoredCheckoutDependencies> {
    const buyerAta = await getAssociatedTokenAddress(mint, buyer);
    const merchantAta = await getAssociatedTokenAddress(mint, selectedMerchant);

    return {
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 100,
      }),
      loadTokenAccount: async (address) => {
        if (accounts !== "none" && address.equals(buyerAta)) {
          return { mint, owner: buyer };
        }
        if (accounts === "both" && address.equals(merchantAta)) {
          return { mint, owner: selectedMerchant };
        }
        return null;
      },
    };
  }

  // Previously this asserted one SPL TransferChecked straight to the merchant.
  // Checkout now funds the on-chain escrow, so the single allowed instruction
  // is the escrow program's create_order.
  it("builds exactly one escrow create_order with no ATA, close or transfer instruction", async () => {
    const result = await createSponsoredEscrowOrderTransaction(
      "order-1",
      buyer.toBase58(),
      merchant.toBase58(),
      0.6,
      await dependencies("both"),
    );
    const transaction = Transaction.from(
      Buffer.from(result.serializedTransaction, "base64"),
    );

    expect(transaction.instructions).toHaveLength(1);
    const instruction = transaction.instructions[0];
    expect(instruction.programId.equals(escrowProgramId)).toBe(true);
    for (const other of [
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID,
      SystemProgram.programId,
      ComputeBudgetProgram.programId,
    ]) {
      expect(instruction.programId.equals(other)).toBe(false);
    }

    const order = orderPda(merchant, "order-1");
    const vault = vaultPda(order);
    const buyerAta = await getAssociatedTokenAddress(mint, buyer);
    expect(
      instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]),
    ).toEqual([
      [buyer.toBase58(), true, true],
      [sponsor.publicKey.toBase58(), true, true],
      [merchant.toBase58(), false, false],
      [mint.toBase58(), false, false],
      [buyerAta.toBase58(), false, true],
      [order.toBase58(), false, true],
      [vault.toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ]);

    const args = decodeCreateOrderData(instruction.data);
    expect(args).not.toBeNull();
    expect(args!.orderId.equals(createHash("sha256").update("order-1").digest())).toBe(true);
    expect(args!.amount).toBe(BigInt(600_000));
    expect(args!.shipWindowSeconds).toBe(BigInt(604_800));
    expect(args!.protectionWindowSeconds).toBe(BigInt(259_200));

    expect(transaction.feePayer?.toBase58()).toBe(sponsor.publicKey.toBase58());
    expect(transaction.signatures.map((entry) => entry.publicKey.toBase58())).toEqual([
      sponsor.publicKey.toBase58(),
      buyer.toBase58(),
    ]);
    expect(transaction.signatures.every((entry) => entry.signature === null)).toBe(true);
    expect(result.sponsorWallet).toBe(sponsor.publicKey.toBase58());
    expect(result.messageHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.merchantWallet).toBe(merchant.toBase58());
    expect(result.usdcMint).toBe(mint.toBase58());
    expect(result.escrowProgramId).toBe(escrowProgramId.toBase58());
    expect(result.escrowOrderAccount).toBe(order.toBase58());
    expect(result.escrowVaultAccount).toBe(vault.toBase58());
  });

  it("uses the configured ship and protection windows", async () => {
    vi.stubEnv("SHIP_WINDOW_SECONDS", "120");
    vi.stubEnv("PROTECTION_WINDOW_SECONDS", "60");
    const result = await createSponsoredEscrowOrderTransaction(
      "order-1",
      buyer.toBase58(),
      merchant.toBase58(),
      0.3,
      await dependencies("both"),
    );
    const args = decodeCreateOrderData(
      Transaction.from(Buffer.from(result.serializedTransaction, "base64"))
        .instructions[0].data,
    );

    expect(args!.shipWindowSeconds).toBe(BigInt(120));
    expect(args!.protectionWindowSeconds).toBe(BigInt(60));
  });

  it("gives each BlinkShop order its own escrow account", async () => {
    const deps = await dependencies("both");
    const first = await createSponsoredEscrowOrderTransaction(
      "order-1", buyer.toBase58(), merchant.toBase58(), 0.3, deps,
    );
    const second = await createSponsoredEscrowOrderTransaction(
      "order-2", buyer.toBase58(), merchant.toBase58(), 0.3, deps,
    );

    expect(first.escrowOrderAccount).not.toBe(second.escrowOrderAccount);
    expect(first.escrowVaultAccount).not.toBe(second.escrowVaultAccount);
  });

  it("fails closed when the escrow program id is not configured", async () => {
    vi.stubEnv("ESCROW_PROGRAM_ID", "");
    await expect(
      createSponsoredEscrowOrderTransaction(
        "order-1",
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("both"),
      ),
    ).rejects.toMatchObject({ code: "escrow_program_missing" });
  });

  it("returns a controlled error when the buyer USDC ATA is missing", async () => {
    await expect(
      createSponsoredEscrowOrderTransaction(
        "order-1",
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("none"),
      ),
    ).rejects.toMatchObject({
      code: "buyer_usdc_account_missing",
    } satisfies Partial<SponsoredCheckoutError>);
  });

  it("returns a controlled configuration error when the merchant USDC ATA is missing", async () => {
    await expect(
      createSponsoredEscrowOrderTransaction(
        "order-1",
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("buyer-only"),
      ),
    ).rejects.toMatchObject({
      code: "merchant_usdc_account_missing",
    } satisfies Partial<SponsoredCheckoutError>);
  });

  it("routes merchant B checkout to merchant B even when the legacy global points to A", async () => {
    vi.stubEnv("MERCHANT_WALLET", merchant.toBase58());
    const result = await createSponsoredEscrowOrderTransaction(
      "order-1",
      buyer.toBase58(),
      merchantB.toBase58(),
      0.3,
      await dependencies("both", merchantB),
    );
    const transaction = Transaction.from(
      Buffer.from(result.serializedTransaction, "base64"),
    );
    const instruction = transaction.instructions[0];

    expect(result.merchantWallet).toBe(merchantB.toBase58());
    // The escrow records merchant B and the order PDA is seeded by merchant B.
    expect(instruction.keys[2].pubkey.equals(merchantB)).toBe(true);
    expect(instruction.keys[5].pubkey.equals(orderPda(merchantB, "order-1"))).toBe(true);
    expect(result.merchantTokenAccount).toBe(
      (await getAssociatedTokenAddress(mint, merchantB)).toBase58(),
    );
  });

  it("builds a buyer-funded Blink create_order: buyer is fee payer, rent_payer and sole signer", async () => {
    const result = await createBuyerFundedEscrowOrderTransaction(
      "order-1",
      buyer.toBase58(),
      merchant.toBase58(),
      0.6,
      await dependencies("both"),
    );
    const transaction = Transaction.from(
      Buffer.from(result.serializedTransaction, "base64"),
    );

    expect(transaction.instructions).toHaveLength(1);
    const instruction = transaction.instructions[0];
    expect(instruction.programId.equals(escrowProgramId)).toBe(true);
    expect(instruction.keys[0].pubkey.equals(buyer)).toBe(true);
    expect(instruction.keys[1].pubkey.equals(buyer)).toBe(true);
    expect(instruction.keys.some((key) => key.pubkey.equals(sponsor.publicKey))).toBe(false);
    expect(transaction.feePayer?.equals(buyer)).toBe(true);
    expect(transaction.signatures.map((entry) => entry.publicKey.toBase58())).toEqual([
      buyer.toBase58(),
    ]);
    expect(decodeCreateOrderData(instruction.data)?.amount).toBe(BigInt(600_000));
    expect(result.escrowOrderAccount).toBe(orderPda(merchant, "order-1").toBase58());
    expect(result.blockhash).toBe("11111111111111111111111111111111");
    expect(result).not.toHaveProperty("sponsorWallet");
  });

  it("does not add ATA creation to the Blink transaction when an ATA is missing", async () => {
    await expect(
      createBuyerFundedEscrowOrderTransaction(
        "order-1",
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("buyer-only"),
      ),
    ).rejects.toMatchObject({ code: "merchant_usdc_account_missing" });
    await expect(
      createBuyerFundedEscrowOrderTransaction(
        "order-1",
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("none"),
      ),
    ).rejects.toMatchObject({ code: "buyer_usdc_account_missing" });
  });

  it("rejects a missing product-owned merchant payout wallet", async () => {
    await expect(
      createSponsoredEscrowOrderTransaction(
        "order-1",
        buyer.toBase58(),
        "",
        0.3,
        await dependencies("both"),
      ),
    ).rejects.toMatchObject({ code: "configuration_missing" });
  });
});
