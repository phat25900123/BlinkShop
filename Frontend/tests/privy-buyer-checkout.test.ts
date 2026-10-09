import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend/privy", () => {
  class PrivyConfigurationError extends Error {}

  return {
    PrivyConfigurationError,
    verifyPrivyAccessToken: vi.fn(async (token: string) => {
      if (token !== "buyer-token") throw new Error("Invalid access token");
      return { userId: "did:privy:buyer" };
    }),
    getPrivyEmbeddedSolanaWallet: vi.fn(),
  };
});

vi.mock("../lib/backend/sponsored-checkout", () => {
  class SponsoredCheckoutError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }

  return {
    SponsoredCheckoutError,
    createSponsoredUsdcTransferTransaction: vi.fn(),
  };
});

import { POST as createPrivyCheckout } from "../app/api/checkout/privy/[productId]/route";
import { getPrivyEmbeddedSolanaWallet } from "../lib/backend/privy";
import {
  createSponsoredUsdcTransferTransaction,
  SponsoredCheckoutError,
} from "../lib/backend/sponsored-checkout";
import { SolanaSponsorConfigurationError } from "../lib/backend/solana-sponsor";
import { store } from "../lib/backend/store";
import { addProduct, resetStore } from "./helpers/store-fixtures";

const buyerWallet = "11111111111111111111111111111111";
const spoofedWallet = "Vote111111111111111111111111111111111111111";

function request(
  body: Record<string, unknown>,
  token: string | null = "buyer-token",
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  return new NextRequest("http://localhost/api/checkout/privy/product-1", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const context = (productId = "product-1") => ({
  params: Promise.resolve({ productId }),
});

describe("Privy buyer checkout", () => {
  beforeEach(() => {
    resetStore();
    vi.stubEnv("PRIVY_MERCHANT_USER_ID", "did:privy:merchant");
    vi.mocked(getPrivyEmbeddedSolanaWallet).mockResolvedValue({
      address: buyerWallet,
      walletId: "wallet-buyer",
    });
    vi.mocked(createSponsoredUsdcTransferTransaction).mockResolvedValue({
      serializedTransaction: "base64-sponsored-transaction",
      buyerWallet,
      buyerTokenAccount: "buyer-token-account",
      merchantWallet: "merchant-wallet",
      merchantTokenAccount: "merchant-token-account",
      usdcMint: "usdc-mint",
      amountBaseUnits: 300_000,
      sponsorWallet: "sponsor-wallet",
      messageHash: "server-prepared-message-hash",
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("returns 401 without a Privy access token and does not reserve stock", async () => {
    const product = addProduct();
    const response = await createPrivyCheckout(request({}, null), context());

    expect(response.status).toBe(401);
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("returns 401 for an invalid buyer access token", async () => {
    const product = addProduct();
    const response = await createPrivyCheckout(
      request({}, "invalid-token"),
      context(),
    );

    expect(response.status).toBe(401);
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("allows an authenticated non-merchant buyer", async () => {
    addProduct();
    const response = await createPrivyCheckout(request({ quantity: 1 }), context());

    expect(response.status).toBe(200);
    expect(vi.mocked(getPrivyEmbeddedSolanaWallet)).toHaveBeenCalledWith(
      "did:privy:buyer",
    );
  });

  it("rejects a browser-supplied buyer wallet without mutating state", async () => {
    const product = addProduct();
    const response = await createPrivyCheckout(
      request({ buyerWallet: spoofedWallet, quantity: 1 }),
      context(),
    );

    expect(response.status).toBe(400);
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("binds the order and transaction to the authenticated embedded wallet", async () => {
    const product = addProduct({ priceUsdc: 0.3 });
    const response = await createPrivyCheckout(
      request({ quantity: 2 }),
      context(),
    );
    const body = (await response.json()) as {
      buyerWallet: string;
      amountUsdc: number;
    };
    const order = store.listOrders()[0];

    expect(response.status).toBe(200);
    expect(body.buyerWallet).toBe(buyerWallet);
    expect(body.amountUsdc).toBe(0.6);
    expect(order.buyerWallet).toBe(buyerWallet);
    expect(order.amountUsdc).toBe(0.6);
    expect(order.sponsoredTransactionHash).toBe(
      "server-prepared-message-hash",
    );
    expect(createSponsoredUsdcTransferTransaction).toHaveBeenCalledWith(
      buyerWallet,
      0.6,
    );
    expect(store.getProduct(product.id)?.inventory).toBe(3);
  });

  it("returns 404 for a missing product", async () => {
    const response = await createPrivyCheckout(request({}), context("missing"));
    expect(response.status).toBe(404);
  });

  it("waits for Privy wallet provisioning without reserving stock", async () => {
    const product = addProduct();
    vi.mocked(getPrivyEmbeddedSolanaWallet).mockResolvedValueOnce(null);
    const response = await createPrivyCheckout(request({}), context());
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe("embedded_wallet_unavailable");
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("rejects an inactive product", async () => {
    addProduct({ status: "inactive" });
    const response = await createPrivyCheckout(request({}), context());
    expect(response.status).toBe(409);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("rejects an invalid variant", async () => {
    addProduct({
      variants: [
        { id: "m", name: "Size", value: "M", inventory: 5 },
      ],
    });
    const response = await createPrivyCheckout(
      request({ variant: "XL" }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("rejects insufficient inventory", async () => {
    addProduct({ inventory: 1 });
    const response = await createPrivyCheckout(
      request({ quantity: 2 }),
      context(),
    );

    expect(response.status).toBe(409);
    expect(store.listOrders()).toHaveLength(0);
  });

  it("releases reserved stock after a missing buyer USDC ATA", async () => {
    const product = addProduct();
    vi.mocked(createSponsoredUsdcTransferTransaction).mockRejectedValueOnce(
      new SponsoredCheckoutError(
        "buyer_usdc_account_missing",
        "Your embedded wallet does not have a USDC token account yet.",
      ),
    );

    const response = await createPrivyCheckout(request({ quantity: 2 }), context());
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe("buyer_usdc_account_missing");
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()[0].status).toBe("failed");
  });

  it("releases reserved stock after a missing merchant USDC ATA", async () => {
    const product = addProduct();
    vi.mocked(createSponsoredUsdcTransferTransaction).mockRejectedValueOnce(
      new SponsoredCheckoutError(
        "merchant_usdc_account_missing",
        "The merchant Devnet USDC token account is not configured.",
      ),
    );

    const response = await createPrivyCheckout(request({ quantity: 2 }), context());
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("merchant_usdc_account_missing");
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()[0].status).toBe("failed");
  });

  it("returns a controlled 503 and releases stock when sponsor config is missing", async () => {
    const product = addProduct();
    vi.mocked(createSponsoredUsdcTransferTransaction).mockRejectedValueOnce(
      new SolanaSponsorConfigurationError(
        "sponsor_secret_missing",
        "The BlinkShop Devnet sponsor wallet is not configured.",
      ),
    );

    const response = await createPrivyCheckout(request({ quantity: 2 }), context());
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(503);
    expect(body.code).toBe("sponsor_secret_missing");
    expect(store.getProduct(product.id)?.inventory).toBe(5);
    expect(store.listOrders()[0].status).toBe("failed");
  });

  it("limits a wallet to one pending reservation per product", async () => {
    const product = addProduct();
    expect((await createPrivyCheckout(request({}), context())).status).toBe(200);
    const response = await createPrivyCheckout(request({}), context());
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(body.code).toBe("pending_checkout_exists");
    expect(store.listOrders()).toHaveLength(1);
    expect(store.getProduct(product.id)?.inventory).toBe(4);
  });
});
