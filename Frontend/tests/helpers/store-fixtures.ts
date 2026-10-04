import { state } from "../../lib/backend/store-state";
import type { Product } from "../../lib/backend/types";

const timestamp = "2026-01-01T00:00:00.000Z";

export function resetStore() {
  state.products.clear();
  state.orders.clear();
  state.initialized = true;
}

export function addProduct(
  input: Partial<Product> = {},
) {
  const product: Product = {
    id: "product-1",
    merchantId: "merchant-1",
    name: "Test product",
    description: "Test product",
    priceUsdc: 0.3,
    imageUrl: "https://example.com/product.jpg",
    inventory: 5,
    status: "active",
    variants: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...input,
  };

  state.products.set(product.id, product);
  return product;
}
