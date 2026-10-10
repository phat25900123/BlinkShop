import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { POST as confirmOrder } from "../app/api/orders/confirm/route";
import { verifyUsdcPayment } from "../lib/backend/solana";
import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

vi.mock("@/lib/backend/solana", () => ({
  verifyUsdcPayment: vi.fn().mockResolvedValue("valid"),
}));

const buyerWallet = "11111111111111111111111111111111";

function reserveOrder() {
  const product = store.getProduct("product-1") ?? addProduct({ inventory: 6 });
  const order = store.createOrder({
    productId: product.id,
    buyerWallet,
    quantity: 1,
    amountUsdc: product.priceUsdc,
  });

  if (!order) throw new Error("Expected order reservation to succeed");
  return order;
}

function confirmationRequest(orderId: string, txSignature: string) {
  return new Request("http://localhost/api/orders/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, txSignature }),
  }) as NextRequest;
}

describe("transaction signature protection", () => {
  beforeEach(() => {
    resetStore();
    vi.mocked(verifyUsdcPayment).mockReset().mockResolvedValue("valid");
  });

  it("treats the same signature retried for the same order as idempotent", async () => {
    const order = reserveOrder();

    const first = await confirmOrder(confirmationRequest(order.id, "signature-a"));
    const inventoryAfterPayment = store.getProduct(order.productId)?.inventory;
    const retry = await confirmOrder(confirmationRequest(order.id, "signature-a"));

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      duplicate: true,
      order: { id: order.id, txSignature: "signature-a", status: "paid" },
    });
    expect(store.getProduct(order.productId)?.inventory).toBe(inventoryAfterPayment);
    expect(verifyUsdcPayment).toHaveBeenCalledWith("signature-a", {
      buyerWallet: order.buyerWallet,
      merchantWallet: order.merchantWallet,
      amountUsdc: order.amountUsdc,
    });
  });

  it("rejects one signature being used for a different order", async () => {
    const firstOrder = reserveOrder();
    const secondOrder = reserveOrder();

    expect(
      (await confirmOrder(confirmationRequest(firstOrder.id, "shared-signature"))).status,
    ).toBe(200);

    const response = await confirmOrder(
      confirmationRequest(secondOrder.id, "shared-signature"),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Transaction signature already used",
    });
    expect(store.getOrder(secondOrder.id)?.txSignature).toBeUndefined();
  });

  it("rejects signature replacement and preserves the first signature", async () => {
    const order = reserveOrder();
    expect(
      (await confirmOrder(confirmationRequest(order.id, "signature-a"))).status,
    ).toBe(200);

    const response = await confirmOrder(
      confirmationRequest(order.id, "signature-b"),
    );

    expect(response.status).toBe(409);
    expect(store.getOrder(order.id)).toMatchObject({
      status: "paid",
      txSignature: "signature-a",
    });
  });
});
