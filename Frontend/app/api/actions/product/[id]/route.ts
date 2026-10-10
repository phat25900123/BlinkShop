import { NextRequest } from "next/server";

import { PublicKey } from "@solana/web3.js";

import { actionResponse } from "@/lib/backend/cors";
import { publicOrigin } from "@/lib/backend/app-url";

import { store } from "@/lib/backend/store";

import {
  createUsdcTransferTransaction,
  getSolanaConfig,
} from "@/lib/backend/solana";

type Context = {
  params: Promise<{
    id: string;
  }>;
};

type ActionRequestBody = {
  account?: unknown;
  quantity?: unknown;
  variant?: unknown;
};

export async function OPTIONS() {
  return actionResponse({}, 204);
}

export async function GET(
  request: NextRequest,
  context: Context,
) {
  const { id } =
    await context.params;

  const product =
    store.getProduct(id);

  if (!product) {
    return actionResponse(
      {
        message:
          "Product not found",
      },
      404,
    );
  }

  const origin = publicOrigin(request.url);

  const availableVariants =
    product.variants.filter(
      (variant) =>
        variant.inventory > 0,
    );

  const maximumQuantity =
    product.variants.length > 0
      ? Math.max(
          1,
          ...availableVariants.map(
            (variant) =>
              variant.inventory,
          ),
        )
      : Math.max(
          product.inventory,
          1,
        );

  const actionHref =
    `${origin}/api/actions/product/${product.id}` +
    `?quantity={quantity}` +
    `${
      product.variants.length > 0
        ? "&variant={variant}"
        : ""
    }`;

  const parameters = [
    ...(product.variants.length >
    0
      ? [
          {
            name: "variant",

            label:
              product
                .variants[0]
                .name,

            type: "select",

            options:
              availableVariants.map(
                (variant) => ({
                  label:
                    variant.value,

                  value:
                    variant.value,
                }),
              ),
          },
        ]
      : []),

    {
      name: "quantity",

      label: "Quantity",

      type: "number",

      min: 1,

      max: maximumQuantity,
    },
  ];

  const productIsAvailable =
    product.status ===
      "active" &&
    product.inventory > 0 &&
    (product.variants.length ===
      0 ||
      availableVariants.length >
        0);

  return actionResponse({
    type: "action",

    icon: `${origin}/blinkshop-icon.svg`,

    title: `${product.name} · ${product.priceUsdc} USDC`,

    description:
      product.description,

    label:
      productIsAvailable
        ? "Buy now"
        : "Sold out",

    disabled:
      !productIsAvailable,

    links: {
      actions: [
        {
          label:
            productIsAvailable
              ? "Buy now"
              : "Sold out",

          href: actionHref,

          type: "transaction",

          parameters,
        },
      ],
    },
  });
}

export async function POST(
  request: NextRequest,
  context: Context,
) {
  const { id } =
    await context.params;

  const product =
    store.getProduct(id);

  if (!product) {
    return actionResponse(
      {
        message:
          "Product not found",
      },
      404,
    );
  }

  if (
    product.status !== "active"
  ) {
    return actionResponse(
      {
        message:
          "Product is sold out",
      },
      409,
    );
  }

  let body: ActionRequestBody;

  try {
    body = (await request.json()) as ActionRequestBody;
  } catch {
    return actionResponse(
      { message: "Invalid JSON body" },
      400,
    );
  }

  let orderId = "";

  try {
    const url =
      new URL(request.url);

    const queryQuantity =
      url.searchParams.get(
        "quantity",
      );

    const queryVariant =
      url.searchParams.get(
        "variant",
      );

    if (
      typeof body.account !==
      "string"
    ) {
      return actionResponse(
        {
          message:
            "account is required",
        },
        400,
      );
    }

    try {
      new PublicKey(
        body.account,
      );
    } catch {
      return actionResponse(
        {
          message:
            "account is not a valid Solana address",
        },
        400,
      );
    }

    const requestedQuantity =
      queryQuantity === null
        ? body.quantity
        : Number(
            queryQuantity,
          );

    const quantity =
      typeof requestedQuantity === "number" &&
      Number.isInteger(requestedQuantity)
        ? requestedQuantity
        : 1;

    const requestedVariant =
      queryVariant ||
      (typeof body.variant ===
      "string"
        ? body.variant
        : "");

    if (
      product.variants.length >
        0 &&
      !requestedVariant
    ) {
      return actionResponse(
        {
          message:
            "A variant is required",
        },
        400,
      );
    }

    const variant =
      requestedVariant
        ? product.variants.find(
            (item) =>
              item.value ===
              requestedVariant,
          )
        : undefined;

    if (
      requestedVariant &&
      !variant
    ) {
      return actionResponse(
        {
          message:
            "Selected variant is not available",
        },
        409,
      );
    }

    if (
      variant &&
      variant.inventory <= 0
    ) {
      return actionResponse(
        {
          message:
            `Variant ${variant.value} is out of stock`,
        },
        409,
      );
    }

    if (
      quantity < 1 ||
      quantity >
        product.inventory ||
      (variant &&
        quantity >
          variant.inventory)
    ) {
      return actionResponse(
        {
          message:
            "Insufficient inventory",
        },
        409,
      );
    }

    const order =
      store.createOrder({
        productId:
          product.id,

        buyerWallet:
          body.account,

        variant:
          variant?.value,

        quantity,

        amountUsdc:
          product.priceUsdc *
          quantity,
      });

    if (!order) {
      return actionResponse(
        {
          message:
            "Insufficient inventory",
        },
        409,
      );
    }

    orderId = order.id;

    const transaction =
      await createUsdcTransferTransaction(
        body.account,
        order.merchantWallet,
        order.amountUsdc,
      );

    const callbackUrl =
      publicOrigin(request.url) +
      `/api/actions/product/${product.id}/confirm` +
      `?orderId=${encodeURIComponent(order.id)}`;

    return actionResponse({
      transaction:
        transaction.serializedTransaction,

      message:
        `Pay ${order.amountUsdc} USDC for ${product.name}`,

      orderId:
        order.id,

      links: {
        next: {
          type: "post",

          href: callbackUrl,
        },
      },

      ...(process.env.NODE_ENV !== "production"
        ? {
            serializedTransaction: transaction.serializedTransaction,
            blockhash: transaction.blockhash,
            merchantWallet: transaction.merchantWallet,
            usdcMint: transaction.usdcMint,
          }
        : {}),
    });
  } catch (error) {
    if (orderId) {
      store.markFailed(
        orderId,
      );
    }

    const message =
      error instanceof Error
        ? error.message
        : "Unable to create transaction";

    console.error(
      "action transaction failed",
      message,
    );

    const config =
      getSolanaConfig();

    const configured = Boolean(
      config.usdcMint && product.merchantWallet,
    );

    return actionResponse(
      {
        message: configured
          ? "Unable to create payment transaction"
          : "Solana payment configuration is missing",

        ...(process.env
          .NODE_ENV !==
        "production"
          ? {
              debug: message,
            }
          : {}),
      },

      configured
        ? 502
        : 503,
    );
  }
}
