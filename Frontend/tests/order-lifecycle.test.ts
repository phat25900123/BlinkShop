import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

const buyerWallet = "11111111111111111111111111111111";
const startTime = new Date("2026-01-01T00:00:00.000Z");

function reserve(quantity = 2) {
  const product = addProduct({ inventory: 5 });
  const order = store.createOrder({
    productId: product.id,
    merchantId: product.merchantId,
    buyerWallet,
    quantity,
    amountUsdc: product.priceUsdc * quantity,
  });

  if (!order) throw new Error("Expected order reservation to succeed");
  return { order, product };
}

describe("order lifecycle", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    vi.setSystemTime(startTime);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("moves a pending order to paid while retaining consumed inventory", () => {
    const { order, product } = reserve();

    expect(store.markPaid(order.id)).toMatchObject({
      status: "paid",
      inventoryReserved: false,
    });
    expect(store.getProduct(product.id)?.inventory).toBe(3);
  });

  it("moves a pending order to failed and releases its reservation", () => {
    const { order, product } = reserve();

    expect(store.markFailed(order.id)).toMatchObject({
      status: "failed",
      inventoryReserved: false,
    });
    expect(store.getProduct(product.id)?.inventory).toBe(5);
  });

  it("does not release inventory twice when failure is retried", () => {
    const { order, product } = reserve();

    store.markFailed(order.id);
    store.markFailed(order.id);

    expect(store.getProduct(product.id)?.inventory).toBe(5);
  });

  it("cancels an expired pending order after ten minutes and releases once", () => {
    const { order, product } = reserve();

    vi.advanceTimersByTime(10 * 60 * 1000 + 1);

    expect(store.getOrder(order.id)).toMatchObject({
      status: "cancelled",
      inventoryReserved: false,
    });
    expect(store.getProduct(product.id)?.inventory).toBe(5);

    store.getOrder(order.id);
    expect(store.getProduct(product.id)?.inventory).toBe(5);
  });

  it("does not expire a paid order after its original deadline", () => {
    const { order, product } = reserve();
    store.markPaid(order.id);

    vi.advanceTimersByTime(11 * 60 * 1000);

    expect(store.getOrder(order.id)).toMatchObject({
      status: "paid",
      inventoryReserved: false,
    });
    expect(store.getProduct(product.id)?.inventory).toBe(3);
  });

  it("keeps paid orders paid when payment confirmation is retried", () => {
    const { order, product } = reserve();
    store.markPaid(order.id);

    expect(store.markPaid(order.id)?.status).toBe("paid");
    expect(store.getProduct(product.id)?.inventory).toBe(3);
  });
});
