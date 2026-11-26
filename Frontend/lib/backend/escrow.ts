import "server-only";

import { createHash } from "node:crypto";

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";

/**
 * Minimal, dependency-free encoding for the BlinkShop escrow program
 * (program/programs/blinkshop_escrow/src/lib.rs).
 *
 * Anchor instruction data is `sha256("global:<name>")[0..8]` followed by the
 * borsh-encoded args. All args here are fixed-size, so borsh reduces to
 * little-endian integers and raw bytes. The constants are pinned (and
 * cross-checked in tests against the derivation and the generated IDL) so a
 * typo can never silently change what the sponsor agrees to sign.
 */
export const ORDER_SEED = Buffer.from("order");
export const VAULT_SEED = Buffer.from("vault");

export const CREATE_ORDER_DISCRIMINATOR = Buffer.from([
  141, 54, 37, 207, 237, 210, 250, 215,
]);

/** 8 discriminator + 32 order_id + 8 amount + 8 ship_window + 8 protection_window */
export const CREATE_ORDER_DATA_LENGTH = 64;

/**
 * Account order for `create_order`, exactly as declared in `CreateOrder`.
 * Submission verification compares against this list position by position.
 */
export const CREATE_ORDER_ACCOUNTS = [
  "buyer",
  "rentPayer",
  "merchant",
  "mint",
  "buyerToken",
  "order",
  "vault",
  "tokenProgram",
  "systemProgram",
] as const;

/** 32-byte on-chain order id: sha256 of the BlinkShop order id (UTF-8). */
export function escrowOrderId(orderId: string) {
  if (!orderId) throw new Error("Order id is required");
  return createHash("sha256").update(orderId, "utf8").digest();
}

export function findEscrowOrderAddress(
  programId: PublicKey,
  merchant: PublicKey,
  orderId: Buffer,
) {
  if (orderId.length !== 32) throw new Error("Escrow order id must be 32 bytes");
  return PublicKey.findProgramAddressSync(
    [ORDER_SEED, merchant.toBuffer(), orderId],
    programId,
  )[0];
}

export function findEscrowVaultAddress(programId: PublicKey, order: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [VAULT_SEED, order.toBuffer()],
    programId,
  )[0];
}

export type CreateOrderArgs = {
  orderId: Buffer;
  amount: bigint;
  shipWindowSeconds: bigint;
  protectionWindowSeconds: bigint;
};

const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const I64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);

export function encodeCreateOrderData(args: CreateOrderArgs) {
  if (args.orderId.length !== 32) {
    throw new Error("Escrow order id must be 32 bytes");
  }
  if (args.amount <= BigInt(0) || args.amount > U64_MAX) {
    throw new Error("Escrow amount is out of range");
  }
  for (const window of [args.shipWindowSeconds, args.protectionWindowSeconds]) {
    if (window <= BigInt(0) || window > I64_MAX) {
      throw new Error("Escrow window is out of range");
    }
  }

  const data = Buffer.alloc(CREATE_ORDER_DATA_LENGTH);
  CREATE_ORDER_DISCRIMINATOR.copy(data, 0);
  args.orderId.copy(data, 8);
  data.writeBigUInt64LE(args.amount, 40);
  data.writeBigInt64LE(args.shipWindowSeconds, 48);
  data.writeBigInt64LE(args.protectionWindowSeconds, 56);
  return data;
}

/** Strict inverse of `encodeCreateOrderData`; returns null for anything else. */
export function decodeCreateOrderData(data: Buffer | Uint8Array): CreateOrderArgs | null {
  const bytes = Buffer.from(data);
  if (
    bytes.length !== CREATE_ORDER_DATA_LENGTH ||
    !bytes.subarray(0, 8).equals(CREATE_ORDER_DISCRIMINATOR)
  ) {
    return null;
  }

  return {
    orderId: Buffer.from(bytes.subarray(8, 40)),
    amount: bytes.readBigUInt64LE(40),
    shipWindowSeconds: bytes.readBigInt64LE(48),
    protectionWindowSeconds: bytes.readBigInt64LE(56),
  };
}

export type CreateOrderAccounts = {
  buyer: PublicKey;
  rentPayer: PublicKey;
  merchant: PublicKey;
  mint: PublicKey;
  buyerToken: PublicKey;
  order: PublicKey;
  vault: PublicKey;
};

