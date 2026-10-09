import { NextRequest, NextResponse } from "next/server";
import { requireMerchant } from "@/lib/backend/auth";
import {
  areVariantsValid,
  normalizeVariants,
  store,
} from "@/lib/backend/store";
import type { ProductVariant } from "@/lib/backend/types";

type Context = {
  params: Promise<{ id: string }>;
};

type PatchBody = {
  name?: unknown;
  description?: unknown;
  priceUsdc?: unknown;
  imageUrl?: unknown;
  inventory?: unknown;
  status?: unknown;
  variants?: unknown;
};

type ProductUpdate = Partial<{
  name: string;
  description: string;
  priceUsdc: number;
  imageUrl: string;
  inventory: number;
  status: "active" | "inactive" | "sold_out";
  variants: ProductVariant[];
}>;

export async function GET(
  _request: NextRequest,
  context: Context,
) {
  const { id } = await context.params;

  const product = store.getProduct(id);

  if (!product) {
    return NextResponse.json(
      { error: "Product not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ product });
}

export async function PATCH(
  request: NextRequest,
  context: Context,
) {
  const authentication = await requireMerchant(request);
  if (!authentication.ok) return authentication.response;

  const { id } = await context.params;

  const currentProduct = store.getProduct(id);

  if (!currentProduct) {
    return NextResponse.json(
      { error: "Product not found" },
      { status: 404 },
    );
  }

  let body: PatchBody;

  try {
    body = (await request.json()) as PatchBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  /**
   * Inventory and variants are reserved by pending orders.
   * Changing them while orders are pending can make
   * inventory release incorrect when those orders expire.
   */
  const changesInventory =
    Number.isInteger(body.inventory) ||
    body.variants !== undefined;

  if (
    changesInventory &&
    store.hasPendingOrders(id)
  ) {
    return NextResponse.json(
      {
        error:
          "Inventory and variants cannot be changed while the product has pending orders",
      },
      { status: 409 },
    );
  }

  try {
    const input: ProductUpdate = {};

    /**
     * Basic product fields
     */
    if (typeof body.name === "string") {
      input.name = body.name.trim();
    }

    if (typeof body.description === "string") {
      input.description = body.description;
    }

    if (
      typeof body.priceUsdc === "number" &&
      Number.isFinite(body.priceUsdc) &&
      body.priceUsdc > 0
    ) {
      input.priceUsdc = body.priceUsdc;
    }

    if (typeof body.imageUrl === "string") {
      input.imageUrl = body.imageUrl;
    }

    if (
      body.status === "active" ||
      body.status === "inactive" ||
      body.status === "sold_out"
    ) {
      input.status = body.status;
    }

    /**
     * Inventory
     */
    if (
      Number.isInteger(body.inventory) &&
      Number(body.inventory) >= 0
    ) {
      input.inventory = Number(body.inventory);
    }

    /**
     * Variants
     *
     * If variants are supplied:
     * - normalize them
     * - validate uniqueness
     * - validate non-negative inventory
     * - make total product inventory equal to variant total
     */
    if (body.variants !== undefined) {
      const variants = normalizeVariants(
        body.variants,
      );

      const inventory =
        variants.length > 0
          ? variants.reduce(
              (total, variant) =>
                total + variant.inventory,
              0,
            )
          : input.inventory ??
            currentProduct.inventory;

      if (
        !areVariantsValid(
          body.variants,
          variants,
          inventory,
        )
      ) {
        return NextResponse.json(
          {
            error:
              "Variant inventory must be non-negative, unique and sum to product inventory",
          },
          { status: 400 },
        );
      }

      input.variants = variants;
      input.inventory = inventory;
    }

    /**
     * If the product already has variants,
     * manually changing product inventory must
     * still match the sum of variant inventory.
     */
    if (
      body.variants === undefined &&
      currentProduct.variants.length > 0 &&
      input.inventory !== undefined
    ) {
      const variantInventory =
        currentProduct.variants.reduce(
          (total, variant) =>
            total + variant.inventory,
          0,
        );

      if (
        input.inventory !== variantInventory
      ) {
        return NextResponse.json(
          {
            error:
              "Product inventory must equal the sum of variant inventory",
          },
          { status: 400 },
        );
      }
    }

    const updatedProduct =
      store.updateProduct(id, input);

    if (!updatedProduct) {
      return NextResponse.json(
        { error: "Product not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({
      product: updatedProduct,
    });
  } catch (error) {
    console.error(
      "Failed to update product:",
      error,
    );

    return NextResponse.json(
      { error: "Unable to update product" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  context: Context,
) {
  const authentication = await requireMerchant(request);
  if (!authentication.ok) return authentication.response;

  const { id } = await context.params;

  const result = store.deleteProduct(id);

  if (result === "pending_orders") {
    return NextResponse.json(
      {
        error:
          "Product has pending orders and cannot be deleted",
      },
      { status: 409 },
    );
  }

  if (!result) {
    return NextResponse.json(
      { error: "Product not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({
    deleted: true,
  });
}
