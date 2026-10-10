import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { requirePrivyUser } from "@/lib/backend/auth";
import { store } from "@/lib/backend/store";

export async function GET(request: NextRequest) {
  const authentication = await requirePrivyUser(request);
  if (!authentication.ok) return authentication.response;

  return NextResponse.json({
    orders: store.listOrdersByMerchant(authentication.user.userId),
  });
}

export async function POST(request: NextRequest) {
  const authentication = await requirePrivyUser(request);
  if (!authentication.ok) return authentication.response;

  let body: Record<string, unknown>;

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    "merchantId" in body ||
    "merchantWallet" in body ||
    "payoutWallet" in body
  ) {
    return NextResponse.json(
      { error: "Merchant identity and payout wallet are managed by BlinkShop" },
      { status: 400 },
    );
  }

  const product = typeof body.productId === "string"
    ? store.getProductOwnedBy(body.productId, authentication.user.userId)
    : undefined;
  const quantity = typeof body.quantity === "number" && Number.isInteger(body.quantity) ? body.quantity : 1;
  if (!product) return NextResponse.json({ error: "Product not found" }, { status: 404 });
  if (product.status !== "active") return NextResponse.json({ error: "Product is not available" }, { status: 409 });
  if (typeof body.buyerWallet !== "string" || !body.buyerWallet.trim()) return NextResponse.json({ error: "buyerWallet is required" }, { status: 400 });
  try { new PublicKey(body.buyerWallet); } catch { return NextResponse.json({ error: "buyerWallet is not a valid Solana address" }, { status: 400 }); }
  if (product.variants.length > 0 && (typeof body.variant !== "string" || !body.variant.trim())) {
    return NextResponse.json({ error: "A variant is required" }, { status: 400 });
  }
  const variant = typeof body.variant === "string" ? product.variants.find((item) => item.value === body.variant) : undefined;
  if (body.variant && !variant) return NextResponse.json({ error: "Selected variant is not available" }, { status: 409 });
  if (quantity < 1 || quantity > product.inventory || (variant && quantity > variant.inventory)) return NextResponse.json({ error: "Insufficient inventory" }, { status: 409 });
  const order = store.createOrder({ productId: product.id, buyerWallet: body.buyerWallet.trim(), variant: variant?.value, quantity, amountUsdc: product.priceUsdc * quantity });
  if (!order) return NextResponse.json({ error: "Insufficient inventory" }, { status: 409 });
  return NextResponse.json({ order }, { status: 201 });
}
