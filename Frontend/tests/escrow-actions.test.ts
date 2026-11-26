import { createHash } from "node:crypto";

import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  prepareEscrowAction,
  submitEscrowAction,
  syncEscrowOrderStatus,
  type EscrowActor,
  type EscrowSubmitDependencies,
} from "../lib/backend/escrow-actions";
import { store } from "../lib/backend/store";
import { state } from "../lib/backend/store-state";
import type { Order } from "../lib/backend/types";
import { addProduct, resetStore } from "./helpers/store-fixtures";

const keypair = (offset: number) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + offset) % 256));

const programId = new PublicKey("3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw");
const sponsor = keypair(1);
const merchant = keypair(21);
const buyer = keypair(41);
const attacker = keypair(61);
const mint = keypair(81).publicKey;

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const disc = (name: string) => sha256(`global:${name}`).subarray(0, 8);
const ORDER_ID = "order-11111111-2222-3333-4444-555555555555";
const ORDER_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("order"), merchant.publicKey.toBuffer(), sha256(ORDER_ID)],
  programId,
)[0];
const VAULT_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("vault"), ORDER_PDA.toBuffer()],
  programId,
)[0];
const MERCHANT_ATA = getAssociatedTokenAddressSync(mint, merchant.publicKey);
const BUYER_ATA = getAssociatedTokenAddressSync(mint, buyer.publicKey);

const NOW_SECONDS = 1_800_000_000;
const STATUS = { funded: 0, shipped: 1, released: 2, refunded: 3 } as const;

type Chain = {
  status: keyof typeof STATUS;
  rentPayer: PublicKey;
  shipBy: number;
  releaseAfter: number;
  owner: PublicKey;
  orderExists: boolean;
  vault: { mint: PublicKey; owner: PublicKey; amount: bigint } | null;
  tokenAccounts: Map<string, { mint: PublicKey; owner: PublicKey; amount: bigint }>;
};

// Independent borsh layout of `pub struct Order` from lib.rs.
function orderAccountData(chain: Chain) {
  const data = Buffer.alloc(210);
  sha256("account:Order").subarray(0, 8).copy(data, 0);
  sha256(ORDER_ID).copy(data, 8);
  merchant.publicKey.toBuffer().copy(data, 40);
  buyer.publicKey.toBuffer().copy(data, 72);
  chain.rentPayer.toBuffer().copy(data, 104);
  mint.toBuffer().copy(data, 136);
  data.writeBigUInt64LE(BigInt(600_000), 168);
  data[176] = STATUS[chain.status];
  data.writeBigInt64LE(BigInt(NOW_SECONDS - 100), 177);
  data.writeBigInt64LE(BigInt(chain.shipBy), 185);
  data.writeBigInt64LE(BigInt(259_200), 193);
  data.writeBigInt64LE(BigInt(chain.releaseAfter), 201);
  data[209] = 255;
  return data;
}

let chain: Chain;

function freshChain(overrides: Partial<Chain> = {}): Chain {
  const holds = !overrides.status || ["funded", "shipped"].includes(overrides.status);
  return {
    status: "funded",
    rentPayer: sponsor.publicKey,
    shipBy: NOW_SECONDS + 3600,
    releaseAfter: 0,
    owner: programId,
    orderExists: true,
    vault: holds ? { mint, owner: ORDER_PDA, amount: BigInt(600_000) } : null,
    tokenAccounts: new Map([
      [MERCHANT_ATA.toBase58(), { mint, owner: merchant.publicKey, amount: BigInt(0) }],
      [BUYER_ATA.toBase58(), { mint, owner: buyer.publicKey, amount: BigInt(0) }],
    ]),
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<EscrowSubmitDependencies> = {},
): EscrowSubmitDependencies {
  return {
    getAccountInfo: vi.fn(async (address: PublicKey) =>
      address.equals(ORDER_PDA) && chain.orderExists
        ? { owner: chain.owner, data: orderAccountData(chain) }
        : null,
    ),
    loadTokenAccount: vi.fn(async (address: PublicKey) =>
      address.equals(VAULT_PDA)
        ? chain.vault
        : chain.tokenAccounts.get(address.toBase58()) ?? null,
    ),
    getLatestBlockhash: vi.fn(async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100,
    })),
    now: () => NOW_SECONDS * 1000,
    getSponsorKeypair: () => sponsor,
    isBlockhashValid: vi.fn(async () => true),
    getFeeForMessage: vi.fn(async () => 10_000),
    getSponsorBalance: vi.fn(async () => 1_000_000_000),
    getCurrentOrder: (id: string) => store.getOrder(id),
    signWithSponsor: vi.fn((transaction: Transaction, signer: Keypair) =>
      transaction.partialSign(signer),
    ),
    sendRawTransaction: vi.fn(async () => "lifecycle-signature"),
    ...overrides,
  };
}

