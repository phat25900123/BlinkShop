import { NextRequest, NextResponse } from "next/server";

import { requirePrivyUser } from "@/lib/backend/auth";
import { getPrivyEmbeddedSolanaWallet } from "@/lib/backend/privy";
import { SponsoredCheckoutError } from "@/lib/backend/sponsored-checkout";
import { SolanaSponsorConfigurationError } from "@/lib/backend/solana-sponsor";
import {
  SponsoredSubmissionError,
  submitSponsoredCheckoutTransaction,
} from "@/lib/backend/sponsored-submit";
import { store } from "@/lib/backend/store";

type Context = {
  params: Promise<{ productId: string }>;
};

function errorResponse(error: string, status: number, code?: string) {
  return NextResponse.json(
    { error, ...(code ? { code } : {}) },
    { status },
  );
}

export async function POST(request: NextRequest, context: Context) {
  const authentication = await requirePrivyUser(request);
  if (!authentication.ok) return authentication.response;

  let body: Record<string, unknown>;
  try {
    const parsedBody = (await request.json()) as unknown;
    if (
      !parsedBody ||
      typeof parsedBody !== "object" ||
      Array.isArray(parsedBody)
    ) {
      return errorResponse("Invalid JSON body", 400);
    }
    body = parsedBody as Record<string, unknown>;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const allowedKeys = new Set(["orderId", "signedTransaction"]);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    return errorResponse(
      "Only the order ID and signed transaction may be submitted",
      400,
      "server_owned_payment_details",
    );
  }
  if (
    typeof body.orderId !== "string" ||
    !body.orderId.trim() ||
    typeof body.signedTransaction !== "string" ||
    !body.signedTransaction.trim()
  ) {
    return errorResponse("Order ID and signed transaction are required", 400);
  }

  let wallet: Awaited<ReturnType<typeof getPrivyEmbeddedSolanaWallet>>;
  try {
    wallet = await getPrivyEmbeddedSolanaWallet(authentication.user.userId);
  } catch {
    return errorResponse(
      "Unable to load the authenticated Privy wallet",
      502,
      "privy_user_lookup_failed",
    );
  }
  if (!wallet) {
    return errorResponse(
      "Your embedded Solana wallet is still being created. Please wait and try again.",
      409,
      "embedded_wallet_unavailable",
    );
  }

  const { productId } = await context.params;
  const product = store.getProduct(productId);
  if (!product) return errorResponse("Product not found", 404);

  const order = store.getOrder(body.orderId.trim());
  if (!order) return errorResponse("Order not found", 404);
  if (order.buyerWallet !== wallet.address) {
    return errorResponse(
      "This order belongs to another buyer wallet",
      403,
      "order_buyer_mismatch",
    );
  }
  if (
    order.productId !== productId ||
    order.merchantId !== product.merchantId ||
    order.merchantWallet !== product.merchantWallet
  ) {
    return errorResponse(
      "The order does not belong to this product",
      409,
      "order_product_mismatch",
    );
  }
  if (order.status !== "pending") {
    return errorResponse(
      "Only a pending order can be submitted",
      409,
      "order_not_pending",
    );
  }

  try {
    const result = await submitSponsoredCheckoutTransaction({
      order,
      product,
      authenticatedBuyerWallet: wallet.address,
      signedTransaction: body.signedTransaction.trim(),
    });
    return NextResponse.json({ txSignature: result.txSignature });
  } catch (error) {
    if (error instanceof SolanaSponsorConfigurationError) {
      return errorResponse(error.message, 503, error.code);
    }
    if (error instanceof SponsoredCheckoutError) {
      return errorResponse(error.message, 503, error.code);
    }
    if (error instanceof SponsoredSubmissionError) {
      const conflictCodes = new Set([
        "order_not_pending",
        "order_expired",
        "order_product_mismatch",
        "order_merchant_mismatch",
        "blockhash_expired",
      ]);
      const upstreamCodes = new Set(["fee_unavailable", "broadcast_failed"]);
      return errorResponse(
        error.message,
        conflictCodes.has(error.code)
          ? 409
          : upstreamCodes.has(error.code)
            ? 502
            : 400,
        error.code,
      );
    }

    return errorResponse(
      "Unable to submit the sponsored payment transaction",
      502,
      "sponsored_submission_failed",
    );
  }
}