/** Account metas in `CREATE_ORDER_ACCOUNTS` order with the program's flags. */
export function createOrderAccountMetas(accounts: CreateOrderAccounts) {
  return [
    { pubkey: accounts.buyer, isSigner: true, isWritable: true },
    { pubkey: accounts.rentPayer, isSigner: true, isWritable: true },
    { pubkey: accounts.merchant, isSigner: false, isWritable: false },
    { pubkey: accounts.mint, isSigner: false, isWritable: false },
    { pubkey: accounts.buyerToken, isSigner: false, isWritable: true },
    { pubkey: accounts.order, isSigner: false, isWritable: true },
    { pubkey: accounts.vault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
}

export function createEscrowOrderInstruction(
  programId: PublicKey,
  accounts: CreateOrderAccounts,
  args: CreateOrderArgs,
) {
  return new TransactionInstruction({
    programId,
    keys: createOrderAccountMetas(accounts),
    data: encodeCreateOrderData(args),
  });
}

// ---------------------------------------------------------------------------
// Order account (`#[account] pub struct Order`)
// ---------------------------------------------------------------------------

/** `sha256("account:Order")[0..8]` */
export const ORDER_ACCOUNT_DISCRIMINATOR = Buffer.from([
  134, 173, 223, 185, 77, 86, 28, 51,
]);

/** `8 + Order::INIT_SPACE`: the account is allocated with exactly this size. */
export const ORDER_ACCOUNT_LENGTH = 8 + 32 + 32 * 4 + 8 + 1 + 8 * 4 + 1;

export const ESCROW_ORDER_STATUSES = [
  "funded",
  "shipped",
  "released",
  "refunded",
] as const;

export type EscrowOrderStatus = (typeof ESCROW_ORDER_STATUSES)[number];

export type EscrowOrderAccount = {
  orderId: Buffer;
  merchant: PublicKey;
  buyer: PublicKey;
  rentPayer: PublicKey;
  mint: PublicKey;
  amount: bigint;
  status: EscrowOrderStatus;
  createdAt: bigint;
  shipBy: bigint;
  protectionWindow: bigint;
  releaseAfter: bigint;
  bump: number;
};

/** Strict decoder; returns null for anything that is not an `Order` account. */
export function decodeEscrowOrderAccount(
  data: Buffer | Uint8Array,
): EscrowOrderAccount | null {
  const bytes = Buffer.from(data);
  if (
    bytes.length !== ORDER_ACCOUNT_LENGTH ||
    !bytes.subarray(0, 8).equals(ORDER_ACCOUNT_DISCRIMINATOR)
  ) {
    return null;
  }

  const key = (offset: number) => new PublicKey(bytes.subarray(offset, offset + 32));
  const status = ESCROW_ORDER_STATUSES[bytes[176]];
  if (!status) return null;

  return {
    orderId: Buffer.from(bytes.subarray(8, 40)),
    merchant: key(40),
    buyer: key(72),
    rentPayer: key(104),
    mint: key(136),
    amount: bytes.readBigUInt64LE(168),
    status,
    createdAt: bytes.readBigInt64LE(177),
    shipBy: bytes.readBigInt64LE(185),
    protectionWindow: bytes.readBigInt64LE(193),
    releaseAfter: bytes.readBigInt64LE(201),
    bump: bytes[209],
  };
}

// ---------------------------------------------------------------------------
// Order lifecycle instructions (no args: data is the 8-byte discriminator)
// ---------------------------------------------------------------------------

export const ESCROW_ACTIONS = ["ship", "confirm-receipt", "refund", "claim"] as const;
export type EscrowAction = (typeof ESCROW_ACTIONS)[number];

export const ESCROW_ACTION_DISCRIMINATORS: Record<EscrowAction, Buffer> = {
  ship: Buffer.from([239, 5, 66, 105, 238, 17, 89, 97]), // mark_shipped
  "confirm-receipt": Buffer.from([203, 36, 80, 115, 249, 12, 141, 170]),
  refund: Buffer.from([2, 96, 183, 251, 63, 208, 46, 46]),
  claim: Buffer.from([62, 198, 214, 193, 213, 159, 108, 210]),
};

export function isEscrowAction(value: unknown): value is EscrowAction {
  return typeof value === "string" && (ESCROW_ACTIONS as readonly string[]).includes(value);
}

/** `mark_shipped`: accounts exactly as in `MarkShipped`. */
export function markShippedInstruction(
  programId: PublicKey,
  accounts: { merchant: PublicKey; order: PublicKey },
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.merchant, isSigner: true, isWritable: false },
      { pubkey: accounts.order, isSigner: false, isWritable: true },
    ],
    data: Buffer.from(ESCROW_ACTION_DISCRIMINATORS.ship),
  });
}

export type SettleAccounts = {
  caller: PublicKey;
  order: PublicKey;
  mint: PublicKey;
  vault: PublicKey;
  destinationToken: PublicKey;
  rentPayer: PublicKey;
};

/** `confirm_receipt` / `refund` / `claim`: accounts exactly as in `Settle`. */
export function settleInstruction(
  programId: PublicKey,
  action: Exclude<EscrowAction, "ship">,
  accounts: SettleAccounts,
) {
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: accounts.caller, isSigner: true, isWritable: false },
      { pubkey: accounts.order, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.vault, isSigner: false, isWritable: true },
      { pubkey: accounts.destinationToken, isSigner: false, isWritable: true },
      { pubkey: accounts.rentPayer, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(ESCROW_ACTION_DISCRIMINATORS[action]),
  });
}