function seedOrder(overrides: Partial<Order> = {}) {
  const product = store.getProduct("product-1") ?? addProduct({
    merchantId: "did:privy:merchant",
    merchantWallet: merchant.publicKey.toBase58(),
  });
  const timestamp = new Date().toISOString();
  const order: Order = {
    id: ORDER_ID,
    productId: product.id,
    merchantId: "did:privy:merchant",
    merchantWallet: merchant.publicKey.toBase58(),
    buyerWallet: buyer.publicKey.toBase58(),
    quantity: 2,
    amountUsdc: 0.6,
    status: "paid",
    inventoryReserved: false,
    settlement: "escrow",
    sponsored: true,
    txSignature: "funding-signature",
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    ...overrides,
  };
  state.orders.set(order.id, order);
  return order;
}

const merchantActor: EscrowActor = { role: "merchant", wallet: merchant.publicKey.toBase58() };
const buyerActor: EscrowActor = { role: "buyer", wallet: buyer.publicKey.toBase58() };

const decode = (serialized: string) =>
  Transaction.from(Buffer.from(serialized, "base64"));

const keyFlags = (instruction: TransactionInstruction) =>
  instruction.keys.map((key) => [key.pubkey.toBase58(), key.isSigner, key.isWritable]);

async function prepareAndSign(
  action: Parameters<typeof prepareEscrowAction>[0]["action"],
  actor: EscrowActor,
  signer: Keypair,
  deps = dependencies(),
) {
  const prepared = await prepareEscrowAction(
    { order: store.getOrder(ORDER_ID)!, action, actor },
    deps,
  );
  const transaction = decode(prepared.transaction);
  transaction.partialSign(signer);
  return {
    prepared,
    transaction,
    signed: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
  };
}

