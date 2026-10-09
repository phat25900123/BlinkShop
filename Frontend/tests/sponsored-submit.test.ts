import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddress,
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
  getSponsoredTransactionMessageHash,
} from "../lib/backend/sponsored-checkout";
import {
  MAX_SPONSORED_FEE_LAMPORTS,
  submitSponsoredCheckoutTransaction,
  type SponsoredSubmissionDependencies,
} from "../lib/backend/sponsored-submit";
import type { Order } from "../lib/backend/types";

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

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: "order-1",
    productId: "product-1",
    merchantId: "merchant-1",
    buyerWallet: buyer.publicKey.toBase58(),
    quantity: 2,
    amountUsdc: 0.6,
    status: "pending",
    inventoryReserved: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

async function paymentInstruction(overrides?: {
  source?: PublicKey;
  mint?: PublicKey;
  destination?: PublicKey;
  authority?: PublicKey;
  amount?: bigint;
}) {
  const selectedMint = overrides?.mint ?? mint;
  return createTransferCheckedInstruction(
    overrides?.source ??
      (await getAssociatedTokenAddress(mint, buyer.publicKey)),
    selectedMint,
    overrides?.destination ??
      (await getAssociatedTokenAddress(mint, merchant.publicKey)),
    overrides?.authority ?? buyer.publicKey,
    overrides?.amount ?? BigInt(600_000),
    6,
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
      routeProductId: "product-1",
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
          routeProductId: "another-product",
          authenticatedBuyerWallet: buyer.publicKey.toBase58(),
          signedTransaction: serialized(await signedTransaction()),
        },
        dependencies(),
      ),
    ).rejects.toMatchObject({ code: "order_product_mismatch" });
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

  it.each([
    ["amount", { amount: BigInt(600_001) }],
    ["mint", { mint: otherMint }],
    ["source", { source: attacker.publicKey }],
    ["destination", { destination: attacker.publicKey }],
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

  it("rejects a tampered transfer authority", async () => {
    await expect(
      submit(
        await signedTransaction({
          instructions: [
            await paymentInstruction({ authority: attacker.publicKey }),
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

  it("rejects a non-token instruction", async () => {
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
