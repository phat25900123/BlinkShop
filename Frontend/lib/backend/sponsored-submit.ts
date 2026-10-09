import "server-only";

import {
  decodeTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  type Keypair,
  type Message,
  Transaction,
} from "@solana/web3.js";

import {
  getSponsoredPaymentAccounts,
  getSponsoredTransactionMessageHash,
  USDC_DECIMALS,
} from "@/lib/backend/sponsored-checkout";
import { getSolanaSponsorKeypair } from "@/lib/backend/solana-sponsor";
import { store } from "@/lib/backend/store";
import type { Order } from "@/lib/backend/types";

export const MAX_SPONSORED_FEE_LAMPORTS = 20_000;

export type SponsoredSubmissionErrorCode =
  | "order_not_pending"
  | "order_expired"
  | "order_product_mismatch"
  | "order_buyer_mismatch"
  | "signed_transaction_invalid"
  | "fee_payer_mismatch"
  | "sponsor_signature_present"
  | "buyer_signature_missing"
  | "buyer_signature_invalid"
  | "instruction_invalid"
  | "payment_mismatch"
  | "transaction_message_mismatch"
  | "blockhash_expired"
  | "fee_unavailable"
  | "fee_too_high"
  | "broadcast_failed";

export class SponsoredSubmissionError extends Error {
  constructor(
    public readonly code: SponsoredSubmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SponsoredSubmissionError";
  }
}

export type SponsoredSubmissionDependencies = {
  getSponsorKeypair: () => Keypair;
  isBlockhashValid: (blockhash: string) => Promise<boolean>;
  getFeeForMessage: (message: Message) => Promise<number | null>;
  getCurrentOrder: (orderId: string) => Order | undefined;
  signWithSponsor: (transaction: Transaction, sponsor: Keypair) => void;
  sendRawTransaction: (transaction: Uint8Array) => Promise<string>;
};

function defaultDependencies(): SponsoredSubmissionDependencies {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed",
  );

  return {
    getSponsorKeypair: getSolanaSponsorKeypair,
    isBlockhashValid: async (blockhash) =>
      (await connection.isBlockhashValid(blockhash, { commitment: "confirmed" }))
        .value,
    getFeeForMessage: async (message) =>
      (await connection.getFeeForMessage(message, "confirmed")).value,
    getCurrentOrder: (orderId) => store.getOrder(orderId),
    signWithSponsor: (transaction, sponsor) => transaction.partialSign(sponsor),
    sendRawTransaction: (transaction) =>
      connection.sendRawTransaction(transaction, {
        maxRetries: 3,
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }),
  };
}

function decodeSignedTransaction(value: string) {
  const encoded = value.trim();
  if (!encoded) {
    throw new SponsoredSubmissionError(
      "signed_transaction_invalid",
      "The signed transaction is required.",
    );
  }

  try {
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.toString("base64") !== encoded) {
      throw new Error("Invalid base64 transaction");
    }
    return Transaction.from(bytes);
  } catch {
    throw new SponsoredSubmissionError(
      "signed_transaction_invalid",
      "The signed transaction is malformed.",
    );
  }
}

function requireOrderForBuyer(
  order: Order,
  routeProductId: string,
  authenticatedBuyerWallet: string,
) {
  if (order.productId !== routeProductId) {
    throw new SponsoredSubmissionError(
      "order_product_mismatch",
      "The order does not belong to this product.",
    );
  }
  if (order.buyerWallet !== authenticatedBuyerWallet) {
    throw new SponsoredSubmissionError(
      "order_buyer_mismatch",
      "The order belongs to another buyer wallet.",
    );
  }
  if (order.status !== "pending") {
    throw new SponsoredSubmissionError(
      "order_not_pending",
      "Only a pending order can be submitted.",
    );
  }
  if (Date.parse(order.expiresAt) <= Date.now()) {
    throw new SponsoredSubmissionError(
      "order_expired",
      "The pending order has expired.",
    );
  }
}

