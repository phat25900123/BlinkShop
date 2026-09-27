import { NextRequest, NextResponse } from "next/server";
import { areVariantsValid, normalizeVariants, store } from "@/lib/backend/store";

const merchantId = process.env.MERCHANT_ID || "merchant-aria-studio";

export async function GET() {
  return NextResponse.json({ products: store.listProducts() });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;

  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    typeof body.name !== "string" ||
    !body.name.trim() ||
    typeof body.priceUsdc !== "number" ||
    !Number.isFinite(body.priceUsdc) ||
    body.priceUsdc <= 0 ||
    typeof body.inventory !== "number" ||
    !Number.isInteger(body.inventory) ||
    body.inventory < 0
  ) {
    return NextResponse.json(
      { error: "Name, a positive USDC price, and non-negative inventory are required" },
      { status: 400 },
    );
  }

  const variants = normalizeVariants(body.variants);
  if (Array.isArray(body.variants) && !areVariantsValid(body.variants, variants, body.inventory)) {
    return NextResponse.json(
      { error: "Variant inventory must be non-negative, unique, and match total inventory" },
      { status: 400 },
    );
  }

  const product = store.createProduct({
    merchantId,
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description.trim() : "",
    priceUsdc: body.priceUsdc,
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl.trim() : "",
    inventory: body.inventory,
    variants,
  });
  return NextResponse.json({ product }, { status: 201 });
}
