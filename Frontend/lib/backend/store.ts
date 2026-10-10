import { randomUUID } from "node:crypto";

import type {
  Order,
  Product,
  ProductStatus,
  ProductVariant,
} from "./types";

import {
  persistState,
  state,
} from "./store-state";

const merchantId =
  process.env.PRIVY_MERCHANT_USER_ID?.trim() || "merchant-aria-studio";
const merchantWallet = process.env.MERCHANT_WALLET?.trim() || "";

function seedProducts() {
  if (state.initialized) {
    return;
  }

  const now =
    new Date().toISOString();

  state.products.set("blk-001", {
    id: "blk-001",
    merchantId,
    merchantWallet,
    name: "Afterglow hoodie",
    description:
      "A limited studio edition hoodie.",

    priceUsdc: 0.3,

    imageUrl:
      "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=900&q=85",

    inventory: 18,
    status: "active",

    variants: [
      {
        id: "s",
        name: "Size",
        value: "S",
        inventory: 0,
      },
      {
        id: "m",
        name: "Size",
        value: "M",
        inventory: 10,
      },
      {
        id: "l",
        name: "Size",
        value: "L",
        inventory: 8,
      },
    ],

    createdAt: now,
    updatedAt: now,
  });

  state.products.set("blk-002", {
    id: "blk-002",
    merchantId,
    merchantWallet,
    name: "Signal cap",
    description:
      "A signal for the next drop.",

    priceUsdc: 0.2,

    imageUrl:
      "https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=900&q=85",

    inventory: 32,
    status: "active",
    variants: [],

    createdAt: now,
    updatedAt: now,
  });

  state.products.set("blk-003", {
    id: "blk-003",
    merchantId,
    merchantWallet,
    name: "Studio pass 2026",
    description:
      "Access to the Aria Studio session.",

    priceUsdc: 0.15,

    imageUrl:
      "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=85",

    inventory: 50,
    status: "active",
    variants: [],

    createdAt: now,
    updatedAt: now,
  });

  state.initialized = true;

  persistState();
}

seedProducts();

const products = state.products;
const orders = state.orders;

function refreshStatus(
  product: Product,
): Product {
  const status: ProductStatus =
    product.inventory === 0
      ? "sold_out"
      : product.status === "sold_out"
        ? "active"
        : product.status;

  return {
    ...product,
    status,
  };
}

function expirePendingOrders() {
  const currentTime = Date.now();

  let changed = false;

  for (const [id, order] of orders) {
    if (
      order.status !== "pending" ||
      new Date(
        order.expiresAt,
      ).getTime() > currentTime
    ) {
      continue;
    }

    if (order.inventoryReserved) {
      const product =
        products.get(order.productId);

      if (product) {
        const variants =
          product.variants.map(
            (variant) =>
              variant.value ===
              order.variant
                ? {
                    ...variant,
                    inventory:
                      variant.inventory +
                      order.quantity,
                  }
                : variant,
          );

        products.set(
          product.id,
          refreshStatus({
            ...product,
            inventory:
              product.inventory +
              order.quantity,
            variants,
            updatedAt:
              new Date().toISOString(),
          }),
        );
      }
    }

    orders.set(id, {
      ...order,
      status: "cancelled",
      inventoryReserved: false,
      updatedAt:
        new Date().toISOString(),
    });

    changed = true;
  }

  if (changed) {
    persistState();
  }
}

