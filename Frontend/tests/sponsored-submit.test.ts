import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createEscrowOrderInstruction,
  escrowOrderId,
  findEscrowOrderAddress,
  findEscrowVaultAddress,
} from "../lib/backend/escrow";
import {
  getSponsoredTransactionMessageHash,
} from "../lib/backend/sponsored-checkout";
import {
  MAX_SPONSORED_FEE_LAMPORTS,
  submitSponsoredCheckoutTransaction,
  type SponsoredSubmissionDependencies,
} from "../lib/backend/sponsored-submit";
import type { Order, Product } from "../lib/backend/types";

const keypair = (offset: number) =>
  Keypair.fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => (index + offset) % 256),
  );

const sponsor = keypair(1);
const buyer = keypair(41);
const merchant = keypair(81);
const attacker = keypair(121);
const mint = keypair(161).publicKey;
const otherMint = keypair(201).publicKey;
const recentBlockhash = "11111111111111111111111111111111";
const escrowProgramId = new PublicKey("3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw");
const attackerProgramId = keypair(91).publicKey;

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    productId: "product-1",
    merchantId: "merchant-1",
    merchantWallet: merchant.publicKey.toBase58(),
    buyerWallet: buyer.publicKey.toBase58(),
    quantity: 2,
    amountUsdc: 0.6,
    status: "pending",
    settlement: "escrow",
    sponsored: true,
    inventoryReserved: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "product-1",
    merchantId: "merchant-1",
    merchantWallet: merchant.publicKey.toBase58(),
    name: "Test product",
    description: "Test product",
    priceUsdc: 0.3,
    imageUrl: "",
    inventory: 5,
    status: "active",
    variants: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

type EscrowOverrides = {
  programId?: PublicKey;
  buyer?: PublicKey;
  rentPayer?: PublicKey;
  merchant?: PublicKey;
  mint?: PublicKey;
  buyerToken?: PublicKey;
  order?: PublicKey;
  vault?: PublicKey;
  orderId?: string;
  amount?: bigint;
  shipWindowSeconds?: bigint;
  protectionWindowSeconds?: bigint;
};

// The escrow create_order the server expects for order(): order "order-1",
// 0.6 USDC, default 7-day ship and 3-day protection windows.
async function paymentInstruction(overrides: EscrowOverrides = {}) {
  const programId = overrides.programId ?? escrowProgramId;
  const merchantKey = overrides.merchant ?? merchant.publicKey;
  const id = escrowOrderId(overrides.orderId ?? "order-1");
  const orderAccount =
    overrides.order ?? findEscrowOrderAddress(escrowProgramId, merchantKey, id);
  return createEscrowOrderInstruction(
    programId,
    {
      buyer: overrides.buyer ?? buyer.publicKey,
      rentPayer: overrides.rentPayer ?? sponsor.publicKey,
      merchant: merchantKey,
      mint: overrides.mint ?? mint,
      buyerToken:
        overrides.buyerToken ??
        (await getAssociatedTokenAddress(mint, buyer.publicKey)),
      order: orderAccount,
      vault: overrides.vault ?? findEscrowVaultAddress(escrowProgramId, orderAccount),
    },
    {
      orderId: id,
      amount: overrides.amount ?? BigInt(600_000),
      shipWindowSeconds: overrides.shipWindowSeconds ?? BigInt(604_800),
      protectionWindowSeconds: overrides.protectionWindowSeconds ?? BigInt(259_200),
    },
  );
}

async function signedTransaction(options?: {
  feePayer?: PublicKey;
  instructions?: TransactionInstruction[];
  signer?: Keypair;
  includeSignature?: boolean;
  includeSponsorSignature?: boolean;
}) {
  const transaction = new Transaction({
    feePayer: options?.feePayer ?? sponsor.publicKey,
    recentBlockhash,
  });
  transaction.add(...(options?.instructions ?? [await paymentInstruction()]));
  if (options?.includeSignature !== false) {
    transaction.partialSign(options?.signer ?? buyer);
  }
  if (options?.includeSponsorSignature) transaction.partialSign(sponsor);
  return transaction;
}

