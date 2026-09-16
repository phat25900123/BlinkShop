import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { store } from "@/lib/backend/store";

export async function GET() {
  return NextResponse.json({ orders: store.listOrders() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const product = typeof body.productId === "string" ? store.getProduct(body.productId) : undefined;
    const quantity = Number.isInteger(body.quantity) ? body.quantity : 1;
    if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
    if (product.status !== "active") return NextResponse.json({ error: "Product is not available" }, { status: 409 });
    if (typeof body.buyerWallet !== "string" || !body.buyerWallet.trim()) return NextResponse.json({ error: "buyerWallet is required" }, { status: 400 });
    try { new PublicKey(body.buyerWallet); } catch { return NextResponse.json({ error: "buyerWallet is not a valid Solana address" }, { status: 400 }); }
    if (quantity < 1 || quantity > product.inventory) return NextResponse.json({ error: "Insufficient inventory" }, { status: 409 });
    const variant = typeof body.variant === "string" ? product.variants.find((item) => item.value === body.variant) : undefined;
    if (body.variant && !variant) return NextResponse.json({ error: "Selected variant is not available" }, { status: 409 });
    const order = store.createOrder({ productId: product.id, merchantId: product.merchantId, buyerWallet: body.buyerWallet.trim(), variant: variant?.value, quantity, amountUsdc: product.priceUsdc * quantity });
    return NextResponse.json({ order }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}