export const store = {
  listProducts() {
    return [
      ...products.values(),
    ].map(refreshStatus);
  },

  listProductsByMerchant(selectedMerchantId: string) {
    return store
      .listProducts()
      .filter((product) => product.merchantId === selectedMerchantId);
  },

  getProduct(id: string) {
    const product =
      products.get(id);

    return product
      ? refreshStatus(product)
      : undefined;
  },

  getProductOwnedBy(id: string, selectedMerchantId: string) {
    const product = store.getProduct(id);

    return product?.merchantId === selectedMerchantId
      ? product
      : undefined;
  },

  createProduct(
    input: Omit<
      Product,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "status"
    >,
  ) {
    const timestamp =
      new Date().toISOString();

    const product: Product = {
      ...input,

      id: `blk-${randomUUID().slice(
        0,
        8,
      )}`,

      status:
        input.inventory > 0
          ? "active"
          : "sold_out",

      createdAt: timestamp,
      updatedAt: timestamp,
    };

    products.set(
      product.id,
      product,
    );

    persistState();

    return product;
  },

  updateProduct(
    id: string,
    input: Partial<
      Pick<
        Product,
        | "name"
        | "description"
        | "priceUsdc"
        | "imageUrl"
        | "inventory"
        | "status"
        | "variants"
      >
    >,
  ) {
    const current =
      products.get(id);

    if (!current) {
      return undefined;
    }

    const product =
      refreshStatus({
        ...current,
        ...input,
        updatedAt:
          new Date().toISOString(),
      });

    products.set(
      id,
      product,
    );

    persistState();

    return product;
  },

  hasPendingOrders(
    productId: string,
  ) {
    expirePendingOrders();

    return [
      ...orders.values(),
    ].some(
      (order) =>
        order.productId ===
          productId &&
        order.status ===
          "pending",
    );
  },

  deleteProduct(id: string) {
    if (
      store.hasPendingOrders(id)
    ) {
      return "pending_orders" as const;
    }

    const deleted =
      products.delete(id);

    if (deleted) {
      persistState();
    }

    return deleted;
  },

  listOrders() {
    expirePendingOrders();

    return [
      ...orders.values(),
    ].sort((a, b) =>
      b.createdAt.localeCompare(
        a.createdAt,
      ),
    );
  },

  listOrdersByMerchant(selectedMerchantId: string) {
    return store
      .listOrders()
      .filter((order) => order.merchantId === selectedMerchantId);
  },

  getOrder(id: string) {
    expirePendingOrders();

    return orders.get(id);
  },

  getOrderOwnedBy(id: string, selectedMerchantId: string) {
    const order = store.getOrder(id);

    return order?.merchantId === selectedMerchantId
      ? order
      : undefined;
  },

  bindSponsoredTransaction(id: string, messageHash: string) {
    const order = store.getOrder(id);
    if (!order || order.status !== "pending") return undefined;

    if (
      order.sponsoredTransactionHash &&
      order.sponsoredTransactionHash !== messageHash
    ) {
      return undefined;
    }

    const updated = {
      ...order,
      sponsoredTransactionHash: messageHash,
      updatedAt: new Date().toISOString(),
    };
    orders.set(id, updated);
    persistState();
    return updated;
  },

  findOrderBySignature(
    signature: string,
  ) {
    expirePendingOrders();

    return [
      ...orders.values(),
    ].find(
      (order) =>
        order.txSignature ===
        signature,
    );
  },

  createOrder(
    input: Omit<
      Order,
      | "id"
      | "createdAt"
      | "updatedAt"
      | "status"
      | "expiresAt"
      | "inventoryReserved"
      | "sponsoredTransactionHash"
      | "merchantId"
      | "merchantWallet"
    >,
  ) {
    const product =
      products.get(
        input.productId,
      );

    if (
      !product ||
      product.status !==
        "active"
    ) {
      return undefined;
    }

    // Products with variants require a valid selection so reservations can be
    // released back to the same inventory bucket later.
    if (
      product.variants.length > 0 &&
      !input.variant
    ) {
      return undefined;
    }

    const selectedVariant =
      input.variant
        ? product.variants.find(
            (variant) =>
              variant.value ===
              input.variant,
          )
        : undefined;

    if (
      product.inventory <
      input.quantity
    ) {
      return undefined;
    }

    if (
      input.variant &&
      (!selectedVariant ||
        selectedVariant.inventory <
          input.quantity)
    ) {
      return undefined;
    }

    const variants =
      product.variants.map(
        (variant) =>
          variant.value ===
          input.variant
            ? {
                ...variant,
                inventory:
                  variant.inventory -
                  input.quantity,
              }
            : variant,
      );

    // Reserve stock before transaction construction. If construction fails,
    // markFailed releases this exact reservation.
    products.set(
      product.id,
      refreshStatus({
        ...product,

        inventory:
          product.inventory -
          input.quantity,

        variants,

        updatedAt:
          new Date().toISOString(),
      }),
    );

    const timestamp =
      new Date().toISOString();

    const order: Order = {
      ...input,

      merchantId: product.merchantId,
      merchantWallet: product.merchantWallet,

      id: `order-${randomUUID().slice(
        0,
        8,
      )}`,

      status: "pending",

      inventoryReserved: true,

      createdAt: timestamp,
      updatedAt: timestamp,

      expiresAt: new Date(
        Date.now() +
          10 * 60 * 1000,
      ).toISOString(),
    };

    orders.set(
      order.id,
      order,
    );

    persistState();

    return order;
  },

  attachSignature(
    id: string,
    signature: string,
  ) {
    const order =
      orders.get(id);

    if (!order) {
      return undefined;
    }

    // Confirmation routes call this only after Solana verification succeeds.
    // Retrying that verified signature is idempotent; replacing it is not.
    if (
      order.txSignature &&
      order.txSignature !== signature
    ) {
      return undefined;
    }

    if (order.txSignature === signature) {
      return order;
    }

    const updated = {
      ...order,

      txSignature:
        signature,

      updatedAt:
        new Date().toISOString(),
    };

    orders.set(
      id,
      updated,
    );

    persistState();

    return updated;
  },

  confirmVerifiedPayment(
    id: string,
    signature: string,
  ) {
    // Verification is asynchronous, so re-read all mutable order/signature
    // state immediately before the synchronous duplicate-check-and-attach step.
    const order = store.getOrder(id);

    if (!order) {
      return { result: "not_found" as const };
    }

    if (order.status === "cancelled") {
      return { result: "cancelled" as const };
    }

    if (order.status === "failed") {
      return { result: "failed" as const };
    }

    if (
      order.txSignature &&
      order.txSignature !== signature
    ) {
      return { result: "signature_conflict" as const };
    }

    if (order.status === "paid") {
      return order.txSignature === signature
        ? {
            result: "paid" as const,
            order,
            duplicate: true,
          }
        : { result: "state_error" as const };
    }

    const existing =
      store.findOrderBySignature(signature);

    if (existing && existing.id !== order.id) {
      return { result: "signature_used" as const };
    }

    // findOrderBySignature also applies normal expiry. Re-read once more so an
    // order crossing its deadline during these synchronous checks stays unbound.
    const currentOrder = store.getOrder(id);

    if (!currentOrder) {
      return { result: "not_found" as const };
    }

    if (currentOrder.status === "cancelled") {
      return { result: "cancelled" as const };
    }

    if (currentOrder.status === "failed") {
      return { result: "failed" as const };
    }

    if (
      currentOrder.txSignature &&
      currentOrder.txSignature !== signature
    ) {
      return { result: "signature_conflict" as const };
    }

    if (currentOrder.status === "paid") {
      return currentOrder.txSignature === signature
        ? {
            result: "paid" as const,
            order: currentOrder,
            duplicate: true,
          }
        : { result: "state_error" as const };
    }

    // No await is allowed between the duplicate check and attachment in the
    // single-instance store, so another request cannot interleave here.
    const attached =
      store.attachSignature(currentOrder.id, signature);

    if (!attached) {
      return { result: "signature_conflict" as const };
    }

    const paid = store.markPaid(order.id);

    return paid
      ? {
          result: "paid" as const,
          order: paid,
          duplicate: false,
        }
      : { result: "state_error" as const };
  },

  markPaid(id: string) {
    const order =
      orders.get(id);

    if (!order) {
      return undefined;
    }

    if (
      order.status === "paid"
    ) {
      return order;
    }

    if (
      !order.inventoryReserved
    ) {
      return undefined;
    }

    // Payment verification already succeeded. Clearing the reservation flag
    // finalizes the stock consumption without adding inventory back.
    const updated = {
      ...order,

      status:
        "paid" as const,

      inventoryReserved:
        false,

      updatedAt:
        new Date().toISOString(),
    };

    orders.set(
      id,
      updated,
    );

    persistState();

    return updated;
  },

  markFailed(id: string) {
    const order =
      orders.get(id);

    if (!order) {
      return undefined;
    }

    if (
      order.status === "paid"
    ) {
      return order;
    }

    // releaseInventory is guarded by inventoryReserved, so retrying a failure
    // cannot return the same stock twice.
    store.releaseInventory(
      order,
    );

    const updated = {
      ...order,

      status:
        "failed" as const,

      inventoryReserved:
        false,

      updatedAt:
        new Date().toISOString(),
    };

    orders.set(
      id,
      updated,
    );

    persistState();

    return updated;
  },

  releaseInventory(
    order: Order,
  ) {
    if (
      !order.inventoryReserved
    ) {
      return;
    }

    const product =
      products.get(
        order.productId,
      );

    if (!product) {
      return;
    }

    const variants =
      product.variants.map(
        (variant) =>
          variant.value ===
          order.variant
            ? {
                ...variant,

                inventory:
                  variant.inventory +
                  order.quantity,
              }
            : variant,
      );

    products.set(
      product.id,
      refreshStatus({
        ...product,

        inventory:
          product.inventory +
          order.quantity,

        variants,

        updatedAt:
          new Date().toISOString(),
      }),
    );

    persistState();
  },
};

