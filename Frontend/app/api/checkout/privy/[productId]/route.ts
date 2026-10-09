import { NextRequest, NextResponse } from "next/server";

import { requirePrivyUser } from "@/lib/backend/auth";
import { getPrivyEmbeddedSolanaWallet } from "@/lib/backend/privy";
import {
  createSponsoredUsdcTransferTransaction,
  SponsoredCheckoutError,
} from "@/lib/backend/sponsored-checkout";
import { SolanaSponsorConfigurationError } from "@/lib/backend/solana-sponsor";
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

  if (
    "buyerWallet" in body ||
    "wallet" in body ||
    "account" in body ||
    "amountUsdc" in body ||
    "merchantWallet" in body
  ) {
    return errorResponse(
      "Wallet and payment details are determined by BlinkShop",
      400,
      "server_owned_payment_details",
    );
  }

  const { productId } = await context.params;
  const product = store.getProduct(productId);

  if (!product) return errorResponse("Product not found", 404);
  if (product.status !== "active") {
    return errorResponse("Product is not available", 409);
  }

  const quantity =
    typeof body.quantity === "number" && Number.isInteger(body.quantity)
      ? body.quantity
      : 1;
  const requestedVariant =
    typeof body.variant === "string" ? body.variant.trim() : "";

  if (product.variants.length > 0 && !requestedVariant) {
    return errorResponse("A variant is required", 400);
  }

  const variant = requestedVariant
    ? product.variants.find((item) => item.value === requestedVariant)
    : undefined;

  if (requestedVariant && !variant) {
    return errorResponse("Selected variant is not available", 409);
  }

  if (
    quantity < 1 ||
    quantity > product.inventory ||
    (variant && quantity > variant.inventory)
  ) {
    return errorResponse("Insufficient inventory", 409);
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

  const existingPendingOrder = store
    .listOrders()
    .find(
      (order) =>
        order.status === "pending" &&
        order.productId === product.id &&
        order.buyerWallet === wallet.address,
    );

  if (existingPendingOrder) {
    return errorResponse(
      "A pending checkout already reserves this product for your wallet. Complete it or wait for it to expire.",
      409,
      "pending_checkout_exists",
    );
  }

  const order = store.createOrder({
    productId: product.id,
    merchantId: product.merchantId,
    buyerWallet: wallet.address,
    variant: variant?.value,
    quantity,
    amountUsdc: product.priceUsdc * quantity,
  });

  if (!order) return errorResponse("Insufficient inventory", 409);

  try {
    const transaction = await createSponsoredUsdcTransferTransaction(
      wallet.address,
      order.amountUsdc,
    );
    const boundOrder = store.bindSponsoredTransaction(
      order.id,
      transaction.messageHash,
    );
    if (!boundOrder) {
      store.markFailed(order.id);
      return errorResponse(
        "Unable to bind the sponsored transaction to the pending order",
        409,
        "transaction_binding_failed",
      );
    }

    return NextResponse.json({
      transaction: transaction.serializedTransaction,
      orderId: order.id,
      buyerWallet: transaction.buyerWallet,
      amountUsdc: order.amountUsdc,
    });
  } catch (error) {
    store.markFailed(order.id);

    if (error instanceof SolanaSponsorConfigurationError) {
      return errorResponse(error.message, 503, error.code);
    }

    if (error instanceof SponsoredCheckoutError) {
      const status =
        error.code === "buyer_usdc_account_missing" ? 409 : 503;
      return errorResponse(error.message, status, error.code);
    }

    return errorResponse(
      "Unable to prepare the sponsored payment transaction",
      502,
      "transaction_preparation_failed",
    );
  }
}
