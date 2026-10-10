import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend/privy", () => {
  class PrivyConfigurationError extends Error {}

  return {
    PrivyConfigurationError,
    verifyPrivyAccessToken: vi.fn(async (token: string) => {
      if (token === "merchant-a-token") {
        return { userId: "did:privy:merchant-a" };
      }
      if (token === "merchant-b-token") {
        return { userId: "did:privy:merchant-b" };
      }
      if (token === "configuration-error") {
        throw new PrivyConfigurationError();
      }

      throw new Error("Invalid access token");
    }),
    getPrivyEmbeddedSolanaWallet: vi.fn(async (userId: string) => {
      if (userId === "did:privy:merchant-a") {
        return {
          address: "11111111111111111111111111111111",
          walletId: "wallet-a",
        };
      }
      if (userId === "did:privy:merchant-b") {
        return {
          address: "Vote111111111111111111111111111111111111111",
          walletId: "wallet-b",
        };
      }

      return null;
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
    merchantWallet: "legacy-wallet",
  }),
  verifyUsdcPayment: vi.fn(async () => "valid"),
}));

import {
  GET as getProducts,
  POST as createProduct,
} from "../app/api/products/route";
import {
  DELETE as deleteProduct,
  GET as getProduct,
  PATCH as updateProduct,
} from "../app/api/products/[id]/route";
import {
  GET as getOrders,
  POST as createOrder,
} from "../app/api/orders/route";
import { GET as getOrder } from "../app/api/orders/[id]/route";
import { POST as confirmOrder } from "../app/api/orders/confirm/route";
import {
  GET as getProductAction,
  POST as createProductAction,
} from "../app/api/actions/product/[id]/route";
import { getPrivyEmbeddedSolanaWallet } from "../lib/backend/privy";
import { createUsdcTransferTransaction } from "../lib/backend/solana";
import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

const buyerWallet = "11111111111111111111111111111111";
const walletA = "11111111111111111111111111111111";
const walletB = "Vote111111111111111111111111111111111111111";
const merchantA = "did:privy:merchant-a";
const merchantB = "did:privy:merchant-b";

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

const productBody = (name = "Merchant product") => ({
  name,
  priceUsdc: 0.3,
  inventory: 3,
  description: "A test product",
  imageUrl: "https://example.com/product.jpg",
  variants: [],
});

async function createFor(token: string, name: string) {
  const response = await createProduct(
    request("http://localhost/api/products", {
      method: "POST",
      token,
      body: productBody(name),
    }),
  );
  const data = (await response.json()) as {
    product?: { id: string; merchantId: string; merchantWallet: string };
    error?: string;
  };

  return { response, data };
}

