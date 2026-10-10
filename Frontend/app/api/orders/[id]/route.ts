import { NextResponse } from "next/server";
import { requirePrivyUser } from "@/lib/backend/auth";
import { store } from "@/lib/backend/store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authentication = await requirePrivyUser(request);
  if (!authentication.ok) return authentication.response;

  const { id } = await context.params;
  const order = store.getOrderOwnedBy(id, authentication.user.userId);
  return order ? NextResponse.json({ order }) : NextResponse.json({ error: "Order not found" }, { status: 404 });
}