describe("escrow order lifecycle", () => {
  beforeEach(() => {
    resetStore();
    chain = freshChain();
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    vi.stubEnv("SOLANA_SPONSOR_SECRET_KEY_BASE64", Buffer.from(sponsor.secretKey).toString("base64"));
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("ESCROW_PROGRAM_ID", programId.toBase58());
    vi.stubEnv("SPONSOR_MIN_BALANCE_LAMPORTS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("prepare", () => {
    it("builds exactly one mark_shipped signed by the merchant with the sponsor as fee payer", async () => {
      seedOrder();
      const prepared = await prepareEscrowAction(
        { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor },
        dependencies(),
      );
      const transaction = decode(prepared.transaction);

      expect(transaction.feePayer?.equals(sponsor.publicKey)).toBe(true);
      expect(transaction.instructions).toHaveLength(1);
      const [instruction] = transaction.instructions;
      expect(instruction.programId.equals(programId)).toBe(true);
      expect(Buffer.from(instruction.data).equals(disc("mark_shipped"))).toBe(true);
      expect(keyFlags(instruction)).toEqual([
        [merchant.publicKey.toBase58(), true, false],
        [ORDER_PDA.toBase58(), false, true],
      ]);
      expect(transaction.signatures.map((entry) => entry.publicKey.toBase58())).toEqual([
        sponsor.publicKey.toBase58(),
        merchant.publicKey.toBase58(),
      ]);
      expect(store.getOrder(ORDER_ID)?.escrowAction).toMatchObject({
        action: "ship",
        signer: merchant.publicKey.toBase58(),
      });
      expect(prepared.escrowOrderAccount).toBe(ORDER_PDA.toBase58());
      // Preparing changes nothing about the order status.
      expect(store.getOrder(ORDER_ID)?.status).toBe("paid");
    });

    it("pays confirm_receipt only into the merchant ATA and returns vault rent to the recorded rent payer", async () => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped" });
      const prepared = await prepareEscrowAction(
        { order: store.getOrder(ORDER_ID)!, action: "confirm-receipt", actor: buyerActor },
        dependencies(),
      );
      const [instruction] = decode(prepared.transaction).instructions;

      expect(Buffer.from(instruction.data).equals(disc("confirm_receipt"))).toBe(true);
      // Sponsor is fee payer and rent payer, so it is a writable signer at message level.
      expect(keyFlags(instruction)).toEqual([
        [buyer.publicKey.toBase58(), true, false],
        [ORDER_PDA.toBase58(), false, true],
        [mint.toBase58(), false, false],
        [VAULT_PDA.toBase58(), false, true],
        [MERCHANT_ATA.toBase58(), false, true],
        [sponsor.publicKey.toBase58(), true, true],
        [TOKEN_PROGRAM_ID.toBase58(), false, false],
      ]);
    });

    it("refunds only into the buyer ATA and uses a buyer rent payer for Blink orders", async () => {
      seedOrder({ sponsored: false });
      chain = freshChain({ rentPayer: buyer.publicKey });
      const prepared = await prepareEscrowAction(
        { order: store.getOrder(ORDER_ID)!, action: "refund", actor: merchantActor },
        dependencies(),
      );
      const [instruction] = decode(prepared.transaction).instructions;

      expect(Buffer.from(instruction.data).equals(disc("refund"))).toBe(true);
      expect(instruction.keys[4].pubkey.equals(BUYER_ATA)).toBe(true);
      expect(instruction.keys[5].pubkey.equals(buyer.publicKey)).toBe(true);
    });

    it.each([
      ["a buyer shipping", "ship", buyerActor, {}, "actor_not_allowed"],
      ["a merchant confirming receipt", "confirm-receipt", merchantActor, { status: "shipped" }, "actor_not_allowed"],
      ["a buyer claiming", "claim", buyerActor, { status: "shipped" }, "actor_not_allowed"],
      ["a wrong merchant wallet", "ship", { role: "merchant", wallet: attacker.publicKey.toBase58() }, {}, "actor_wallet_mismatch"],
      ["a direct (legacy) order", "ship", merchantActor, { settlement: "direct" }, "order_not_escrow"],
      ["shipping an already shipped order", "ship", merchantActor, { status: "shipped" }, "order_status_invalid"],
      ["confirming an unshipped order", "confirm-receipt", buyerActor, {}, "order_status_invalid"],
      ["acting on a released order", "refund", merchantActor, { status: "released" }, "order_status_invalid"],
      ["acting on a pending order", "ship", merchantActor, { status: "pending" }, "order_status_invalid"],
    ] as const)("rejects %s", async (_label, action, actor, override, code) => {
      seedOrder(override as Partial<Order>);
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action, actor: actor as EscrowActor },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code });
      expect(store.getOrder(ORDER_ID)?.escrowAction).toBeUndefined();
    });

    it.each([
      ["missing", { orderExists: false }, "escrow_account_missing"],
      ["owned by another program", { owner: attacker.publicKey }, "escrow_account_invalid"],
      ["with an emptied vault", { vault: { mint, owner: ORDER_PDA, amount: BigInt(1) } }, "escrow_account_invalid"],
      ["already shipped on-chain", { status: "shipped" as const }, "escrow_state_mismatch"],
    ])("rejects shipping when the escrow account is %s", async (_label, override, code) => {
      seedOrder();
      chain = freshChain(override as Partial<Chain>);
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code });
    });

    it("lets a buyer reclaim only after the ship window, and only while unshipped", async () => {
      seedOrder();
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "refund", actor: buyerActor },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code: "window_not_elapsed" });

      chain = freshChain({ shipBy: NOW_SECONDS - 1 });
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "refund", actor: buyerActor },
          dependencies(),
        ),
      ).resolves.toMatchObject({ action: "refund" });

      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped", shipBy: NOW_SECONDS - 1 });
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "refund", actor: buyerActor },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code: "escrow_state_mismatch" });
    });

    it("lets the merchant claim only after the protection window", async () => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped", releaseAfter: NOW_SECONDS + 1 });
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "claim", actor: merchantActor },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code: "window_not_elapsed" });

      chain = freshChain({ status: "shipped", releaseAfter: NOW_SECONDS });
      const prepared = await prepareEscrowAction(
        { order: store.getOrder(ORDER_ID)!, action: "claim", actor: merchantActor },
        dependencies(),
      );
      const [instruction] = decode(prepared.transaction).instructions;
      expect(Buffer.from(instruction.data).equals(disc("claim"))).toBe(true);
      expect(instruction.keys[4].pubkey.equals(MERCHANT_ATA)).toBe(true);
    });

    it("refuses to pay into a missing destination token account", async () => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped" });
      chain.tokenAccounts.delete(MERCHANT_ATA.toBase58());
      await expect(
        prepareEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "confirm-receipt", actor: buyerActor },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code: "destination_token_missing" });
    });
  });

  describe("submit", () => {
    it("co-signs the prepared transaction last and leaves the store status to the sync", async () => {
      seedOrder();
      const deps = dependencies();
      const { signed } = await prepareAndSign("ship", merchantActor, merchant, deps);

      const result = await submitEscrowAction(
        { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor, signedTransaction: signed },
        deps,
      );

      expect(result.txSignature).toBe("lifecycle-signature");
      const sent = Transaction.from(Buffer.from(vi.mocked(deps.sendRawTransaction).mock.calls[0][0]));
      expect(sent.verifySignatures(true)).toBe(true);
      expect(store.getOrder(ORDER_ID)).toMatchObject({
        status: "paid",
        escrowActionSignature: "lifecycle-signature",
      });
    });

    it("co-signs a settle instruction where the sponsor is also the rent payer", async () => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped" });
      const deps = dependencies();
      const { signed } = await prepareAndSign("confirm-receipt", buyerActor, buyer, deps);

      await expect(
        submitEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "confirm-receipt", actor: buyerActor, signedTransaction: signed },
          deps,
        ),
      ).resolves.toMatchObject({ txSignature: "lifecycle-signature" });
    });

    it("rejects submission without a prepared action", async () => {
      seedOrder();
      await expect(
        submitEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor, signedTransaction: "AA==" },
          dependencies(),
        ),
      ).rejects.toMatchObject({ code: "action_not_prepared" });
    });

    it("rejects a transaction prepared for a different action", async () => {
      seedOrder();
      chain = freshChain();
      const deps = dependencies();
      const { signed } = await prepareAndSign("refund", merchantActor, merchant, deps);
      await expect(
        submitEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor, signedTransaction: signed },
          deps,
        ),
      ).rejects.toMatchObject({ code: "action_not_prepared" });
    });

    async function signedCustom(instructions: TransactionInstruction[], signer = merchant) {
      const transaction = new Transaction({
        feePayer: sponsor.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
      }).add(...instructions);
      transaction.partialSign(signer);
      return transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64");
    }

    function settle(action: string, destination: PublicKey, rentPayer = sponsor.publicKey, caller = buyer.publicKey) {
      return {
        programId,
        keys: [
          { pubkey: caller, isSigner: true, isWritable: false },
          { pubkey: ORDER_PDA, isSigner: false, isWritable: true },
          { pubkey: mint, isSigner: false, isWritable: false },
          { pubkey: VAULT_PDA, isSigner: false, isWritable: true },
          { pubkey: destination, isSigner: false, isWritable: true },
          { pubkey: rentPayer, isSigner: false, isWritable: true },
          { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        ],
        data: disc(action),
      } as unknown as TransactionInstruction;
    }

    it.each([
      ["a refund to the buyer instead of the merchant", () => settle("confirm_receipt", BUYER_ATA), "payment_mismatch"],
      ["an attacker destination", () => settle("confirm_receipt", getAssociatedTokenAddressSync(mint, attacker.publicKey)), "payment_mismatch"],
      ["vault rent redirected to an attacker", () => settle("confirm_receipt", MERCHANT_ATA, attacker.publicKey), "payment_mismatch"],
      ["a different instruction (claim)", () => settle("claim", MERCHANT_ATA), "payment_mismatch"],
    ])("rejects %s before the sponsor signs", async (_label, build, code) => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped" });
      const deps = dependencies();
      await prepareAndSign("confirm-receipt", buyerActor, buyer, deps);
      await expect(
        submitEscrowAction(
          {
            order: store.getOrder(ORDER_ID)!,
            action: "confirm-receipt",
            actor: buyerActor,
            signedTransaction: await signedCustom([build()], buyer),
          },
          deps,
        ),
      ).rejects.toMatchObject({ code });
      expect(deps.signWithSponsor).not.toHaveBeenCalled();
    });

    it("rejects an extra instruction or a different program", async () => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "shipped" });
      const deps = dependencies();
      await prepareAndSign("confirm-receipt", buyerActor, buyer, deps);
      // An appended instruction draining the sponsor, and a lone non-escrow
      // instruction; the buyer is a valid signer in both.
      const drainSponsor = SystemProgram.transfer({
        fromPubkey: sponsor.publicKey,
        toPubkey: attacker.publicKey,
        lamports: 1_000_000,
      });
      const buyerTransfer = SystemProgram.transfer({
        fromPubkey: buyer.publicKey,
        toPubkey: attacker.publicKey,
        lamports: 1,
      });
      for (const instructions of [
        [settle("confirm_receipt", MERCHANT_ATA), drainSponsor],
        [buyerTransfer],
      ]) {
        await expect(
          submitEscrowAction(
            {
              order: store.getOrder(ORDER_ID)!,
              action: "confirm-receipt",
              actor: buyerActor,
              signedTransaction: await signedCustom(instructions, buyer),
            },
            deps,
          ),
        ).rejects.toMatchObject({ code: "instruction_invalid" });
      }
      expect(deps.signWithSponsor).not.toHaveBeenCalled();
    });

    it("rejects an exact instruction that is not the bound message (re-prepared)", async () => {
      seedOrder();
      const deps = dependencies();
      const first = await prepareAndSign("ship", merchantActor, merchant, deps);
      vi.mocked(deps.getLatestBlockhash).mockResolvedValueOnce({
        blockhash: attacker.publicKey.toBase58(),
        lastValidBlockHeight: 200,
      });
      await prepareEscrowAction({ order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor }, deps);

      await expect(
        submitEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor, signedTransaction: first.signed },
          deps,
        ),
      ).rejects.toMatchObject({ code: "transaction_message_mismatch" });
      expect(deps.signWithSponsor).not.toHaveBeenCalled();
    });

    it("refuses to sign when the sponsor balance is too low", async () => {
      seedOrder();
      const deps = dependencies({ getSponsorBalance: vi.fn(async () => 1) });
      const { signed } = await prepareAndSign("ship", merchantActor, merchant, deps);
      await expect(
        submitEscrowAction(
          { order: store.getOrder(ORDER_ID)!, action: "ship", actor: merchantActor, signedTransaction: signed },
          deps,
        ),
      ).rejects.toMatchObject({ code: "sponsor_balance_low" });
      expect(deps.signWithSponsor).not.toHaveBeenCalled();
    });
  });

  describe("sync", () => {
    it.each([
      ["paid", "shipped", "shipped", "shippedAt"],
      ["shipped", "released", "released", "releasedAt"],
      ["paid", "refunded", "refunded", "refundedAt"],
      ["shipped", "refunded", "refunded", "refundedAt"],
      ["paid", "released", "released", "releasedAt"],
    ] as const)("moves a %s order to the on-chain %s state", async (from, onChain, expected, stamp) => {
      seedOrder({
        status: from,
        escrowAction: { action: "ship", signer: "x", messageHash: "h", preparedAt: "t" },
      });
      chain = freshChain({ status: onChain });

      const result = await syncEscrowOrderStatus(store.getOrder(ORDER_ID)!, dependencies());

      expect(result.result).toBe("updated");
      const order = store.getOrder(ORDER_ID)!;
      expect(order.status).toBe(expected);
      expect(order[stamp]).toBeTruthy();
      expect(order.escrowAction).toBeUndefined();
    });

    it("never moves backwards on a stale read", async () => {
      seedOrder({ status: "shipped" });
      chain = freshChain({ status: "funded" });
      const result = await syncEscrowOrderStatus(store.getOrder(ORDER_ID)!, dependencies());
      expect(result.result).toBe("invalid_transition");
      expect(store.getOrder(ORDER_ID)?.status).toBe("shipped");
    });

    it("does not touch the store when the on-chain account does not authenticate", async () => {
      seedOrder();
      chain = freshChain({ status: "released", vault: { mint, owner: ORDER_PDA, amount: BigInt(600_000) } });
      await expect(
        syncEscrowOrderStatus(store.getOrder(ORDER_ID)!, dependencies()),
      ).rejects.toMatchObject({ code: "escrow_account_invalid" });
      expect(store.getOrder(ORDER_ID)?.status).toBe("paid");
    });

    it("leaves terminal and non-escrow orders alone", async () => {
      seedOrder({ status: "released" });
      expect((await syncEscrowOrderStatus(store.getOrder(ORDER_ID)!, dependencies())).result).toBe("unchanged");

      seedOrder({ settlement: "direct" });
      await expect(
        syncEscrowOrderStatus(store.getOrder(ORDER_ID)!, dependencies()),
      ).rejects.toMatchObject({ code: "order_not_escrow" });
    });
  });

  it("never releases inventory for a shipped, released or refunded order", () => {
    for (const status of ["shipped", "released", "refunded"] as const) {
      resetStore();
      const product = addProduct({ inventory: 3 });
      seedOrder({ status, inventoryReserved: true, productId: product.id });
      store.markFailed(ORDER_ID);
      expect(store.getOrder(ORDER_ID)?.status).toBe(status);
      expect(store.getProduct(product.id)?.inventory).toBe(3);
    }
  });
});
