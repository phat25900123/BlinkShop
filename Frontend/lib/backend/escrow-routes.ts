import "server-only";

import { NextResponse } from "next/server";

import { requirePrivyUser } from "@/lib/backend/auth";
import { isEscrowAction, type EscrowAction } from "@/lib/backend/escrow";
import { EscrowActionError, type EscrowActor } from "@/lib/backend/escrow-actions";
import { EscrowConfigurationError } from "@/lib/backend/escrow-config";
import { getPrivyEmbeddedSolanaWallet } from "@/lib/backend/privy";
import { SolanaSponsorConfigurationError } from "@/lib/backend/solana-sponsor";
import { SponsoredSubmissionError } from "@/lib/backend/sponsor-signing";
import { store } from "@/lib/backend/store";
import type { Order } from "@/lib/backend/types";
import type { OrderView } from "@/lib/escrow-ui";

export function errorResponse(error: string, status: number, code?: string) {
  return NextResponse.json({ error, ...(code ? { code } : {}) }, { status });
}

type Resolved =
  | { ok: true; order: Order; roles: Set<EscrowActor["role"]>; wallet: string }
  | { ok: false; response: Response };

/**
 * Authenticates the Privy user and resolves their relationship to the order
 * from server data only: merchant (owning DID and recorded payout wallet) and
 * or buyer (recorded buyer wallet). Strangers get 404 so order ids leak nothing.
 */
export async function resolveOrderParticipant(
  request: Request,
  orderId: string,
): Promise<Resolved> {
  const authentication = await requirePrivyUser(request);
  if (!authentication.ok) return { ok: false, response: authentication.response };

  let wallet: Awaited<ReturnType<typeof getPrivyEmbeddedSolanaWallet>>;
  try {
    wallet = await getPrivyEmbeddedSolanaWallet(authentication.user.userId);
  } catch {
    return {
      ok: false,
      response: errorResponse(
        "Unable to load the authenticated Privy wallet",
        502,
        "privy_user_lookup_failed",
      ),
    };
  }
  if (!wallet) {
    return {
      ok: false,
      response: errorResponse(
        "Your embedded Solana wallet is still being created. Please wait and try again.",
        409,
        "embedded_wallet_unavailable",
      ),
    };
  }

  const order = store.getOrder(orderId);
  const roles = new Set<EscrowActor["role"]>();
  if (order) {
    if (
      order.merchantId === authentication.user.userId &&
      order.merchantWallet === wallet.address
    ) {
      roles.add("merchant");
    }
    if (order.buyerWallet === wallet.address) roles.add("buyer");
  }
  if (!order || roles.size === 0) {
    return { ok: false, response: errorResponse("Order not found", 404) };
  }

  return { ok: true, order, roles, wallet: wallet.address };
}

const ACTION_ROLE_PREFERENCE: Record<EscrowAction, EscrowActor["role"][]> = {
  ship: ["merchant"],
  "confirm-receipt": ["buyer"],
  // The merchant may cancel any time; a buyer only after the ship window.
  refund: ["merchant", "buyer"],
  claim: ["merchant"],
};

export function actorFor(
  action: EscrowAction,
  roles: Set<EscrowActor["role"]>,
  wallet: string,
): EscrowActor | null {
  const role = ACTION_ROLE_PREFERENCE[action].find((item) => roles.has(item));
  return role ? { role, wallet } : null;
}

export function parseAction(value: string): EscrowAction | null {
  return isEscrowAction(value) ? value : null;
}

export async function readJsonObject(request: Request) {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

const ESCROW_ACTION_STATUS: Record<EscrowActionError["code"], number> = {
  order_not_escrow: 409,
  order_status_invalid: 409,
  actor_not_allowed: 403,
  actor_wallet_mismatch: 403,
  escrow_account_missing: 409,
  escrow_account_invalid: 409,
  escrow_state_mismatch: 409,
  window_not_elapsed: 409,
  destination_token_missing: 409,
  action_not_prepared: 409,
};

const SUBMISSION_CONFLICTS = new Set([
  "transaction_message_mismatch",
  "blockhash_expired",
]);
const SUBMISSION_UPSTREAM = new Set([
  "fee_unavailable",
  "sponsor_balance_unavailable",
  "broadcast_failed",
]);

export function escrowErrorResponse(error: unknown) {
  if (
    error instanceof SolanaSponsorConfigurationError ||
    error instanceof EscrowConfigurationError
  ) {
    return errorResponse(error.message, 503, error.code);
  }
  if (error instanceof EscrowActionError) {
    return errorResponse(error.message, ESCROW_ACTION_STATUS[error.code], error.code);
  }
  if (error instanceof SponsoredSubmissionError) {
    const status =
      error.code === "sponsor_balance_low"
        ? 503
        : SUBMISSION_CONFLICTS.has(error.code)
          ? 409
          : SUBMISSION_UPSTREAM.has(error.code)
            ? 502
            : 400;
    return errorResponse(error.message, status, error.code);
  }

  console.error(
    "escrow action failed",
    error instanceof Error ? error.message : "unknown error",
  );
  return errorResponse("Unable to process the escrow action", 502, "escrow_action_failed");
}

/**
 * The fields the order's merchant and buyer may see. Leaves out the merchant
 * DID, the prepared-action binding and the sponsored message hash.
 */
export function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    productId: order.productId,
    productName: store.getProduct(order.productId)?.name ?? "Product",
    variant: order.variant,
    quantity: order.quantity,
    amountUsdc: order.amountUsdc,
    status: order.status,
    settlement: order.settlement,
    sponsored: order.sponsored,
    buyerWallet: order.buyerWallet,
    merchantWallet: order.merchantWallet,
    txSignature: order.txSignature,
    escrowActionSignature: order.escrowActionSignature,
    createdAt: order.createdAt,
    shippedAt: order.shippedAt,
    releasedAt: order.releasedAt,
    refundedAt: order.refundedAt,
  };
}