export async function submitSponsoredCheckoutTransaction(
  input: {
    order: Order;
    routeProductId: string;
    authenticatedBuyerWallet: string;
    signedTransaction: string;
  },
  injectedDependencies?: SponsoredSubmissionDependencies,
) {
  requireOrderForBuyer(
    input.order,
    input.routeProductId,
    input.authenticatedBuyerWallet,
  );

  const dependencies = injectedDependencies ?? defaultDependencies();
  const sponsor = dependencies.getSponsorKeypair();
  const expected = await getSponsoredPaymentAccounts(
    input.authenticatedBuyerWallet,
    input.order.amountUsdc,
  );
  const transaction = decodeSignedTransaction(input.signedTransaction);

  if (!transaction.feePayer?.equals(sponsor.publicKey)) {
    throw new SponsoredSubmissionError(
      "fee_payer_mismatch",
      "The transaction fee payer is not the BlinkShop Devnet sponsor.",
    );
  }

  const message = transaction.compileMessage();
  const requiredSigners = message.accountKeys.slice(
    0,
    message.header.numRequiredSignatures,
  );
  if (
    requiredSigners.length !== 2 ||
    !requiredSigners[0].equals(sponsor.publicKey) ||
    !requiredSigners[1].equals(expected.buyer)
  ) {
    throw new SponsoredSubmissionError(
      "buyer_signature_missing",
      "The authenticated buyer is not the required transaction signer.",
    );
  }

  const sponsorSignature = transaction.signatures.find((entry) =>
    entry.publicKey.equals(sponsor.publicKey),
  );
  if (!sponsorSignature || sponsorSignature.signature) {
    throw new SponsoredSubmissionError(
      "sponsor_signature_present",
      "The sponsor signature must be added by BlinkShop.",
    );
  }

  const buyerSignature = transaction.signatures.find((entry) =>
    entry.publicKey.equals(expected.buyer),
  );
  if (!buyerSignature?.signature) {
    throw new SponsoredSubmissionError(
      "buyer_signature_missing",
      "The authenticated buyer signature is missing.",
    );
  }
  if (!transaction.verifySignatures(false)) {
    throw new SponsoredSubmissionError(
      "buyer_signature_invalid",
      "The authenticated buyer signature is invalid.",
    );
  }

  if (transaction.instructions.length !== 1) {
    throw new SponsoredSubmissionError(
      "instruction_invalid",
      "The sponsored transaction must contain exactly one instruction.",
    );
  }

  const instruction = transaction.instructions[0];
  if (!instruction.programId.equals(TOKEN_PROGRAM_ID)) {
    throw new SponsoredSubmissionError(
      "instruction_invalid",
      "Only the SPL Token transfer instruction can be sponsored.",
    );
  }

  let transfer: ReturnType<typeof decodeTransferCheckedInstruction>;
  try {
    transfer = decodeTransferCheckedInstruction(instruction, TOKEN_PROGRAM_ID);
  } catch {
    throw new SponsoredSubmissionError(
      "instruction_invalid",
      "The sponsored instruction is not a valid TransferChecked payment.",
    );
  }

  if (
    transfer.keys.multiSigners.length !== 0 ||
    !transfer.keys.owner.isSigner ||
    !transfer.keys.source.pubkey.equals(expected.buyerTokenAccount) ||
    !transfer.keys.mint.pubkey.equals(expected.mint) ||
    !transfer.keys.destination.pubkey.equals(expected.merchantTokenAccount) ||
    !transfer.keys.owner.pubkey.equals(expected.buyer) ||
    transfer.data.amount !== expected.amount ||
    transfer.data.decimals !== USDC_DECIMALS
  ) {
    throw new SponsoredSubmissionError(
      "payment_mismatch",
      "The signed transaction does not match the pending order.",
    );
  }

  if (
    !input.order.sponsoredTransactionHash ||
    getSponsoredTransactionMessageHash(transaction) !==
      input.order.sponsoredTransactionHash
  ) {
    throw new SponsoredSubmissionError(
      "transaction_message_mismatch",
      "The signed transaction is not the transaction BlinkShop prepared for this order.",
    );
  }

  if (!(await dependencies.isBlockhashValid(transaction.recentBlockhash!))) {
    throw new SponsoredSubmissionError(
      "blockhash_expired",
      "The payment transaction expired before submission. Wait for the order to expire, then try again.",
    );
  }

  const fee = await dependencies.getFeeForMessage(message);
  if (fee === null) {
    throw new SponsoredSubmissionError(
      "fee_unavailable",
      "The Devnet network fee could not be calculated.",
    );
  }
  if (fee > MAX_SPONSORED_FEE_LAMPORTS) {
    throw new SponsoredSubmissionError(
      "fee_too_high",
      "The Devnet network fee exceeded BlinkShop's sponsorship limit.",
    );
  }

  const currentOrder = dependencies.getCurrentOrder(input.order.id);
  if (!currentOrder) {
    throw new SponsoredSubmissionError(
      "order_not_pending",
      "The pending order is no longer available.",
    );
  }
  requireOrderForBuyer(
    currentOrder,
    input.routeProductId,
    input.authenticatedBuyerWallet,
  );
  if (
    currentOrder.sponsoredTransactionHash !==
    input.order.sponsoredTransactionHash
  ) {
    throw new SponsoredSubmissionError(
      "transaction_message_mismatch",
      "The prepared transaction changed before sponsor signing.",
    );
  }

  dependencies.signWithSponsor(transaction, sponsor);
  if (!transaction.verifySignatures(true)) {
    throw new SponsoredSubmissionError(
      "signed_transaction_invalid",
      "The fully signed transaction failed signature verification.",
    );
  }

  let fullySignedTransaction: Buffer;
  try {
    fullySignedTransaction = transaction.serialize({
      requireAllSignatures: true,
      verifySignatures: true,
    });
  } catch {
    throw new SponsoredSubmissionError(
      "signed_transaction_invalid",
      "The fully signed transaction could not be serialized.",
    );
  }

  try {
    const txSignature = await dependencies.sendRawTransaction(
      fullySignedTransaction,
    );
    return { txSignature };
  } catch {
    throw new SponsoredSubmissionError(
      "broadcast_failed",
      "The transaction broadcast result is unknown. The order remains pending so it can be checked or retried safely.",
    );
  }
}
