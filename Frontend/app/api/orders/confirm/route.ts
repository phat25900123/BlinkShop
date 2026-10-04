import { NextRequest, NextResponse } from "next/server";
import { store } from "@/lib/backend/store";
import { verifyUsdcPayment } from "@/lib/backend/solana";

async function verifyWithRetry(signature: string, expected: { buyerWallet: string; amountUsdc: number }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await verifyUsdcPayment(signature, expected);
    if (result !== "pending") return result;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return "pending" as const;
}

export async function POST(request: NextRequest) {
  let body: { orderId?: unknown; txSignature?: unknown };

  try {
    body = (await request.json()) as {
      orderId?: unknown;
      txSignature?: unknown;
    };
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (typeof body.orderId !== "string" || typeof body.txSignature !== "string") {
    return NextResponse.json(
      { error: "orderId and txSignature are required" },
      { status: 400 },
    );
  }

  let orderId = "";
  try {
    orderId = body.orderId;
    const order = store.getOrder(orderId);
    if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (order.status === "cancelled") return NextResponse.json({ error: "Order has expired" }, { status: 409 });
    if (order.status === "failed") {
  return NextResponse.json(
    {
      error: "Order is no longer payable. Please create a new order.",
    },
    { status: 409 },
  );
    }
    if (order.txSignature && order.txSignature !== body.txSignature) {
      return NextResponse.json(
        { error: "Order already has a different transaction signature" },
        { status: 409 },
      );
    }
    if (order.status === "paid") return NextResponse.json({ order, duplicate: true });
    const existing = store.findOrderBySignature(body.txSignature);
    if (existing && existing.id !== order.id) return NextResponse.json({ error: "Transaction signature already used" }, { status: 409 });
    const verification = await verifyWithRetry(body.txSignature, { buyerWallet: order.buyerWallet, amountUsdc: order.amountUsdc });
    if (verification === "pending") return NextResponse.json({ message: "Payment is still being confirmed", order: store.getOrder(order.id) }, { status: 202 });
    if (verification === "invalid") return NextResponse.json({ error: "Payment could not be verified", order: store.getOrder(order.id) }, { status: 422 });

    const confirmation = store.confirmVerifiedPayment(order.id, body.txSignature);

    if (confirmation.result === "not_found") return NextResponse.json({ error: "Order not found" }, { status: 404 });
    if (confirmation.result === "cancelled") return NextResponse.json({ error: "Order has expired" }, { status: 409 });
    if (confirmation.result === "failed") return NextResponse.json({ error: "Order is no longer payable. Please create a new order." }, { status: 409 });
    if (confirmation.result === "signature_used") return NextResponse.json({ error: "Transaction signature already used" }, { status: 409 });
    if (confirmation.result === "signature_conflict") return NextResponse.json({ error: "Order already has a different transaction signature" }, { status: 409 });
    if (confirmation.result === "state_error") return NextResponse.json({ error: "Payment was verified but the order state could not be updated" }, { status: 500 });

    return NextResponse.json({
      order: confirmation.order,
      ...(confirmation.duplicate ? { duplicate: true } : {}),
    });
  } catch (error) {
    console.error("order confirmation failed", error instanceof Error ? error.message : "unknown error");
    return NextResponse.json({ error: "Unable to confirm payment" }, { status: 502 });
  }
}
