import { NextRequest, NextResponse } from "next/server";
import { normalizeVariants, store } from "@/lib/backend/store";

type Context = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  const product = store.getProduct(id);
  return product ? NextResponse.json({ product }) : NextResponse.json({ error: "Product not found" }, { status: 404 });
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const current = store.getProduct(id);
  if (!current) return NextResponse.json({ error: "Product not found" }, { status: 404 });
  try {
    const body = await request.json();
    const product = store.updateProduct(id, {
      ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
      ...(typeof body.description === "string" ? { description: body.description } : {}),
      ...(typeof body.priceUsdc === "number" && body.priceUsdc > 0 ? { priceUsdc: body.priceUsdc } : {}),
      ...(typeof body.imageUrl === "string" ? { imageUrl: body.imageUrl } : {}),
      ...(Number.isInteger(body.inventory) && body.inventory >= 0 ? { inventory: body.inventory } : {}),
      ...(body.status === "active" || body.status === "inactive" || body.status === "sold_out" ? { status: body.status } : {}),
      ...(body.variants !== undefined ? { variants: normalizeVariants(body.variants) } : {}),
    });
    return NextResponse.json({ product });
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

export async function DELETE(_request: NextRequest, context: Context) {
  const { id } = await context.params;
  return store.deleteProduct(id) ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: "Product not found" }, { status: 404 });
}