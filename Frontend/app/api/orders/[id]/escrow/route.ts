import { NextResponse } from "next/server";

import { syncEscrowOrderStatus } from "@/lib/backend/escrow-actions";
import {
  escrowErrorResponse,
  resolveOrderParticipant,
  toOrderView,
} from "@/lib/backend/escrow-routes";

type Context = { params: Promise<{ id: string }> };

/**
 * The order as its merchant or buyer may see it, from the store only (no
 * on-chain read). Anyone else gets 404.
 */
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  const participant = await resolveOrderParticipant(request, id);
  if (!participant.ok) return participant.response;

  return NextResponse.json({
    order: toOrderView(participant.order),
    roles: [...participant.roles],
  });
}

/**
 * Re-reads the order's escrow account on-chain and moves the stored status
 * forward to match it (paid -> shipped -> released | refunded). Only the
 * order's merchant or buyer may trigger it. Also returns the on-chain
 * deadlines so the UI can show countdowns.
 */
export async function POST(request: Request, context: Context) {
  const { id } = await context.params;
  const participant = await resolveOrderParticipant(request, id);
  if (!participant.ok) return participant.response;

  try {
    const result = await syncEscrowOrderStatus(participant.order);
    if (result.result === "invalid_transition") {
      return NextResponse.json(
        {
          error: "The on-chain escrow state cannot be applied to this order",
          code: "escrow_state_conflict",
          order: toOrderView(result.order),
        },
        { status: 409 },
      );
    }
    if (result.result === "not_found" || result.result === "not_escrow") {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    return NextResponse.json({
      order: toOrderView(result.order),
      changed: result.result === "updated",
      escrow: result.escrow,
      roles: [...participant.roles],
    });
  } catch (error) {
    return escrowErrorResponse(error);
  }
}