export function normalizeVariants(
  value: unknown,
): ProductVariant[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (
        variant,
      ): variant is ProductVariant =>
        typeof variant ===
          "object" &&
        variant !== null &&
        typeof (
          variant as ProductVariant
        ).name === "string" &&
        Boolean(
          (
            variant as ProductVariant
          ).name.trim(),
        ) &&
        typeof (
          variant as ProductVariant
        ).value === "string" &&
        Boolean(
          (
            variant as ProductVariant
          ).value.trim(),
        ) &&
        Number.isInteger(
          (
            variant as ProductVariant
          ).inventory,
        ) &&
        (
          variant as ProductVariant
        ).inventory >= 0,
    )
    .map((variant) => ({
      id:
        variant.id ||
        randomUUID(),

      name:
        variant.name.trim(),

      value:
        variant.value.trim(),

      inventory:
        variant.inventory,
    }));
}

export function areVariantsValid(
  input: unknown,
  variants: ProductVariant[],
  inventory: number,
) {
  if (
    !Array.isArray(input) ||
    variants.length !==
      input.length
  ) {
    return false;
  }

  if (
    variants.length === 0
  ) {
    return true;
  }

  if (
    new Set(
      variants.map(
        (variant) =>
          variant.value,
      ),
    ).size !==
    variants.length
  ) {
    return false;
  }

  return (
    variants.reduce(
      (total, variant) =>
        total +
        variant.inventory,
      0,
    ) === inventory
  );
}
