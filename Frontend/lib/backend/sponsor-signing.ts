import "server-only";

import { createHash } from "node:crypto";

import {
  Connection,
  type Keypair,
  type Message,
  type PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";

import { getSponsorLimits } from "@/lib/backend/escrow-config";
import { getSolanaSponsorKeypair } from "@/lib/backend/solana-sponsor";

/**
 * The single place where BlinkShop's sponsor co-signs a user transaction.
 * Every sponsored transaction (checkout create_order and the order lifecycle
 * instructions) goes through `verifyAndSponsorTransaction`, so the rules are
 * identical: exactly one expected escrow instruction, sponsor as fee payer,
 * exactly [sponsor, user] as signers, the user's valid signature present, the
 * sponsor slot empty, the message bound to the server-prepared hash, a live
 * blockhash, a capped fee, a fresh state re-check and a minimum sponsor
 * balance. The sponsor signs last.
 */

export const MAX_SPONSORED_FEE_LAMPORTS = 20_000;

export type SponsoredSubmissionErrorCode =
  | "order_not_pending"
  | "order_expired"
  | "order_product_mismatch"
  | "order_merchant_mismatch"
  | "order_buyer_mismatch"
  | "signed_transaction_invalid"
  | "fee_payer_mismatch"
  | "sponsor_signature_present"
  | "buyer_signature_missing"
  | "buyer_signature_invalid"
  | "instruction_invalid"
  | "payment_mismatch"
  | "order_not_sponsored"
  | "order_below_minimum"
  | "transaction_message_mismatch"
  | "blockhash_expired"
  | "fee_unavailable"
  | "fee_too_high"
  | "sponsor_balance_unavailable"
  | "sponsor_balance_low"
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

export type SponsorSigningDependencies = {
  getSponsorKeypair: () => Keypair;
  isBlockhashValid: (blockhash: string) => Promise<boolean>;
  getFeeForMessage: (message: Message) => Promise<number | null>;
  getSponsorBalance: (sponsor: PublicKey) => Promise<number>;
  signWithSponsor: (transaction: Transaction, sponsor: Keypair) => void;
  sendRawTransaction: (transaction: Uint8Array) => Promise<string>;
};

export function defaultSponsorSigningDependencies(): SponsorSigningDependencies {
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
    getSponsorBalance: (sponsor) => connection.getBalance(sponsor, "confirmed"),
    signWithSponsor: (transaction, sponsor) => transaction.partialSign(sponsor),
    sendRawTransaction: (transaction) =>
      connection.sendRawTransaction(transaction, {
        maxRetries: 3,
        preflightCommitment: "confirmed",
        skipPreflight: false,
      }),
  };
}

export function getSponsoredTransactionMessageHash(transaction: Transaction) {
  return createHash("sha256")
    .update(transaction.serializeMessage())
    .digest("base64");
}

export function decodeSignedTransaction(value: string) {
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

/**
 * Exact structural equality with the instruction BlinkShop computed: same
 * program, same accounts in the same order with the same signer/writable
 * flags, and byte-identical data.
 *
 * A decoded legacy transaction reports message-level flags, and the fee payer
 * is always a writable signer at message level. The expected instruction is
 * normalised the same way, so an account that is also the fee payer (the
 * sponsor as `rent_payer`) compares equal. Every other flag must match.
 */
export function isSameInstruction(
  actual: TransactionInstruction,
  expected: TransactionInstruction,
  feePayer: PublicKey,
) {
  return (
    actual.programId.equals(expected.programId) &&
    actual.keys.length === expected.keys.length &&
    actual.keys.every((key, index) => {
      const want = expected.keys[index];
      const isFeePayer = want.pubkey.equals(feePayer);
      return (
        key.pubkey.equals(want.pubkey) &&
        key.isSigner === (want.isSigner || isFeePayer) &&
        key.isWritable === (want.isWritable || isFeePayer)
      );
    }) &&
    Buffer.from(actual.data).equals(Buffer.from(expected.data))
  );
}

export type SponsorSigningInput = {
  signedTransaction: string;
  /** The only non-sponsor signer allowed (buyer or merchant wallet). */
  signer: PublicKey;
  expectedInstruction: TransactionInstruction;
  /** Message hash BlinkShop bound to the order when it prepared the transaction. */
  boundMessageHash: string | undefined;
  /** Re-reads server state right before signing; throws to refuse. */
  recheck: () => void;
  messages: {
    wrongProgram: string;
    mismatch: string;
    expired: string;
    broadcastFailed: string;
  };
};

export async function verifyAndSponsorTransaction(
  input: SponsorSigningInput,
  dependencies: SponsorSigningDependencies,
) {
  const sponsor = dependencies.getSponsorKeypair();
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
    !requiredSigners[1].equals(input.signer)
  ) {
    throw new SponsoredSubmissionError(
      "buyer_signature_missing",
      "The authenticated wallet is not the required transaction signer.",
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

  const signerSignature = transaction.signatures.find((entry) =>
    entry.publicKey.equals(input.signer),
  );
  if (!signerSignature?.signature) {
    throw new SponsoredSubmissionError(
      "buyer_signature_missing",
      "The authenticated wallet signature is missing.",
    );
  }
  if (!transaction.verifySignatures(false)) {
    throw new SponsoredSubmissionError(
      "buyer_signature_invalid",
      "The authenticated wallet signature is invalid.",
    );
  }

  if (transaction.instructions.length !== 1) {
    throw new SponsoredSubmissionError(
      "instruction_invalid",
      "The sponsored transaction must contain exactly one instruction.",
    );
  }

  const instruction = transaction.instructions[0];
  if (!instruction.programId.equals(input.expectedInstruction.programId)) {
    throw new SponsoredSubmissionError("instruction_invalid", input.messages.wrongProgram);
  }

  if (
    !isSameInstruction(instruction, input.expectedInstruction, sponsor.publicKey)
  ) {
    throw new SponsoredSubmissionError("payment_mismatch", input.messages.mismatch);
  }

  if (
    !input.boundMessageHash ||
    getSponsoredTransactionMessageHash(transaction) !== input.boundMessageHash
  ) {
    throw new SponsoredSubmissionError(
      "transaction_message_mismatch",
      "The signed transaction is not the transaction BlinkShop prepared for this order.",
    );
  }

  if (!(await dependencies.isBlockhashValid(transaction.recentBlockhash!))) {
    throw new SponsoredSubmissionError("blockhash_expired", input.messages.expired);
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

  input.recheck();

  // Refuse while it can still be done cleanly rather than let the
  // transaction fail on-chain for lack of SOL.
  let sponsorBalance: number;
  try {
    sponsorBalance = await dependencies.getSponsorBalance(sponsor.publicKey);
  } catch {
    throw new SponsoredSubmissionError(
      "sponsor_balance_unavailable",
      "The BlinkShop sponsor balance could not be checked.",
    );
  }
  if (sponsorBalance < getSponsorLimits().sponsorMinBalanceLamports) {
    throw new SponsoredSubmissionError(
      "sponsor_balance_low",
      "BlinkShop cannot sponsor transactions right now. Please try again later.",
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
      input.messages.broadcastFailed,
    );
  }
}
