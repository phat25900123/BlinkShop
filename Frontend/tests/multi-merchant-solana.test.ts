import { getAssociatedTokenAddress } from "@solana/spl-token";
import {
  Keypair,
  type ParsedTransactionWithMeta,
  type PublicKey,
} from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getMerchantPayoutReadiness,
  verifyUsdcPayment,
} from "../lib/backend/solana";

const keypair = (offset: number) =>
  Keypair.fromSeed(
    Uint8Array.from({ length: 32 }, (_, index) => (index + offset) % 256),
  );

const buyer = keypair(1).publicKey;
const otherBuyer = keypair(31).publicKey;
const merchantA = keypair(61).publicKey;
const merchantB = keypair(91).publicKey;
const mint = keypair(121).publicKey;
const otherMint = keypair(151).publicKey;
const amountBaseUnits = 300_000;

async function transactionFor(options: {
  buyer?: PublicKey;
  merchant?: PublicKey;
  mint?: PublicKey;
  amount?: number;
}) {
  const selectedBuyer = options.buyer ?? buyer;
  const selectedMerchant = options.merchant ?? merchantA;
  const selectedMint = options.mint ?? mint;
  const selectedAmount = options.amount ?? amountBaseUnits;
  const buyerAta = await getAssociatedTokenAddress(selectedMint, selectedBuyer);
  const merchantAta = await getAssociatedTokenAddress(
    selectedMint,
    selectedMerchant,
  );

  return {
    meta: {
      err: null,
      preTokenBalances: [
        {
          owner: selectedMerchant.toBase58(),
          mint: selectedMint.toBase58(),
          uiTokenAmount: { amount: "100000" },
        },
        {
          owner: selectedBuyer.toBase58(),
          mint: selectedMint.toBase58(),
          uiTokenAmount: { amount: "500000" },
        },
      ],
      postTokenBalances: [
        {
          owner: selectedMerchant.toBase58(),
          mint: selectedMint.toBase58(),
          uiTokenAmount: { amount: String(100_000 + selectedAmount) },
        },
        {
          owner: selectedBuyer.toBase58(),
          mint: selectedMint.toBase58(),
          uiTokenAmount: { amount: String(500_000 - selectedAmount) },
        },
      ],
    },
    transaction: {
      message: {
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                authority: selectedBuyer.toBase58(),
                source: buyerAta.toBase58(),
                destination: merchantAta.toBase58(),
                tokenAmount: {
                  amount: String(selectedAmount),
                  mint: selectedMint.toBase58(),
                },
              },
            },
          },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

async function verifyFor(
  merchant: PublicKey,
  transaction: ParsedTransactionWithMeta,
) {
  return verifyUsdcPayment(
    "signature",
    {
      buyerWallet: buyer.toBase58(),
      merchantWallet: merchant.toBase58(),
      amountUsdc: 0.3,
    },
    { getParsedTransaction: vi.fn(async () => transaction) },
  );
}

describe("multi-merchant Solana payout expectations", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["merchant A", merchantA],
    ["merchant B", merchantB],
  ])("verifies a valid payment to %s", async (_label, merchant) => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());

    expect(await verifyFor(merchant, await transactionFor({ merchant }))).toBe(
      "valid",
    );
  });

  it("uses the order merchant even when legacy MERCHANT_WALLET points elsewhere", async () => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("MERCHANT_WALLET", merchantA.toBase58());

    expect(
      await verifyFor(merchantB, await transactionFor({ merchant: merchantB })),
    ).toBe("valid");
  });

  it("rejects payment to the old global wallet for merchant B's order", async () => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("MERCHANT_WALLET", merchantA.toBase58());

    expect(
      await verifyFor(merchantB, await transactionFor({ merchant: merchantA })),
    ).toBe("invalid");
  });

  it("rejects a transaction from the wrong buyer", async () => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());

    expect(
      await verifyFor(
        merchantA,
        await transactionFor({ buyer: otherBuyer, merchant: merchantA }),
      ),
    ).toBe("invalid");
  });

  it("rejects a transaction using another mint", async () => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());

    expect(
      await verifyFor(
        merchantA,
        await transactionFor({ merchant: merchantA, mint: otherMint }),
      ),
    ).toBe("invalid");
  });

  it("reports payout ready when the exact merchant USDC ATA exists", async () => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    const readiness = await getMerchantPayoutReadiness(
      merchantA.toBase58(),
      {
        loadTokenAccount: vi.fn(async () => ({
          mint,
          owner: merchantA,
        })),
      },
    );

    expect(readiness.payoutUsdcAta).toBe(
      (await getAssociatedTokenAddress(mint, merchantA)).toBase58(),
    );
    expect(readiness.payoutReady).toBe(true);
  });

  it("reports payout setup required when the merchant ATA is absent", async () => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    const readiness = await getMerchantPayoutReadiness(
      merchantA.toBase58(),
      { loadTokenAccount: vi.fn(async () => null) },
    );

    expect(readiness.payoutReady).toBe(false);
  });

  it.each([
    ["wrong mint", { mint: otherMint, owner: merchantA }],
    ["wrong owner", { mint, owner: merchantB }],
  ])("reports payout setup required for a token account with %s", async (_label, account) => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    const readiness = await getMerchantPayoutReadiness(
      merchantA.toBase58(),
      { loadTokenAccount: vi.fn(async () => account) },
    );

    expect(readiness.payoutReady).toBe(false);
  });
});
