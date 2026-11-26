import { NextResponse } from "next/server";

import { prepareEscrowAction } from "@/lib/backend/escrow-actions";
import {
  actorFor,
  errorResponse,
  escrowErrorResponse,
  parseAction,
  readJsonObject,
  resolveOrderParticipant,
} from "@/lib/backend/escrow-routes";

type Context = { params: Promise<{ id: string; action: string }> };

/**
 * Prepares a sponsored escrow lifecycle transaction (ship, confirm-receipt,
 * refund, claim) for the authenticated merchant or buyer to sign. Every
 * account and the destination are derived by the server; the body carries
 * nothing.
 */
export async function POST(request: Request, context: Context) {
  const { id, action: rawAction } = await context.params;
  const action = parseAction(rawAction);
  if (!action) return errorResponse("Unknown escrow action", 404);

  const body = await readJsonObject(request);
  if (!body) return errorResponse("Invalid JSON body", 400);
  if (Object.keys(body).length > 0) {
    return errorResponse(
      "Escrow action details are determined by BlinkShop",
      400,
      "server_owned_payment_details",
    );
  }

  const participant = await resolveOrderParticipant(request, id);
  if (!participant.ok) return participant.response;

  const actor = actorFor(action, participant.roles, participant.wallet);
  if (!actor) {
    return errorResponse(
      "You are not allowed to perform this action on the order.",
      403,
      "actor_not_allowed",
    );
  }

  try {
    const prepared = await prepareEscrowAction({
      order: participant.order,
      action,
      actor,
    });
    return NextResponse.json({ ...prepared, orderId: participant.order.id });
  } catch (error) {
    return escrowErrorResponse(error);
  }
}
