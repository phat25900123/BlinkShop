import { NextResponse } from "next/server";

import { submitEscrowAction } from "@/lib/backend/escrow-actions";
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
 * Accepts the signer's copy of a prepared escrow lifecycle transaction. The
 * sponsor co-signs only after the exact-instruction and message-hash checks.
 * The store is NOT updated here; it follows verified on-chain state via the
 * escrow sync route.
 */
export async function POST(request: Request, context: Context) {
  const { id, action: rawAction } = await context.params;
  const action = parseAction(rawAction);
  if (!action) return errorResponse("Unknown escrow action", 404);

  const body = await readJsonObject(request);
  if (!body) return errorResponse("Invalid JSON body", 400);
  if (Object.keys(body).some((key) => key !== "signedTransaction")) {
    return errorResponse(
      "Only the signed transaction may be submitted",
      400,
      "server_owned_payment_details",
    );
  }
  if (typeof body.signedTransaction !== "string" || !body.signedTransaction.trim()) {
    return errorResponse("A signed transaction is required", 400);
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
    const result = await submitEscrowAction({
      order: participant.order,
      action,
      actor,
      signedTransaction: body.signedTransaction.trim(),
    });
    return NextResponse.json({ txSignature: result.txSignature });
  } catch (error) {
    return escrowErrorResponse(error);
  }
}
