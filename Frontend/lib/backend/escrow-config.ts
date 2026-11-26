import "server-only";

import { PublicKey, SystemProgram } from "@solana/web3.js";

/**
 * Single source of truth for the BlinkShop escrow program configuration.
 *
 * Window bounds mirror `MIN_WINDOW` / `MAX_WINDOW` in
 * program/programs/blinkshop_escrow/src/lib.rs. A value outside them would
 * make every `create_order` fail on-chain, so it is rejected at startup.
 */
export const ESCROW_MIN_WINDOW_SECONDS = 1;
export const ESCROW_MAX_WINDOW_SECONDS = 30 * 24 * 60 * 60;

export const DEFAULT_SHIP_WINDOW_SECONDS = 604_800; // 7 days
export const DEFAULT_PROTECTION_WINDOW_SECONDS = 259_200; // 3 days

export type EscrowConfigErrorCode =
  | "escrow_program_missing"
  | "escrow_program_invalid"
  | "escrow_window_invalid"
  | "sponsor_limit_invalid";

export class EscrowConfigurationError extends Error {
  constructor(
    public readonly code: EscrowConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EscrowConfigurationError";
  }
}

export type EscrowEnvironment = {
  ESCROW_PROGRAM_ID?: string;
  SHIP_WINDOW_SECONDS?: string;
  PROTECTION_WINDOW_SECONDS?: string;
};

export type EscrowConfig = {
  programId: PublicKey;
  shipWindowSeconds: bigint;
  protectionWindowSeconds: bigint;
};

function parseProgramId(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new EscrowConfigurationError(
      "escrow_program_missing",
      "ESCROW_PROGRAM_ID is not configured.",
    );
  }

  let programId: PublicKey;
  try {
    programId = new PublicKey(trimmed);
  } catch {
    throw new EscrowConfigurationError(
      "escrow_program_invalid",
      "ESCROW_PROGRAM_ID is not a valid Solana address.",
    );
  }

  // Round-trip guards against inputs PublicKey accepts loosely, and the
  // system program id (all zeroes) is never a deployed escrow program.
  if (
    programId.toBase58() !== trimmed ||
    programId.equals(SystemProgram.programId)
  ) {
    throw new EscrowConfigurationError(
      "escrow_program_invalid",
      "ESCROW_PROGRAM_ID is not a valid Solana address.",
    );
  }

  return programId;
}

function parseWindow(
  value: string | undefined,
  fallback: number,
  label: string,
) {
  const trimmed = value?.trim();
  if (!trimmed) return BigInt(fallback);

  if (!/^[0-9]+$/.test(trimmed)) {
    throw new EscrowConfigurationError(
      "escrow_window_invalid",
      `${label} must be a whole number of seconds.`,
    );
  }

  const seconds = Number(trimmed);
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < ESCROW_MIN_WINDOW_SECONDS ||
    seconds > ESCROW_MAX_WINDOW_SECONDS
  ) {
    throw new EscrowConfigurationError(
      "escrow_window_invalid",
      `${label} must be between ${ESCROW_MIN_WINDOW_SECONDS} and ${ESCROW_MAX_WINDOW_SECONDS} seconds.`,
    );
  }

  return BigInt(seconds);
}

export function getEscrowConfig(
  environment: EscrowEnvironment = {
    ESCROW_PROGRAM_ID: process.env.ESCROW_PROGRAM_ID,
    SHIP_WINDOW_SECONDS: process.env.SHIP_WINDOW_SECONDS,
    PROTECTION_WINDOW_SECONDS: process.env.PROTECTION_WINDOW_SECONDS,
  },
): EscrowConfig {
  return {
    programId: parseProgramId(environment.ESCROW_PROGRAM_ID),
    shipWindowSeconds: parseWindow(
      environment.SHIP_WINDOW_SECONDS,
      DEFAULT_SHIP_WINDOW_SECONDS,
      "SHIP_WINDOW_SECONDS",
    ),
    protectionWindowSeconds: parseWindow(
      environment.PROTECTION_WINDOW_SECONDS,
      DEFAULT_PROTECTION_WINDOW_SECONDS,
      "PROTECTION_WINDOW_SECONDS",
    ),
  };
}

