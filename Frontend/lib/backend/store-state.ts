import type {
  Order,
  Product,
} from "./types";

import {
  jsonPersistenceAdapter,
} from "./store-persistence";

const configuredDataStore =
  process.env.DATA_STORE?.trim().toLowerCase() || "json";

if (configuredDataStore !== "json") {
  throw new Error(
    `Unsupported DATA_STORE=${configuredDataStore}. ` +
      "Only the JSON adapter is active; Supabase requires atomic inventory RPCs before it can be enabled.",
  );
}

// TODO(production): select a Supabase adapter only after reservation,
// expiration, failure release and paid confirmation are transactional RPCs.
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

    // An existing store is authoritative; never seed demo products over it.
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
