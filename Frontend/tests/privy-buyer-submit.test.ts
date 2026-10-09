import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend/privy", () => {
  class PrivyConfigurationError extends Error {}

  return {
    PrivyConfigurationError,
    verifyPrivyAccessToken: vi.fn(async (token: string) => {
      if (token === "buyer-token") return { userId: "did:privy:buyer" };
      if (token === "other-token") return { userId: "did:privy:other" };
      throw new Error("Invalid access token");
    }),
    getPrivyEmbeddedSolanaWallet: vi.fn(async (userId: string) => ({
      address: userId === "did:privy:other" ? "other-wallet" : "buyer-wallet",
      walletId: userId === "did:privy:other" ? "wallet-other" : "wallet-buyer",
    })),
  };
});

vi.mock("../lib/backend/sponsored-submit", () => {
  class SponsoredSubmissionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    SponsoredSubmissionError,
    submitSponsoredCheckoutTransaction: vi.fn(async () => ({
      txSignature: "rpc-transaction-signature",
    })),
  };
});

import { POST as submitPrivyCheckout } from "../app/api/checkout/privy/[productId]/submit/route";
import { submitSponsoredCheckoutTransaction } from "../lib/backend/sponsored-submit";
import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

function request(token: string | null = "buyer-token", extra = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return new NextRequest(
    "http://localhost/api/checkout/privy/product-1/submit",
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        orderId: "order-placeholder",
        signedTransaction: "c2lnbmVkLXRyYW5zYWN0aW9u",
        ...extra,
      }),
    },
  );
}

const context = (productId = "product-1") => ({
  params: Promise.resolve({ productId }),
});

function createPendingOrder(buyerWallet = "buyer-wallet") {
  const product = store.getProduct("product-1") ?? addProduct();
  const order = store.createOrder({
    productId: product.id,
    merchantId: product.merchantId,
    buyerWallet,
    quantity: 1,
    amountUsdc: product.priceUsdc,
  });
  if (!order) throw new Error("Test order was not created");
  return { product, order };
}

function requestForOrder(orderId: string, token = "buyer-token") {
  return request(token, { orderId });
}

describe("Privy sponsored transaction submission route", () => {
  beforeEach(() => {
    resetStore();
    vi.stubEnv("PRIVY_MERCHANT_USER_ID", "did:privy:merchant");
    vi.mocked(submitSponsoredCheckoutTransaction).mockResolvedValue({
      txSignature: "rpc-transaction-signature",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("returns 401 without a Privy access token", async () => {
    addProduct();
    const response = await submitPrivyCheckout(request(null), context());

    expect(response.status).toBe(401);
    expect(submitSponsoredCheckoutTransaction).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid Privy access token", async () => {
    addProduct();
    const response = await submitPrivyCheckout(request("invalid"), context());

    expect(response.status).toBe(401);
    expect(submitSponsoredCheckoutTransaction).not.toHaveBeenCalled();
  });

  it("allows an authenticated non-merchant buyer to submit their order", async () => {
    const { order } = createPendingOrder();
    const response = await submitPrivyCheckout(
      requestForOrder(order.id),
      context(),
    );
    const body = (await response.json()) as { txSignature?: string };

    expect(response.status).toBe(200);
    expect(body.txSignature).toBe("rpc-transaction-signature");
    expect(submitSponsoredCheckoutTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        order: expect.objectContaining({ id: order.id }),
        authenticatedBuyerWallet: "buyer-wallet",
        routeProductId: "product-1",
      }),
    );
    expect(store.getOrder(order.id)?.status).toBe("pending");
  });

  it("rejects another authenticated buyer's order", async () => {
    const { order } = createPendingOrder();
    const response = await submitPrivyCheckout(
      requestForOrder(order.id, "other-token"),
      context(),
    );

    expect(response.status).toBe(403);
    expect(submitSponsoredCheckoutTransaction).not.toHaveBeenCalled();
  });

  it("rejects an invalid order ID", async () => {
    addProduct();
    const response = await submitPrivyCheckout(
      requestForOrder("missing-order"),
      context(),
    );

    expect(response.status).toBe(404);
    expect(submitSponsoredCheckoutTransaction).not.toHaveBeenCalled();
  });

  it("rejects non-pending and expired orders", async () => {
    const { order } = createPendingOrder();
    store.markFailed(order.id);
    expect(
      (await submitPrivyCheckout(requestForOrder(order.id), context())).status,
    ).toBe(409);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    resetStore();
    const expired = createPendingOrder().order;
    vi.setSystemTime(new Date("2026-01-01T00:11:00.000Z"));
    expect(
      (
        await submitPrivyCheckout(requestForOrder(expired.id), context())
      ).status,
    ).toBe(409);
  });

  it("rejects client-owned payment fields", async () => {
    const { order } = createPendingOrder();
    const bodyWithAmount = new NextRequest(
      "http://localhost/api/checkout/privy/product-1/submit",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer buyer-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderId: order.id,
          signedTransaction: "c2lnbmVkLXRyYW5zYWN0aW9u",
          amountUsdc: 0.01,
        }),
      },
    );
    expect((await submitPrivyCheckout(bodyWithAmount, context())).status).toBe(
      400,
    );
  });

  it("does not reserve inventory again or mark Paid on replay", async () => {
    const { product, order } = createPendingOrder();
    expect(
      (await submitPrivyCheckout(requestForOrder(order.id), context())).status,
    ).toBe(200);
    expect(
      (await submitPrivyCheckout(requestForOrder(order.id), context())).status,
    ).toBe(200);

    expect(store.listOrders()).toHaveLength(1);
    expect(store.getProduct(product.id)?.inventory).toBe(4);
    const persistedOrder = store.getOrder(order.id);
    expect(persistedOrder).toMatchObject({
      status: "pending",
      inventoryReserved: true,
    });
    expect(persistedOrder?.txSignature).toBeUndefined();
  });
});
