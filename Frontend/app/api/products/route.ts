import { NextRequest, NextResponse } from "next/server";
import { normalizeVariants, store } from "@/lib/backend/store";

const merchantId = process.env.MERCHANT_ID || "merchant-aria-studio";

export async function GET() {
  return NextResponse.json({ products: store.listProducts() });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (typeof body.name !== "string" || !body.name.trim() || typeof body.priceUsdc !== "number" || body.priceUsdc <= 0 || !Number.isInteger(body.inventory) || body.inventory < 0) {
      return NextResponse.json({ error: "name, priceUsdc and a non-negative integer inventory are required" }, { status: 400 });
    }
    const product = store.createProduct({ merchantId, name: body.name.trim(), description: typeof body.description === "string" ? body.description : "", priceUsdc: body.priceUsdc, imageUrl: typeof body.imageUrl === "string" ? body.imageUrl : "", inventory: body.inventory, variants: normalizeVariants(body.variants) });
    return NextResponse.json({ product }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}