function serialized(transaction: Transaction) {
  return transaction
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString("base64");
}

function dependencies(overrides: Partial<SponsoredSubmissionDependencies> = {}) {
  const defaults: SponsoredSubmissionDependencies = {
    getSponsorKeypair: () => sponsor,
    isBlockhashValid: vi.fn(async () => true),
    getFeeForMessage: vi.fn(async () => 10_000),
    getSponsorBalance: vi.fn(async () => 1_000_000_000),
    getCurrentOrder: vi.fn(() => order()),
    signWithSponsor: vi.fn((transaction, signer) =>
      transaction.partialSign(signer),
    ),
    sendRawTransaction: vi.fn(async () => "rpc-transaction-signature"),
  };
  return { ...defaults, ...overrides };
}

async function submit(
  transaction: Transaction,
  deps = dependencies(),
  checkoutOrder = order(),
  checkoutProduct = product(),
) {
  const boundOrder = {
    ...checkoutOrder,
    sponsoredTransactionHash:
      checkoutOrder.sponsoredTransactionHash ??
      getSponsoredTransactionMessageHash(await signedTransaction()),
  };
  deps.getCurrentOrder = vi.fn(() => boundOrder);
  return submitSponsoredCheckoutTransaction(
    {
      order: boundOrder,
      product: checkoutProduct,
      authenticatedBuyerWallet: buyer.publicKey.toBase58(),
      signedTransaction: serialized(transaction),
    },
    deps,
  );
}

