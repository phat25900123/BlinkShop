import "server-only";

import type { SponsorLimits } from "@/lib/backend/escrow-config";
import type { Order } from "@/lib/backend/types";

export const USDC_DECIMALS = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** USDC amount to base units, the same rounding the escrow instruction uses. */
export function usdcToBaseUnits(amountUsdc: number) {
  return BigInt(Math.round(amountUsdc * 10 ** USDC_DECIMALS));
}

export function isBelowMinimumOrder(amountUsdc: number, limits: SponsorLimits) {
  return usdcToBaseUnits(amountUsdc) < limits.minOrderBaseUnits;
}

export type BuyerLimitViolation = {
  code: "buyer_pending_limit" | "buyer_daily_limit";
  message: string;
};

/**
 * Per-buyer-wallet limits on sponsored checkouts. Every order created in the
 * last 24 hours counts, whatever its status: a reservation alone does not cost
 * the sponsor anything, but counting attempts keeps a wallet from cycling
 * reservations to probe for an ordering that does.
 */
export function checkBuyerOrderLimits(
  orders: readonly Order[],
  buyerWallet: string,
  limits: SponsorLimits,
  now = Date.now(),
): BuyerLimitViolation | null {
  const buyerOrders = orders.filter((order) => order.buyerWallet === buyerWallet);

  const pending = buyerOrders.filter(
    (order) => order.status === "pending" && Date.parse(order.expiresAt) > now,
  ).length;
  if (pending >= limits.buyerMaxPendingOrders) {
    return {
      code: "buyer_pending_limit",
      message: `You already have ${pending} pending checkouts. Complete one or wait for it to expire.`,
    };
  }

  const recent = buyerOrders.filter((order) => {
    const createdAt = Date.parse(order.createdAt);
    return Number.isFinite(createdAt) && createdAt > now - DAY_MS;
  }).length;
  if (recent >= limits.buyerMaxOrdersPer24h) {
    return {
      code: "buyer_daily_limit",
      message: "This wallet reached the daily checkout limit. Try again later.",
    };
  }

  return null;
}
