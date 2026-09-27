import { NextRequest } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { actionResponse } from "@/lib/backend/cors";
import { store } from "@/lib/backend/store";
import { verifyUsdcPayment } from "@/lib/backend/solana";

function completedAction(
  origin: string,
  product: { name: string },
  orderId: string,
  message: string,
) {
  return {
    type: "completed" as const,
    icon: `${origin}/blinkshop-icon.svg`,
    title: "BlinkShop",
    description: `${product.name} · Order ${orderId}`,
    label: "Paid",
    message,
  };
}

type Context = { params: Promise<{ id: string }> };

async function verifyWithRetry(signature: string, expected: { buyerWallet: string; amountUsdc: number }) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await verifyUsdcPayment(signature, expected);
    if (result !== "pending") return result;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return "pending" as const;
}

export async function OPTIONS() {
  return actionResponse({}, 204);
}

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const orderId = new URL(request.url).searchParams.get("orderId");
  if (!orderId) return actionResponse({ message: "orderId is required" }, 400);

  const order = store.getOrder(orderId);
  if (!order || order.productId !== id) return actionResponse({ message: "Order not found" }, 404);
  const origin = new URL(request.url).origin;

if (order.status === "cancelled") {
  return actionResponse({ message: "Order has expired" }, 409);
}

if (order.status === "failed") {
  return actionResponse(
    { message: "Order is no longer payable. Please create a new order." },
    409,
  );
}

if (order.status === "paid") {
  const product = store.getProduct(order.productId);

  if (!product) {
    return actionResponse({ message: "Product not found" }, 404);
  }

  return actionResponse(
    completedAction(
      origin,
      product,
      order.id,
      "Payment already confirmed",
    ),
  );
}

  let body: { signature?: unknown; account?: unknown };

  try {
    body = (await request.json()) as {
      signature?: unknown;
      account?: unknown;
    };
  } catch {
    return actionResponse({ message: "Invalid JSON body" }, 400);
  }

  if (typeof body.signature !== "string" || typeof body.account !== "string") {
    return actionResponse({ message: "signature and account are required" }, 400);
  }

  try {
    try {
      if (new PublicKey(body.account).toBase58() !== new PublicKey(order.buyerWallet).toBase58()) {
        return actionResponse({ message: "account does not match the order" }, 403);
      }
    } catch {
      return actionResponse({ message: "account is not a valid Solana address" }, 400);
    }

    const existing = store.findOrderBySignature(body.signature);
    if (existing && existing.id !== order.id) return actionResponse({ message: "Transaction signature already used" }, 409);
    store.attachSignature(order.id, body.signature);
    const verification = await verifyWithRetry(body.signature, { buyerWallet: order.buyerWallet, amountUsdc: order.amountUsdc });
    if (verification === "pending") {
  return actionResponse(
    {
      message: "Payment is still being confirmed. Please retry this confirmation.",
    },
    409,
  );
}

if (verification === "invalid") {
  const failedOrder = store.markFailed(order.id);

  return actionResponse(
    {
      message: "Payment could not be verified",
      order: failedOrder,
    },
    422,
  );
}

const paidOrder = store.markPaid(order.id);
const product = store.getProduct(order.productId);

if (!paidOrder || !product) {
  return actionResponse(
    {
      message: "Payment was verified but the order state could not be updated",
    },
    500,
  );
}

return actionResponse(
  completedAction(
    origin,
    product,
    paidOrder.id,
    "Payment confirmed",
  ),
);
  } catch (error) {
    console.error("Blink action confirmation failed", error instanceof Error ? error.message : "unknown error");
    return actionResponse({ message: "Payment verification is temporarily unavailable" }, 502);
  }
}
