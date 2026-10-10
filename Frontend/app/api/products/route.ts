import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";
import { requirePrivyUser } from "@/lib/backend/auth";
import { getPrivyEmbeddedSolanaWallet } from "@/lib/backend/privy";
import { areVariantsValid, normalizeVariants, store } from "@/lib/backend/store";

export async function GET(request?: NextRequest) {
  const mine = request
    ? new URL(request.url).searchParams.get("mine") === "1"
    : false;

  if (!mine) {
    return NextResponse.json({ products: store.listProducts() });
  }

  const authentication = await requirePrivyUser(request!);
  if (!authentication.ok) return authentication.response;

  return NextResponse.json({
    products: store.listProductsByMerchant(authentication.user.userId),
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

  let wallet: Awaited<ReturnType<typeof getPrivyEmbeddedSolanaWallet>>;
  try {
    wallet = await getPrivyEmbeddedSolanaWallet(authentication.user.userId);
  } catch {
    return NextResponse.json(
      { error: "Unable to load your merchant payout wallet" },
      { status: 502 },
    );
  }

  if (!wallet) {
    return NextResponse.json(
      {
        error:
          "Your merchant wallet is still being created. Please wait and try again.",
      },
      { status: 409 },
    );
  }

  try {
    new PublicKey(wallet.address);
  } catch {
    return NextResponse.json(
      { error: "Your merchant payout wallet is not a valid Solana address" },
      { status: 502 },
    );
  }

  const product = store.createProduct({
    merchantId: authentication.user.userId,
    merchantWallet: wallet.address,
    name: body.name.trim(),
    description: typeof body.description === "string" ? body.description.trim() : "",
    priceUsdc: body.priceUsdc,
    imageUrl: typeof body.imageUrl === "string" ? body.imageUrl.trim() : "",
    inventory: body.inventory,
    variants,
  });
  return NextResponse.json({ product }, { status: 201 });
}
