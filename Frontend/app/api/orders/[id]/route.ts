import { NextResponse } from "next/server";
import { requireMerchant } from "@/lib/backend/auth";
import { store } from "@/lib/backend/store";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const authentication = await requireMerchant(request);
  if (!authentication.ok) return authentication.response;

  const { id } = await context.params;
  const order = store.getOrder(id);
  return order ? NextResponse.json({ order }) : NextResponse.json({ error: "Order not found" }, { status: 404 });
}