// ---------------------------------------------------------------------------
// Sponsor spending limits
//
// Each funded escrow order makes the sponsor pay rent for two accounts (the
// order receipt, kept forever, and the vault, refunded on settlement). These
// limits bound how much SOL a single buyer wallet can make the sponsor spend.
// ---------------------------------------------------------------------------

export const DEFAULT_MIN_ORDER_USDC = 0.01;
export const DEFAULT_BUYER_MAX_PENDING_ORDERS = 3;
export const DEFAULT_BUYER_MAX_ORDERS_PER_24H = 30;
export const DEFAULT_SPONSOR_MIN_BALANCE_LAMPORTS = 20_000_000; // 0.02 SOL

export type SponsorLimitsEnvironment = {
  MIN_ORDER_USDC?: string;
  BUYER_MAX_PENDING_ORDERS?: string;
  BUYER_MAX_ORDERS_PER_24H?: string;
  SPONSOR_MIN_BALANCE_LAMPORTS?: string;
};

export type SponsorLimits = {
  /** Minimum order total in USDC base units (6 decimals). */
  minOrderBaseUnits: bigint;
  buyerMaxPendingOrders: number;
  buyerMaxOrdersPer24h: number;
  sponsorMinBalanceLamports: number;
};

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  label: string,
) {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;

  const parsed = Number(trimmed);
  if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new EscrowConfigurationError(
      "sponsor_limit_invalid",
      `${label} must be a positive whole number.`,
    );
  }
  return parsed;
}

function parseMinOrderUsdc(value: string | undefined) {
  const trimmed = value?.trim();
  const text = trimmed || String(DEFAULT_MIN_ORDER_USDC);

  // At most 6 decimals so the threshold is exact in USDC base units.
  const match = /^([0-9]+)(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!match) {
    throw new EscrowConfigurationError(
      "sponsor_limit_invalid",
      "MIN_ORDER_USDC must be a positive USDC amount with at most 6 decimals.",
    );
  }

  const baseUnits =
    BigInt(match[1]) * BigInt(1_000_000) +
    BigInt((match[2] ?? "").padEnd(6, "0"));
  if (baseUnits <= BigInt(0)) {
    throw new EscrowConfigurationError(
      "sponsor_limit_invalid",
      "MIN_ORDER_USDC must be greater than zero.",
    );
  }
  return baseUnits;
}

export function getSponsorLimits(
  environment: SponsorLimitsEnvironment = {
    MIN_ORDER_USDC: process.env.MIN_ORDER_USDC,
    BUYER_MAX_PENDING_ORDERS: process.env.BUYER_MAX_PENDING_ORDERS,
    BUYER_MAX_ORDERS_PER_24H: process.env.BUYER_MAX_ORDERS_PER_24H,
    SPONSOR_MIN_BALANCE_LAMPORTS: process.env.SPONSOR_MIN_BALANCE_LAMPORTS,
  },
): SponsorLimits {
  return {
    minOrderBaseUnits: parseMinOrderUsdc(environment.MIN_ORDER_USDC),
    buyerMaxPendingOrders: parsePositiveInteger(
      environment.BUYER_MAX_PENDING_ORDERS,
      DEFAULT_BUYER_MAX_PENDING_ORDERS,
      "BUYER_MAX_PENDING_ORDERS",
    ),
    buyerMaxOrdersPer24h: parsePositiveInteger(
      environment.BUYER_MAX_ORDERS_PER_24H,
      DEFAULT_BUYER_MAX_ORDERS_PER_24H,
      "BUYER_MAX_ORDERS_PER_24H",
    ),
    sponsorMinBalanceLamports: parsePositiveInteger(
      environment.SPONSOR_MIN_BALANCE_LAMPORTS,
      DEFAULT_SPONSOR_MIN_BALANCE_LAMPORTS,
      "SPONSOR_MIN_BALANCE_LAMPORTS",
    ),
  };
}