describe("BlinkShop server-side sponsored submission", () => {
  beforeEach(() => {
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    vi.stubEnv(
      "SOLANA_SPONSOR_SECRET_KEY_BASE64",
      Buffer.from(sponsor.secretKey).toString("base64"),
    );
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("MERCHANT_WALLET", merchant.publicKey.toBase58());
    vi.stubEnv("ESCROW_PROGRAM_ID", escrowProgramId.toBase58());
    vi.stubEnv("SHIP_WINDOW_SECONDS", "");
    vi.stubEnv("PROTECTION_WINDOW_SECONDS", "");
    vi.stubEnv("MIN_ORDER_USDC", "");
    vi.stubEnv("SPONSOR_MIN_BALANCE_LAMPORTS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("adds the sponsor signature only after validation and broadcasts verified bytes", async () => {
    const deps = dependencies();
    const result = await submit(await signedTransaction(), deps);

    expect(result.txSignature).toBe("rpc-transaction-signature");
    expect(deps.signWithSponsor).toHaveBeenCalledOnce();
    expect(deps.sendRawTransaction).toHaveBeenCalledOnce();
    const sent = Transaction.from(
      Buffer.from(vi.mocked(deps.sendRawTransaction).mock.calls[0][0]),
    );
    expect(sent.verifySignatures(true)).toBe(true);
    expect(sent.feePayer?.toBase58()).toBe(sponsor.publicKey.toBase58());
    expect(sent.signatures.every((entry) => entry.signature !== null)).toBe(true);
  });

  it("returns the RPC signature and deterministically resends the same transaction", async () => {
    const transaction = await signedTransaction();
    const deps = dependencies();
    const first = await submit(transaction, deps);
    const second = await submit(transaction, deps);

    expect(first).toEqual(second);
    expect(deps.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(
      Buffer.from(vi.mocked(deps.sendRawTransaction).mock.calls[0][0]).equals(
        Buffer.from(vi.mocked(deps.sendRawTransaction).mock.calls[1][0]),
      ),
    ).toBe(true);
  });

  it("rejects another buyer's order before sponsor signing", async () => {
    const deps = dependencies();
    await expect(
      submit(
        await signedTransaction(),
        deps,
        order({ buyerWallet: attacker.publicKey.toBase58() }),
      ),
    ).rejects.toMatchObject({ code: "order_buyer_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it.each(["paid", "failed", "cancelled"] as const)(
    "rejects a %s order",
    async (status) => {
      const deps = dependencies();
      await expect(
        submit(await signedTransaction(), deps, order({ status })),
      ).rejects.toMatchObject({ code: "order_not_pending" });
      expect(deps.signWithSponsor).not.toHaveBeenCalled();
    },
  );

  it("rejects an expired pending order", async () => {
    await expect(
      submit(
        await signedTransaction(),
        dependencies(),
        order({ expiresAt: new Date(Date.now() - 1).toISOString() }),
      ),
    ).rejects.toMatchObject({ code: "order_expired" });
  });

  it("rejects a route product mismatch", async () => {
    await expect(
      submitSponsoredCheckoutTransaction(
        {
          order: order(),
          product: product({ id: "another-product" }),
          authenticatedBuyerWallet: buyer.publicKey.toBase58(),
          signedTransaction: serialized(await signedTransaction()),
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "order_product_mismatch" });
  });

  it.each([
    ["merchant DID", { merchantId: "did:privy:attacker" }],
    ["merchant wallet", { merchantWallet: attacker.publicKey.toBase58() }],
  ])("rejects an order with a mismatched %s before sponsor signing", async (_label, override) => {
    const deps = dependencies();
    await expect(
      submit(await signedTransaction(), deps, order(override)),
    ).rejects.toMatchObject({ code: "order_merchant_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rechecks the fresh order merchant snapshot before sponsor signing", async () => {
    const checkoutOrder = order();
    const deps = dependencies({
      getCurrentOrder: vi.fn(() =>
        order({ merchantWallet: attacker.publicKey.toBase58() }),
      ),
    });
    const transaction = await signedTransaction();
    const boundOrder = {
      ...checkoutOrder,
      sponsoredTransactionHash: getSponsoredTransactionMessageHash(transaction),
    };
    deps.getCurrentOrder = vi.fn(() => ({
      ...boundOrder,
      merchantWallet: attacker.publicKey.toBase58(),
    }));

    await expect(
      submitSponsoredCheckoutTransaction(
        {
          order: boundOrder,
          product: product(),
          authenticatedBuyerWallet: buyer.publicKey.toBase58(),
          signedTransaction: serialized(transaction),
        },
        deps,
      ),
    ).rejects.toMatchObject({ code: "order_merchant_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a tampered fee payer", async () => {
    await expect(
      submit(
        await signedTransaction({ feePayer: attacker.publicKey }),
      ),
    ).rejects.toMatchObject({ code: "fee_payer_mismatch" });
  });

  it("rejects a different blockhash than the server-prepared message", async () => {
    const deps = dependencies();
    const transaction = await signedTransaction();
    transaction.recentBlockhash = attacker.publicKey.toBase58();
    transaction.signatures.forEach((entry) => {
      entry.signature = null;
    });
    transaction.partialSign(buyer);

    await expect(submit(transaction, deps)).rejects.toMatchObject({
      code: "transaction_message_mismatch",
    });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a client-provided sponsor signature", async () => {
    await expect(
      submit(await signedTransaction({ includeSponsorSignature: true })),
    ).rejects.toMatchObject({ code: "sponsor_signature_present" });
  });

  it("rejects a missing buyer signature", async () => {
    await expect(
      submit(await signedTransaction({ includeSignature: false })),
    ).rejects.toMatchObject({ code: "buyer_signature_missing" });
  });

  it("rejects an invalid buyer signature", async () => {
    const transaction = await signedTransaction();
    const signature = transaction.signatures.find((entry) =>
      entry.publicKey.equals(buyer.publicKey),
    )?.signature;
    if (!signature) throw new Error("Test buyer signature missing");
    signature[0] ^= 1;

    await expect(submit(transaction)).rejects.toMatchObject({
      code: "buyer_signature_invalid",
    });
  });

  // Previously: amount / mint / source / destination of a TransferChecked.
  // Now every account and argument of create_order is covered: one wrong
  // account (same program) or one wrong data field must be refused.
  it.each([
    ["amount", { amount: BigInt(600_001) }],
    ["mint", { mint: otherMint }],
    ["buyer token account (source)", { buyerToken: attacker.publicKey }],
    ["merchant (payout owner)", { merchant: attacker.publicKey }],
    ["order PDA", { order: attacker.publicKey }],
    ["vault PDA", { vault: attacker.publicKey }],
    ["order id", { orderId: "order-2" }],
    ["ship window", { shipWindowSeconds: BigInt(1) }],
    ["protection window", { protectionWindowSeconds: BigInt(1) }],
  ] as const)("rejects a tampered %s", async (_label, override) => {
    const deps = dependencies();
    await expect(
      submit(
        await signedTransaction({
          instructions: [await paymentInstruction(override)],
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "payment_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a create_order whose token program account is swapped", async () => {
    const instruction = await paymentInstruction();
    instruction.keys[7] = { ...instruction.keys[7], pubkey: attackerProgramId };
    const deps = dependencies();
    await expect(
      submit(await signedTransaction({ instructions: [instruction] }), deps),
    ).rejects.toMatchObject({ code: "payment_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a create_order with accounts in a different order", async () => {
    const instruction = await paymentInstruction();
    [instruction.keys[5], instruction.keys[6]] = [instruction.keys[6], instruction.keys[5]];
    const deps = dependencies();
    await expect(
      submit(await signedTransaction({ instructions: [instruction] }), deps),
    ).rejects.toMatchObject({ code: "payment_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a create_order with an extra trailing account", async () => {
    const instruction = await paymentInstruction();
    instruction.keys.push({
      pubkey: attacker.publicKey,
      isSigner: false,
      isWritable: true,
    });
    const deps = dependencies();
    await expect(
      submit(await signedTransaction({ instructions: [instruction] }), deps),
    ).rejects.toMatchObject({ code: "payment_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a create_order where a read-only account was made writable", async () => {
    const instruction = await paymentInstruction();
    instruction.keys[2] = { ...instruction.keys[2], isWritable: true };
    const deps = dependencies();
    await expect(
      submit(await signedTransaction({ instructions: [instruction] }), deps),
    ).rejects.toMatchObject({ code: "payment_mismatch" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it.each([0, 7, 8, 39, 40, 47, 48, 56, 63])(
    "rejects a create_order with data byte %i flipped",
    async (index) => {
      const instruction = await paymentInstruction();
      const data = Buffer.from(instruction.data);
      data[index] ^= 0x01;
      instruction.data = data;
      const deps = dependencies();
      await expect(
        submit(await signedTransaction({ instructions: [instruction] }), deps),
      ).rejects.toMatchObject({ code: "payment_mismatch" });
      expect(deps.signWithSponsor).not.toHaveBeenCalled();
    },
  );

  it("rejects create_order data with an appended byte", async () => {
    const instruction = await paymentInstruction();
    instruction.data = Buffer.concat([Buffer.from(instruction.data), Buffer.from([0])]);
    await expect(
      submit(await signedTransaction({ instructions: [instruction] })),
    ).rejects.toMatchObject({ code: "payment_mismatch" });
  });

  it("rejects a second create_order instruction", async () => {
    const deps = dependencies();
    await expect(
      submit(
        await signedTransaction({
          instructions: [await paymentInstruction(), await paymentInstruction()],
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a second instruction that closes or creates token accounts", async () => {
    const deps = dependencies();
    const closeAccount = {
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: await getAssociatedTokenAddress(mint, buyer.publicKey), isSigner: false, isWritable: true },
        { pubkey: attacker.publicKey, isSigner: false, isWritable: true },
        { pubkey: buyer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]),
    };
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            await paymentInstruction(),
            closeAccount as unknown as TransactionInstruction,
          ],
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a tampered buyer (USDC authority)", async () => {
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            await paymentInstruction({ buyer: attacker.publicKey }),
          ],
          signer: attacker,
        }),
      ),
    ).rejects.toMatchObject({ code: "buyer_signature_missing" });
  });

  it("rejects an injected second instruction before sponsor signing", async () => {
    const deps = dependencies();
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            await paymentInstruction(),
            SystemProgram.transfer({
              fromPubkey: buyer.publicKey,
              toPubkey: attacker.publicKey,
              lamports: 1,
            }),
          ],
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects an injected Compute Budget instruction", async () => {
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            await paymentInstruction(),
            ComputeBudgetProgram.setComputeUnitLimit({ units: 20_000 }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
  });

  it("rejects the old direct TransferChecked payment to the merchant", async () => {
    const deps = dependencies();
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            createTransferCheckedInstruction(
              await getAssociatedTokenAddress(mint, buyer.publicKey),
              mint,
              await getAssociatedTokenAddress(mint, merchant.publicKey),
              buyer.publicKey,
              BigInt(600_000),
              6,
            ),
          ],
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a create_order addressed to another program", async () => {
    const deps = dependencies();
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            await paymentInstruction({ programId: attackerProgramId }),
          ],
        }),
        deps,
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects a non-escrow instruction", async () => {
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            SystemProgram.transfer({
              fromPubkey: buyer.publicKey,
              toPubkey: attacker.publicKey,
              lamports: 1,
            }),
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "instruction_invalid" });
  });

  it("rejects an expired blockhash and an unexpectedly high fee", async () => {
    await expect(
      submit(
        await signedTransaction(),
        dependencies({ isBlockhashValid: vi.fn(async () => false) }),
      ),
    ).rejects.toMatchObject({ code: "blockhash_expired" });

    await expect(
      submit(
        await signedTransaction(),
        dependencies({
          getFeeForMessage: vi.fn(
            async () => MAX_SPONSORED_FEE_LAMPORTS + 1,
          ),
        }),
      ),
    ).rejects.toMatchObject({ code: "fee_too_high" });
  });

  it("refuses to sign while the sponsor balance is below the threshold", async () => {
    const deps = dependencies({ getSponsorBalance: vi.fn(async () => 19_999_999) });
    await expect(submit(await signedTransaction(), deps)).rejects.toMatchObject({
      code: "sponsor_balance_low",
    });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
    expect(deps.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("signs at exactly the threshold and honours a configured threshold", async () => {
    expect(
      (await submit(
        await signedTransaction(),
        dependencies({ getSponsorBalance: vi.fn(async () => 20_000_000) }),
      )).txSignature,
    ).toBe("rpc-transaction-signature");

    vi.stubEnv("SPONSOR_MIN_BALANCE_LAMPORTS", "50000000");
    await expect(
      submit(
        await signedTransaction(),
        dependencies({ getSponsorBalance: vi.fn(async () => 49_999_999) }),
      ),
    ).rejects.toMatchObject({ code: "sponsor_balance_low" });
  });

  it("fails closed when the sponsor balance cannot be read", async () => {
    const deps = dependencies({
      getSponsorBalance: vi.fn(async () => {
        throw new Error("RPC down");
      }),
    });
    await expect(submit(await signedTransaction(), deps)).rejects.toMatchObject({
      code: "sponsor_balance_unavailable",
    });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-sponsored (Blink) order", { sponsored: false }],
    ["a legacy direct order", { settlement: "direct" as const }],
  ])("refuses to sponsor %s", async (_label, override) => {
    const deps = dependencies();
    await expect(
      submit(await signedTransaction(), deps, order(override)),
    ).rejects.toMatchObject({ code: "order_not_sponsored" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("rejects an order below the sponsored minimum before signing", async () => {
    vi.stubEnv("MIN_ORDER_USDC", "1");
    const deps = dependencies();
    await expect(
      submit(await signedTransaction(), deps),
    ).rejects.toMatchObject({ code: "order_below_minimum" });
    expect(deps.signWithSponsor).not.toHaveBeenCalled();
  });

  it("leaves broadcast failure ambiguous instead of changing order state", async () => {
    const checkoutOrder = order();
    await expect(
      submit(
        await signedTransaction(),
        dependencies({
          sendRawTransaction: vi.fn(async () => {
            throw new Error("RPC timeout");
          }),
        }),
        checkoutOrder,
      ),
    ).rejects.toMatchObject({ code: "broadcast_failed" });
    expect(checkoutOrder.status).toBe("pending");
    expect(checkoutOrder.txSignature).toBeUndefined();
  });
});
