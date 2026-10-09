import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend/privy", () => {
  class PrivyConfigurationError extends Error {}

  return {
    PrivyConfigurationError,
    verifyPrivyAccessToken: vi.fn(async (token: string) => {
      if (token === "merchant-token") {
        return { userId: "did:privy:merchant" };
      }

      if (token === "user-token") {
        return { userId: "did:privy:user" };
      }

      throw new Error("Invalid access token");
    }),
  };
});

vi.mock("../lib/backend/solana", () => ({
  createUsdcTransferTransaction: vi.fn(async () => ({
    serializedTransaction: "base64-transaction",
    blockhash: "blockhash",
    merchantWallet: "merchant-wallet",
    usdcMint: "usdc-mint",
  })),
  getSolanaConfig: () => ({
    usdcMint: "usdc-mint",
    merchantWallet: "merchant-wallet",
  }),
  verifyUsdcPayment: vi.fn(async () => "valid"),
}));

import { GET as getProducts, POST as createProduct } from "../app/api/products/route";
import {
  DELETE as deleteProduct,
  GET as getProduct,
  PATCH as updateProduct,
} from "../app/api/products/[id]/route";
import { GET as getOrders, POST as createOrder } from "../app/api/orders/route";
import { GET as getOrder } from "../app/api/orders/[id]/route";
import { POST as confirmOrder } from "../app/api/orders/confirm/route";
import {
  GET as getProductAction,
  POST as createProductAction,
} from "../app/api/actions/product/[id]/route";
import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

const buyerWallet = "11111111111111111111111111111111";
const merchantHeader = { Authorization: "Bearer merchant-token" };

function request(
  url: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
  } = {},
) {
  const headers = new Headers();
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body) headers.set("Content-Type", "application/json");

  return new NextRequest(url, {
    method: options.method,
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

const productContext = (id = "product-1") => ({
  params: Promise.resolve({ id }),
});

describe("merchant API authentication", () => {
  beforeEach(() => {
    resetStore();
    vi.stubEnv("PRIVY_MERCHANT_USER_ID", "did:privy:merchant");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 when product creation has no token", async () => {
    const response = await createProduct(
      request("http://localhost/api/products", {
        method: "POST",
        body: { name: "Blocked", priceUsdc: 1, inventory: 4 },
      }),
    );

    expect(response.status).toBe(401);
    expect(store.listProducts()).toHaveLength(0);
  });

  it("returns 401 before an unauthenticated product update can mutate state", async () => {
    const product = addProduct();
    const response = await updateProduct(
      request(`http://localhost/api/products/${product.id}`, {
        method: "PATCH",
        body: { name: "Mutated" },
      }),
      productContext(product.id),
    );

    expect(response.status).toBe(401);
    expect(store.getProduct(product.id)?.name).toBe("Test product");
  });

  it("returns 401 before an unauthenticated product delete can mutate state", async () => {
    const product = addProduct();
    const response = await deleteProduct(
      request(`http://localhost/api/products/${product.id}`, { method: "DELETE" }),
      productContext(product.id),
    );

    expect(response.status).toBe(401);
    expect(store.getProduct(product.id)).toBeDefined();
  });

  it("returns 401 for the complete order list without a token", async () => {
    expect((await getOrders(request("http://localhost/api/orders"))).status).toBe(401);
  });

  it("returns 401 for an invalid access token", async () => {
    const response = await getOrders(
      request("http://localhost/api/orders", { token: "invalid-token" }),
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ["create product", () => createProduct(request("http://localhost/api/products", { method: "POST", token: "user-token", body: { name: "No", priceUsdc: 1, inventory: 1 } }))],
    ["update product", () => updateProduct(request("http://localhost/api/products/product-1", { method: "PATCH", token: "user-token", body: { name: "No" } }), productContext())],
    ["delete product", () => deleteProduct(request("http://localhost/api/products/product-1", { method: "DELETE", token: "user-token" }), productContext())],
    ["list orders", () => getOrders(request("http://localhost/api/orders", { token: "user-token" }))],
    ["create a manual order", () => createOrder(request("http://localhost/api/orders", { method: "POST", token: "user-token", body: { productId: "product-1", buyerWallet } }))],
  ])("returns 403 when a non-merchant tries to %s", async (_label, callRoute) => {
    addProduct();
    expect((await callRoute()).status).toBe(403);
  });

  it("allows the configured merchant to manage products and list orders", async () => {
    const createResponse = await createProduct(
      new NextRequest("http://localhost/api/products", {
        method: "POST",
        headers: { ...merchantHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Merchant product", priceUsdc: 2, inventory: 3 }),
      }),
    );
    const created = (await createResponse.json()) as { product: { id: string } };

    const updateResponse = await updateProduct(
      new NextRequest(`http://localhost/api/products/${created.product.id}`, {
        method: "PATCH",
        headers: { ...merchantHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Updated product" }),
      }),
      productContext(created.product.id),
    );

    expect(createResponse.status).toBe(201);
    expect(updateResponse.status).toBe(200);
    expect((await getOrders(new NextRequest("http://localhost/api/orders", { headers: merchantHeader }))).status).toBe(200);
    expect((await deleteProduct(new NextRequest(`http://localhost/api/products/${created.product.id}`, { method: "DELETE", headers: merchantHeader }), productContext(created.product.id))).status).toBe(200);
  });

  it("keeps public product discovery accessible without a token", async () => {
    const product = addProduct();

    expect((await getProducts()).status).toBe(200);
    expect((await getProduct(request(`http://localhost/api/products/${product.id}`), productContext(product.id))).status).toBe(200);
  });

  it("keeps the buyer Action GET public", async () => {
    const product = addProduct();
    const response = await getProductAction(
      request(`http://localhost/api/actions/product/${product.id}`),
      productContext(product.id),
    );

    expect(response.status).toBe(200);
  });

  it("keeps buyer Action transaction creation public and functional", async () => {
    const product = addProduct({ inventory: 2 });
    const response = await createProductAction(
      request(`http://localhost/api/actions/product/${product.id}?quantity=1`, {
        method: "POST",
        body: { account: buyerWallet },
      }),
      productContext(product.id),
    );
    const body = (await response.json()) as { transaction?: string; orderId?: string };

    expect(response.status).toBe(200);
    expect(body.transaction).toBe("base64-transaction");
    expect(body.orderId).toBeTruthy();
    expect(store.getProduct(product.id)?.inventory).toBe(1);
  });

  it("keeps payment confirmation public", async () => {
    const response = await confirmOrder(
      request("http://localhost/api/orders/confirm", {
        method: "POST",
        body: {},
      }),
    );

    expect(response.status).toBe(400);
  });

  it("does not let anonymous POST /api/orders reserve inventory", async () => {
    const product = addProduct({ inventory: 5 });
    const response = await createOrder(
      request("http://localhost/api/orders", {
        method: "POST",
        body: { productId: product.id, buyerWallet, quantity: 2 },
      }),
    );

    expect(response.status).toBe(401);
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("protects individual buyer order details from anonymous enumeration", async () => {
    const product = addProduct();
    const order = store.createOrder({
      productId: product.id,
      merchantId: product.merchantId,
      buyerWallet,
      quantity: 1,
      amountUsdc: product.priceUsdc,
    });

    const response = await getOrder(
      request(`http://localhost/api/orders/${order?.id}`),
      { params: Promise.resolve({ id: order?.id || "missing" }) },
    );

    expect(response.status).toBe(401);
  });
});
