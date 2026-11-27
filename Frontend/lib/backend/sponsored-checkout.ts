import "server-only";

import {
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

import {
  createEscrowOrderInstruction,
  escrowOrderId,
  findEscrowOrderAddress,
  findEscrowVaultAddress,
} from "@/lib/backend/escrow";
import { getEscrowConfig, getSponsorLimits } from "@/lib/backend/escrow-config";
import { getSolanaSponsorPublicKey } from "@/lib/backend/solana-sponsor";
import { getSponsoredTransactionMessageHash } from "@/lib/backend/sponsor-signing";
import {
  isBelowMinimumOrder,
  usdcToBaseUnits,
} from "@/lib/backend/sponsor-limits";

export { USDC_DECIMALS } from "@/lib/backend/sponsor-limits";

export { getSponsoredTransactionMessageHash } from "@/lib/backend/sponsor-signing";

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
  | "merchant_usdc_account_missing"
  | "order_below_minimum";

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
  const amount = usdcToBaseUnits(amountUsdc);

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

/**
 * Every value the escrow `create_order` instruction needs, derived only from
 * server-owned inputs: the BlinkShop order id, the authenticated buyer wallet,
 * the product's payout wallet, the order amount and server configuration.
 */
export async function getSponsoredEscrowAccounts(
  orderId: string,
  buyerWallet: string,
  merchantWallet: string,
  amountUsdc: number,
) {
  if (isBelowMinimumOrder(amountUsdc, getSponsorLimits())) {
    throw new SponsoredCheckoutError(
      "order_below_minimum",
      "The order total is below the minimum BlinkShop sponsors.",
    );
  }

  const payment = await getSponsoredPaymentAccounts(
    buyerWallet,
    merchantWallet,
    amountUsdc,
  );
  const config = getEscrowConfig();
  const onChainOrderId = escrowOrderId(orderId);
  const order = findEscrowOrderAddress(
    config.programId,
    payment.merchant,
    onChainOrderId,
  );

  return {
    ...payment,
    programId: config.programId,
    shipWindowSeconds: config.shipWindowSeconds,
    protectionWindowSeconds: config.protectionWindowSeconds,
    escrowOrderId: onChainOrderId,
    order,
    vault: findEscrowVaultAddress(config.programId, order),
  };
}

type SponsoredEscrowAccounts = Awaited<
  ReturnType<typeof getSponsoredEscrowAccounts>
>;

/**
 * The one instruction allowed in a checkout transaction. `rentPayer` is the
 * BlinkShop sponsor (sponsored checkout) or the buyer (Blink, buyer-funded).
 * Used both to build the transaction and to verify the buyer-signed copy, so
 * they cannot drift.
 */
export function expectedCreateOrderInstruction(
  expected: SponsoredEscrowAccounts,
  rentPayer: PublicKey,
) {
  return createEscrowOrderInstruction(
    expected.programId,
    {
      buyer: expected.buyer,
      rentPayer,
      merchant: expected.merchant,
      mint: expected.mint,
      buyerToken: expected.buyerTokenAccount,
      order: expected.order,
      vault: expected.vault,
    },
    {
      orderId: expected.escrowOrderId,
      amount: expected.amount,
      shipWindowSeconds: expected.shipWindowSeconds,
      protectionWindowSeconds: expected.protectionWindowSeconds,
    },
  );
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

/**
 * Shared builder: exactly one escrow `create_order` instruction whose fee
 * payer is also its `rent_payer`. Verifies the buyer and merchant USDC ATAs
 * first and never adds ATA creation or any other instruction.
 */
async function buildEscrowOrderTransaction(
  orderId: string,
  buyerWallet: string,
  merchantWallet: string,
  amountUsdc: number,
  payer: (expected: SponsoredEscrowAccounts) => PublicKey,
  dependencies?: SponsoredCheckoutDependencies,
) {
  const expected = await getSponsoredEscrowAccounts(
    orderId,
    buyerWallet,
    merchantWallet,
    amountUsdc,
  );
  const {
    mint,
    merchant,
    buyer,
    amount,
    buyerTokenAccount,
    merchantTokenAccount,
  } = expected;
  const feeAndRentPayer = payer(expected);
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
      "Your wallet does not have a USDC token account yet. Fund it with Devnet USDC first.",
    );
  }

  // The escrow never touches the merchant ATA at funding time, but release
  // pays into it later; refusing here avoids escrowing funds for a merchant
  // that cannot be paid out.
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
    feePayer: feeAndRentPayer,
  }).add(expectedCreateOrderInstruction(expected, feeAndRentPayer));

  return {
    transaction,
    blockhash: latestBlockhash.blockhash,
    summary: {
      serializedTransaction: transaction
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString("base64"),
      buyerWallet: buyer.toBase58(),
      buyerTokenAccount: buyerTokenAccount.toBase58(),
      merchantWallet: merchant.toBase58(),
      merchantTokenAccount: merchantTokenAccount.toBase58(),
      usdcMint: mint.toBase58(),
      amountBaseUnits: Number(amount),
      escrowProgramId: expected.programId.toBase58(),
      escrowOrderAccount: expected.order.toBase58(),
      escrowVaultAccount: expected.vault.toBase58(),
    },
  };
}

/**
 * Builds the sponsored checkout transaction: exactly one escrow
 * `create_order` instruction. The buyer signs as the USDC authority; the
 * BlinkShop sponsor is both the fee payer and the `rent_payer` for the order
 * and vault accounts, and signs last, only at submission.
 */
export async function createSponsoredEscrowOrderTransaction(
  orderId: string,
  buyerWallet: string,
  merchantWallet: string,
  amountUsdc: number,
  dependencies?: SponsoredCheckoutDependencies,
) {
  const sponsor = getSolanaSponsorPublicKey();
  const { transaction, summary } = await buildEscrowOrderTransaction(
    orderId,
    buyerWallet,
    merchantWallet,
    amountUsdc,
    () => sponsor,
    dependencies,
  );

  return {
    ...summary,
    sponsorWallet: sponsor.toBase58(),
    messageHash: getSponsoredTransactionMessageHash(transaction),
  };
}

/**
 * Blink (Solana Actions) checkout: the buyer's own wallet signs once and is
 * the fee payer and `rent_payer`, so BlinkShop pays nothing. Still exactly
 * one escrow `create_order` instruction.
 */
export async function createBuyerFundedEscrowOrderTransaction(
  orderId: string,
  buyerWallet: string,
  merchantWallet: string,
  amountUsdc: number,
  dependencies?: SponsoredCheckoutDependencies,
) {
  const { blockhash, summary } = await buildEscrowOrderTransaction(
    orderId,
    buyerWallet,
    merchantWallet,
    amountUsdc,
    (expected) => expected.buyer,
    dependencies,
  );
  return { ...summary, blockhash };
}
