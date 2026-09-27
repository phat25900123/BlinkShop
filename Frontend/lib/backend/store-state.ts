import type {
  Order,
  Product,
} from "./types";

import {
  jsonPersistenceAdapter,
} from "./store-persistence";

const persistence = jsonPersistenceAdapter;

type BlinkShopState = {
  products: Map<string, Product>;
  orders: Map<string, Order>;
  initialized: boolean;
};

const globalForBlinkShop =
  globalThis as typeof globalThis & {
    blinkShopState?: BlinkShopState;
  };

function createState(): BlinkShopState {
  const persisted =
    persistence.load();

  return {
    products: new Map(
      persisted.products.map((product) => [
        product.id,
        product,
      ]),
    ),

    orders: new Map(
      persisted.orders.map((order) => [
        order.id,
        order,
      ]),
    ),

    // Nếu store.json đã tồn tại thì không
    // seed lại sản phẩm mặc định.
    initialized: persisted.exists,
  };
}

export const state =
  globalForBlinkShop.blinkShopState ??
  (globalForBlinkShop.blinkShopState =
    createState());

export function persistState() {
  persistence.save(
    [...state.products.values()],
    [...state.orders.values()],
  );
}