describe("self-service merchant authentication and isolation", () => {
  beforeEach(() => {
    resetStore();
    vi.stubEnv("PRIVY_MERCHANT_USER_ID", "did:privy:someone-else");
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 before unauthenticated product creation can mutate state", async () => {
    const response = await createProduct(
      request("http://localhost/api/products", {
        method: "POST",
        body: productBody(),
      }),
    );

    expect(response.status).toBe(401);
    expect(store.listProducts()).toHaveLength(0);
  });

  it("returns 401 for an invalid access token", async () => {
    const response = await getOrders(
      request("http://localhost/api/orders", { token: "invalid-token" }),
    );

    expect(response.status).toBe(401);
  });

  it("returns a controlled 503 when Privy server configuration is unavailable", async () => {
    const response = await getOrders(
      request("http://localhost/api/orders", {
        token: "configuration-error",
      }),
    );

    expect(response.status).toBe(503);
  });

  it.each(["merchant-a-token", "merchant-b-token"])(
    "allows authenticated user %s to open a merchant workspace without an allowlist match",
    async (token) => {
      const response = await getProducts(
        request("http://localhost/api/products?mine=1", { token }),
      );
      const data = (await response.json()) as { products: unknown[] };

      expect(response.status).toBe(200);
      expect(data.products).toEqual([]);
    },
  );

  it("binds a new product to merchant A's verified DID and embedded wallet", async () => {
    const { response, data } = await createFor(
      "merchant-a-token",
      "Product A",
    );

    expect(response.status).toBe(201);
    expect(data.product).toMatchObject({
      merchantId: merchantA,
      merchantWallet: walletA,
    });
    expect(getPrivyEmbeddedSolanaWallet).toHaveBeenCalledWith(merchantA);
  });

  it.each(["merchantId", "merchantWallet", "payoutWallet"])(
    "rejects browser-supplied server-owned product field %s",
    async (field) => {
      const response = await createProduct(
        request("http://localhost/api/products", {
          method: "POST",
          token: "merchant-a-token",
          body: { ...productBody(), [field]: walletB },
        }),
      );

      expect(response.status).toBe(400);
      expect(store.listProducts()).toHaveLength(0);
    },
  );

  it("returns 409 while a merchant embedded wallet is still provisioning", async () => {
    vi.mocked(getPrivyEmbeddedSolanaWallet).mockResolvedValueOnce(null);
    const { response } = await createFor("merchant-a-token", "Waiting");

    expect(response.status).toBe(409);
    expect(store.listProducts()).toHaveLength(0);
  });

  it("isolates private product lists while keeping public discovery available", async () => {
    const productA = (await createFor("merchant-a-token", "Product A")).data
      .product!;
    const productB = (await createFor("merchant-b-token", "Product B")).data
      .product!;

    const [mineA, mineB, publicResponse] = await Promise.all([
      getProducts(
        request("http://localhost/api/products?mine=1", {
          token: "merchant-a-token",
        }),
      ),
      getProducts(
        request("http://localhost/api/products?mine=1", {
          token: "merchant-b-token",
        }),
      ),
      getProducts(),
    ]);
    const dataA = (await mineA.json()) as { products: { id: string }[] };
    const dataB = (await mineB.json()) as { products: { id: string }[] };
    const publicData = (await publicResponse.json()) as {
      products: { id: string }[];
    };

    expect(dataA.products.map((product) => product.id)).toEqual([productA.id]);
    expect(dataB.products.map((product) => product.id)).toEqual([productB.id]);
    expect(publicData.products.map((product) => product.id)).toEqual(
      expect.arrayContaining([productA.id, productB.id]),
    );
  });

  it("does not silently expose public products for an invalid private-list token", async () => {
    addProduct();
    const response = await getProducts(
      request("http://localhost/api/products?mine=1", {
        token: "invalid-token",
      }),
    );

    expect(response.status).toBe(401);
  });

  it.each(["PATCH", "DELETE"])(
    "prevents merchant A from using %s on merchant B's product",
    async (method) => {
      const product = addProduct({
        merchantId: merchantB,
        merchantWallet: walletB,
      });
      const response =
        method === "PATCH"
          ? await updateProduct(
              request(`http://localhost/api/products/${product.id}`, {
                method,
                token: "merchant-a-token",
                body: { name: "Stolen" },
              }),
              productContext(product.id),
            )
          : await deleteProduct(
              request(`http://localhost/api/products/${product.id}`, {
                method,
                token: "merchant-a-token",
              }),
              productContext(product.id),
            );

      expect(response.status).toBe(404);
      expect(store.getProduct(product.id)?.name).toBe("Test product");
    },
  );

  it.each(["merchantId", "merchantWallet", "payoutWallet"])(
    "prevents PATCH from changing server-owned field %s",
    async (field) => {
      const product = addProduct({
        merchantId: merchantA,
        merchantWallet: walletA,
      });
      const response = await updateProduct(
        request(`http://localhost/api/products/${product.id}`, {
          method: "PATCH",
          token: "merchant-a-token",
          body: { [field]: walletB },
        }),
        productContext(product.id),
      );

      expect(response.status).toBe(400);
      expect(store.getProduct(product.id)).toMatchObject({
        merchantId: merchantA,
        merchantWallet: walletA,
      });
    },
  );

  it("allows each merchant to edit and delete only their own product", async () => {
    const productA = (await createFor("merchant-a-token", "Product A")).data
      .product!;
    const updateResponse = await updateProduct(
      request(`http://localhost/api/products/${productA.id}`, {
        method: "PATCH",
        token: "merchant-a-token",
        body: { name: "Updated A" },
      }),
      productContext(productA.id),
    );
    const deleteResponse = await deleteProduct(
      request(`http://localhost/api/products/${productA.id}`, {
        method: "DELETE",
        token: "merchant-a-token",
      }),
      productContext(productA.id),
    );

    expect(updateResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
  });

  it("snapshots product merchant identity and payout wallet into an order", () => {
    const product = addProduct({
      merchantId: merchantA,
      merchantWallet: walletA,
    });
    const order = store.createOrder({
      productId: product.id,
      buyerWallet,
      quantity: 1,
      amountUsdc: product.priceUsdc,
    });

    expect(order).toMatchObject({
      merchantId: merchantA,
      merchantWallet: walletA,
    });
  });

  it("isolates merchant order lists and protected order details", async () => {
    const productA = addProduct({
      id: "product-a",
      merchantId: merchantA,
      merchantWallet: walletA,
    });
    const productB = addProduct({
      id: "product-b",
      merchantId: merchantB,
      merchantWallet: walletB,
    });
    const orderA = store.createOrder({
      productId: productA.id,
      buyerWallet,
      quantity: 1,
      amountUsdc: productA.priceUsdc,
    })!;
    const orderB = store.createOrder({
      productId: productB.id,
      buyerWallet,
      quantity: 1,
      amountUsdc: productB.priceUsdc,
    })!;

    const [responseA, responseB, forbiddenDetail] = await Promise.all([
      getOrders(
        request("http://localhost/api/orders", {
          token: "merchant-a-token",
        }),
      ),
      getOrders(
        request("http://localhost/api/orders", {
          token: "merchant-b-token",
        }),
      ),
      getOrder(
        request(`http://localhost/api/orders/${orderB.id}`, {
          token: "merchant-a-token",
        }),
        { params: Promise.resolve({ id: orderB.id }) },
      ),
    ]);
    const dataA = (await responseA.json()) as { orders: { id: string }[] };
    const dataB = (await responseB.json()) as { orders: { id: string }[] };

    expect(dataA.orders.map((order) => order.id)).toEqual([orderA.id]);
    expect(dataB.orders.map((order) => order.id)).toEqual([orderB.id]);
    expect(forbiddenDetail.status).toBe(404);
  });

  it("requires authentication before listing orders or reading one order", async () => {
    const product = addProduct();
    const order = store.createOrder({
      productId: product.id,
      buyerWallet,
      quantity: 1,
      amountUsdc: product.priceUsdc,
    })!;

    expect(
      (await getOrders(request("http://localhost/api/orders"))).status,
    ).toBe(401);
    expect(
      (
        await getOrder(request(`http://localhost/api/orders/${order.id}`), {
          params: Promise.resolve({ id: order.id }),
        })
      ).status,
    ).toBe(401);
  });

  it("does not let a merchant manually reserve another merchant's product", async () => {
    const product = addProduct({
      merchantId: merchantB,
      merchantWallet: walletB,
    });
    const response = await createOrder(
      request("http://localhost/api/orders", {
        method: "POST",
        token: "merchant-a-token",
        body: { productId: product.id, buyerWallet },
      }),
    );

    expect(response.status).toBe(404);
    expect(store.getProduct(product.id)?.inventory).toBe(5);
  });

  it("manual order creation snapshots the owned product payout and rejects overrides", async () => {
    const product = addProduct({
      merchantId: merchantA,
      merchantWallet: walletA,
    });
    const blocked = await createOrder(
      request("http://localhost/api/orders", {
        method: "POST",
        token: "merchant-a-token",
        body: {
          productId: product.id,
          buyerWallet,
          merchantWallet: walletB,
        },
      }),
    );
    const allowed = await createOrder(
      request("http://localhost/api/orders", {
        method: "POST",
        token: "merchant-a-token",
        body: { productId: product.id, buyerWallet },
      }),
    );
    const data = (await allowed.json()) as {
      order: { merchantId: string; merchantWallet: string };
    };

    expect(blocked.status).toBe(400);
    expect(allowed.status).toBe(201);
    expect(data.order).toMatchObject({
      merchantId: merchantA,
      merchantWallet: walletA,
    });
  });

  it("keeps public product detail, Action GET, Action POST, and confirmation entry points available", async () => {
    const product = addProduct({ inventory: 2 });
    const [detail, action] = await Promise.all([
      getProduct(
        request(`http://localhost/api/products/${product.id}`),
        productContext(product.id),
      ),
      getProductAction(
        request(`http://localhost/api/actions/product/${product.id}`),
        productContext(product.id),
      ),
    ]);
    const actionPost = await createProductAction(
      request(`http://localhost/api/actions/product/${product.id}?quantity=1`, {
        method: "POST",
        body: { account: buyerWallet },
      }),
      productContext(product.id),
    );
    const confirmation = await confirmOrder(
      request("http://localhost/api/orders/confirm", {
        method: "POST",
        body: {},
      }),
    );

    expect(detail.status).toBe(200);
    expect(action.status).toBe(200);
    expect(actionPost.status).toBe(200);
    expect(createUsdcTransferTransaction).toHaveBeenCalledWith(
      buyerWallet,
      product.merchantWallet,
      product.priceUsdc,
    );
    expect(confirmation.status).toBe(400);
  });

  it("does not let an Action request override the product merchant wallet", async () => {
    const product = addProduct({
      merchantId: merchantA,
      merchantWallet: walletA,
      inventory: 2,
    });
    const response = await createProductAction(
      request(`http://localhost/api/actions/product/${product.id}?quantity=1`, {
        method: "POST",
        body: { account: buyerWallet, merchantWallet: walletB },
      }),
      productContext(product.id),
    );

    expect(response.status).toBe(200);
    expect(createUsdcTransferTransaction).toHaveBeenCalledWith(
      buyerWallet,
      walletA,
      product.priceUsdc,
    );
  });
});
