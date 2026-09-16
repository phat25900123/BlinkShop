import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/backend/store";
import { verifyUsdcPayment } from "@/lib/backend/solana";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.orderId !== "string" || typeof body.txSignature !== "string") return NextResponse.json({ error: "orderId and txSignature are required" }, { status: 400 });
    const order = store.getOrder(body.orderId);
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (order.status === "paid") return NextResponse.json({ order, duplicate: true });
    const existing = store.findOrderBySignature(body.txSignature);
    if (existing && existing.id !== order.id) return NextResponse.json({ error: "Transaction signature already used" }, { status: 409 });
    store.attachSignature(order.id, body.txSignature);
    const valid = await verifyUsdcPayment(body.txSignature, { buyerWallet: order.buyerWallet, amountUsdc: order.amountUsdc });
    const updated = valid ? store.markPaid(order.id) : store.markFailed(order.id);
    return valid ? NextResponse.json({ order: updated }) : NextResponse.json({ error: "Payment could not be verified", order: updated }, { status: 422 });
  } catch (error) {
    console.error("order confirmation failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Unable to confirm payment" }, { status: 502 });
  }
}