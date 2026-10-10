import "server-only";

import { createHash } from "node:crypto";

import {
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

import { getSolanaSponsorPublicKey } from "@/lib/backend/solana-sponsor";

export const USDC_DECIMALS = 6;

export function getSponsoredTransactionMessageHash(transaction: Transaction) {
  return createHash("sha256")
    .update(transaction.serializeMessage())
    .digest("base64");
}

type TokenAccountIdentity = {
  mint: PublicKey;
  owner: PublicKey;
};

export type SponsoredCheckoutDependencies = {
  getLatestBlockhash: () => Promise<BlockhashWithExpiryBlockHeight>;
  loadTokenAccount: (
    address: PublicKey,
  ) => Promise<TokenAccountIdentity | null>;
};

export type SponsoredCheckoutErrorCode =
  | "configuration_missing"
  | "buyer_usdc_account_missing"
  | "merchant_usdc_account_missing";

export class SponsoredCheckoutError extends Error {
  constructor(
    public readonly code: SponsoredCheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SponsoredCheckoutError";
  }
}

function configuredPublicKey(value: string | undefined, label: string) {
  if (!value?.trim()) {
    throw new SponsoredCheckoutError(
      "configuration_missing",
      `${label} is not configured`,
    );
  }

  return new PublicKey(value.trim());
}

export async function getSponsoredPaymentAccounts(
  buyerWallet: string,
  merchantWallet: string,
  amountUsdc: number,
) {
  const mint = configuredPublicKey(
    process.env.SOLANA_USDC_MINT,
    "SOLANA_USDC_MINT",
  );
  const merchant = configuredPublicKey(
    merchantWallet,
    "merchantWallet",
  );
  const buyer = new PublicKey(buyerWallet);
  const amount = BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));

  if (amount <= BigInt(0) || !Number.isSafeInteger(Number(amount))) {
    throw new Error("Invalid USDC payment amount");
  }

  return {
    mint,
    merchant,
    buyer,
    amount,
    buyerTokenAccount: await getAssociatedTokenAddress(mint, buyer),
    merchantTokenAccount: await getAssociatedTokenAddress(mint, merchant),
  };
}

function defaultDependencies(rpcUrl: string): SponsoredCheckoutDependencies {
  const connection = new Connection(rpcUrl, "confirmed");

  return {
    getLatestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    loadTokenAccount: async (address) => {
      try {
        return await getAccount(connection, address, "confirmed");
      } catch (error) {
        if (error instanceof TokenAccountNotFoundError) {
          return null;
        }

        throw error;
      }
    },
  };
}

export async function createSponsoredUsdcTransferTransaction(
  buyerWallet: string,
  merchantWallet: string,
  amountUsdc: number,
  dependencies?: SponsoredCheckoutDependencies,
) {
  const {
    mint,
    merchant,
    buyer,
    amount,
    buyerTokenAccount,
    merchantTokenAccount,
  } = await getSponsoredPaymentAccounts(
    buyerWallet,
    merchantWallet,
    amountUsdc,
  );
  const sponsor = getSolanaSponsorPublicKey();
  const operations =
    dependencies ??
    defaultDependencies(
      process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    );

  const [buyerAccount, merchantAccount, latestBlockhash] = await Promise.all([
    operations.loadTokenAccount(buyerTokenAccount),
    operations.loadTokenAccount(merchantTokenAccount),
    operations.getLatestBlockhash(),
  ]);

  if (
    !buyerAccount ||
    !buyerAccount.mint.equals(mint) ||
    !buyerAccount.owner.equals(buyer)
  ) {
    throw new SponsoredCheckoutError(
      "buyer_usdc_account_missing",
      "Your embedded wallet does not have a USDC token account yet. Fund it with Devnet USDC first.",
    );
  }

  if (
    !merchantAccount ||
    !merchantAccount.mint.equals(mint) ||
    !merchantAccount.owner.equals(merchant)
  ) {
    throw new SponsoredCheckoutError(
      "merchant_usdc_account_missing",
      "The merchant Devnet USDC token account is not configured.",
    );
  }

  const transaction = new Transaction({
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    feePayer: sponsor,
  }).add(
    createTransferCheckedInstruction(
      buyerTokenAccount,
      mint,
      merchantTokenAccount,
      buyer,
      amount,
      USDC_DECIMALS,
    ),
  );

  return {
    serializedTransaction: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    buyerWallet: buyer.toBase58(),
    buyerTokenAccount: buyerTokenAccount.toBase58(),
    merchantWallet: merchant.toBase58(),
    merchantTokenAccount: merchantTokenAccount.toBase58(),
    usdcMint: mint.toBase58(),
    amountBaseUnits: Number(amount),
    sponsorWallet: sponsor.toBase58(),
    messageHash: getSponsoredTransactionMessageHash(transaction),
  };
}
