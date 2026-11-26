import { NextResponse } from "next/server";

import { syncEscrowOrderStatus } from "@/lib/backend/escrow-actions";
import {
  escrowErrorResponse,
  resolveOrderParticipant,
} from "@/lib/backend/escrow-routes";

type Context = { params: Promise<{ id: string }> };

/**
 * Re-reads the order's escrow account on-chain and moves the stored status
 * forward to match it (paid -> shipped -> released | refunded). Only the
 * order's merchant or buyer may trigger it.
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
          order: result.order,
        },
        { status: 409 },
      );
    }
    if (result.result === "not_found" || result.result === "not_escrow") {
      return NextResponse.json({ error: "Order not found" }, { status: 404 });
    }
    return NextResponse.json({
      order: result.order,
      changed: result.result === "updated",
    });
  } catch (error) {
    return escrowErrorResponse(error);
  }
}
