import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import { validateUsdcPaymentTransaction } from "../lib/backend/solana";

const expected = {
  amountBaseUnits: 300_000,
  buyer: "buyer-wallet",
  buyerTokenAccount: "buyer-usdc-account",
  merchant: "merchant-wallet",
  merchantTokenAccount: "merchant-usdc-account",
  mint: "devnet-usdc-mint",
};

type TransactionOverrides = {
  error?: unknown;
  authority?: string;
  source?: string;
  destination?: string;
  amount?: string;
  mint?: string;
  merchantBefore?: string;
  merchantAfter?: string;
  buyerBefore?: string;
  buyerAfter?: string;
};

function transactionFixture(
  overrides: TransactionOverrides = {},
) {
  return {
    meta: {
      err: overrides.error ?? null,
      preTokenBalances: [
        {
          owner: expected.merchant,
          mint: expected.mint,
          uiTokenAmount: { amount: overrides.merchantBefore ?? "100000" },
        },
        {
          owner: expected.buyer,
          mint: expected.mint,
          uiTokenAmount: { amount: overrides.buyerBefore ?? "500000" },
        },
      ],
      postTokenBalances: [
        {
          owner: expected.merchant,
          mint: expected.mint,
          uiTokenAmount: { amount: overrides.merchantAfter ?? "400000" },
        },
        {
          owner: expected.buyer,
          mint: expected.mint,
          uiTokenAmount: { amount: overrides.buyerAfter ?? "200000" },
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
                authority: overrides.authority ?? expected.buyer,
                source: overrides.source ?? expected.buyerTokenAccount,
                destination: overrides.destination ?? expected.merchantTokenAccount,
                tokenAmount: {
                  amount: overrides.amount ?? String(expected.amountBaseUnits),
                  mint: overrides.mint ?? expected.mint,
                },
              },
            },
          },
        ],
      },
    },
  } as unknown as ParsedTransactionWithMeta;
}

describe("USDC payment validation", () => {
  it("accepts a successful transfer matching every server expectation", () => {
    expect(validateUsdcPaymentTransaction(transactionFixture(), expected)).toBe(true);
  });

  it("rejects a failed Solana transaction", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ error: { code: 1 } }), expected),
    ).toBe(false);
  });

  it("rejects the wrong USDC mint", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ mint: "other-mint" }), expected),
    ).toBe(false);
  });

  it("rejects the wrong buyer authority", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ authority: "other-buyer" }), expected),
    ).toBe(false);
  });

  it("rejects the wrong buyer source token account", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ source: "other-source" }), expected),
    ).toBe(false);
  });

  it("rejects the wrong merchant destination token account", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ destination: "other-destination" }), expected),
    ).toBe(false);
  });

  it("rejects the wrong transfer amount", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ amount: "299999" }), expected),
    ).toBe(false);
  });

  it("rejects a mismatched merchant balance delta", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ merchantAfter: "399999" }), expected),
    ).toBe(false);
  });

  it("rejects a mismatched buyer balance delta", () => {
    expect(
      validateUsdcPaymentTransaction(transactionFixture({ buyerAfter: "200001" }), expected),
    ).toBe(false);
  });
});
