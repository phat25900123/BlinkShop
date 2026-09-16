import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { actionResponse } from "@/lib/backend/cors";
import { store } from "@/lib/backend/store";
import { createUsdcTransferTransaction, getSolanaConfig } from "@/lib/backend/solana";

type Context = { params: Promise<{ id: string }> };

export async function OPTIONS() {
  return actionResponse({}, 204);
}

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const product = store.getProduct(id);
  if (!product) return actionResponse({ error: "Product not found" }, 404);
  return actionResponse({
    type: "action",
    icon: product.imageUrl,
    title: `${product.name} · ${product.priceUsdc} USDC`,
    description: product.description,
    label: product.status === "active" ? "Buy now" : "Sold out",
    disabled: product.status !== "active",
    links: { actions: [{ label: "Buy now", href: `/api/actions/product/${product.id}`, type: "transaction" }] },
  });
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const product = store.getProduct(id);
  if (!product) return actionResponse({ error: "Product not found" }, 404);
  if (product.status !== "active") return actionResponse({ error: "Product is sold out" }, 409);
  try {
    const body = await request.json();
    if (typeof body.account !== "string") return actionResponse({ error: "account is required" }, 400);
    new PublicKey(body.account);
    const quantity = Number.isInteger(body.quantity) ? body.quantity : 1;
    if (quantity < 1 || quantity > product.inventory) return actionResponse({ error: "Insufficient inventory" }, 409);
    const variant = typeof body.variant === "string" ? product.variants.find((item) => item.value === body.variant) : undefined;
    if (body.variant && !variant) return actionResponse({ error: "Selected variant is not available" }, 409);
    const order = store.createOrder({ productId: product.id, merchantId: product.merchantId, buyerWallet: body.account, variant: variant?.value, quantity, amountUsdc: product.priceUsdc * quantity });
    const transaction = await createUsdcTransferTransaction(body.account, order.amountUsdc);
    return actionResponse({ transaction: transaction.serializedTransaction, message: `Pay ${order.amountUsdc} USDC for ${product.name}`, orderId: order.id, ...transaction });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create transaction";
    console.error("action transaction failed", message);
    const configured = Boolean(getSolanaConfig().usdcMint && getSolanaConfig().merchantWallet);
    return actionResponse({ error: configured ? "Unable to create payment transaction" : "Solana payment configuration is missing" }, configured ? 502 : 503);
  }
}