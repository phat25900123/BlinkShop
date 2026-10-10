import { afterEach, describe, expect, it, vi } from "vitest";

import { normalizeLegacyStore } from "../lib/backend/store-persistence";

const timestamp = "2026-01-01T00:00:00.000Z";

function legacyProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-product",
    merchantId: "merchant-aria-studio",
    name: "Legacy product",
    description: "Legacy data",
    priceUsdc: 0.3,
    imageUrl: "",
    inventory: 2,
    status: "active" as const,
    variants: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function legacyOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "legacy-order",
    productId: "legacy-product",
    merchantId: "merchant-aria-studio",
    buyerWallet: "11111111111111111111111111111111",
    quantity: 1,
    amountUsdc: 0.3,
    status: "pending" as const,
    inventoryReserved: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("legacy JSON compatibility normalization", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("fills a missing legacy product wallet from MERCHANT_WALLET", () => {
    vi.stubEnv("MERCHANT_WALLET", "Vote111111111111111111111111111111111111111");
    const normalized = normalizeLegacyStore({
      products: [legacyProduct()],
      orders: [],
    });

    expect(normalized.products[0].merchantWallet).toBe(
      "Vote111111111111111111111111111111111111111",
    );
  });

  it("optionally maps only the legacy Aria merchant ID to the configured DID", () => {
    vi.stubEnv("PRIVY_MERCHANT_USER_ID", "did:privy:legacy-owner");
    const normalized = normalizeLegacyStore({
      products: [legacyProduct()],
      orders: [legacyOrder()],
    });

    expect(normalized.products[0].merchantId).toBe("did:privy:legacy-owner");
    expect(normalized.orders[0].merchantId).toBe("did:privy:legacy-owner");
  });

  it("copies the normalized product payout into a legacy order snapshot", () => {
    vi.stubEnv("MERCHANT_WALLET", "Vote111111111111111111111111111111111111111");
    const normalized = normalizeLegacyStore({
      products: [legacyProduct()],
      orders: [legacyOrder()],
    });

    expect(normalized.orders[0].merchantWallet).toBe(
      normalized.products[0].merchantWallet,
    );
  });

  it("does not rewrite non-legacy merchant ownership", () => {
    vi.stubEnv("PRIVY_MERCHANT_USER_ID", "did:privy:legacy-owner");
    const normalized = normalizeLegacyStore({
      products: [legacyProduct({ merchantId: "did:privy:new-owner" })],
      orders: [],
    });

    expect(normalized.products[0].merchantId).toBe("did:privy:new-owner");
  });

  it("keeps legacy records readable but non-payable when no fallback wallet exists", () => {
    vi.stubEnv("MERCHANT_WALLET", "");
    const normalized = normalizeLegacyStore({
      products: [legacyProduct()],
      orders: [legacyOrder()],
    });

    expect(normalized.products[0].merchantWallet).toBe("");
    expect(normalized.orders[0].merchantWallet).toBe("");
  });
});
