import { beforeEach, describe, expect, it } from "vitest";

import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

const buyerWallet = "11111111111111111111111111111111";

function createOrder(
  productId: string,
  quantity: number,
  variant?: string,
) {
  return store.createOrder({
    productId,
    buyerWallet,
    variant,
    quantity,
    amountUsdc: 0.3 * quantity,
  });
}

describe("inventory reservation", () => {
  beforeEach(resetStore);

  it("reserves the requested quantity from total stock", () => {
    const product = addProduct();

    const order = createOrder(product.id, 2);

    expect(order).toMatchObject({
      quantity: 2,
      status: "pending",
      inventoryReserved: true,
    });
    expect(store.getProduct(product.id)?.inventory).toBe(3);
  });

  it("reserves only the selected variant and leaves other variants unchanged", () => {
    const product = addProduct({
      inventory: 5,
      variants: [
        { id: "m", name: "Size", value: "M", inventory: 3 },
        { id: "l", name: "Size", value: "L", inventory: 2 },
      ],
    });

    expect(createOrder(product.id, 2, "M")).toBeDefined();

    expect(store.getProduct(product.id)).toMatchObject({
      inventory: 3,
      variants: [
        { value: "M", inventory: 1 },
        { value: "L", inventory: 2 },
      ],
    });
  });

  it("rejects a request larger than total inventory without changing stock", () => {
    const product = addProduct({ inventory: 2 });

    expect(createOrder(product.id, 3)).toBeUndefined();
    expect(store.getProduct(product.id)?.inventory).toBe(2);
  });

  it("rejects a sold-out variant without changing total or variant stock", () => {
    const product = addProduct({
      inventory: 2,
      variants: [
        { id: "s", name: "Size", value: "S", inventory: 0 },
        { id: "m", name: "Size", value: "M", inventory: 2 },
      ],
    });

    expect(createOrder(product.id, 1, "S")).toBeUndefined();
    expect(store.getProduct(product.id)).toMatchObject({
      inventory: 2,
      variants: [
        { value: "S", inventory: 0 },
        { value: "M", inventory: 2 },
      ],
    });
  });

  it("never lets sequential reservations make inventory negative", () => {
    const product = addProduct({ inventory: 5 });

    expect(createOrder(product.id, 4)).toBeDefined();
    expect(createOrder(product.id, 2)).toBeUndefined();
    expect(store.getProduct(product.id)?.inventory).toBe(1);
  });
});
