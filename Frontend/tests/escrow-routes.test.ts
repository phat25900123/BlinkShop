import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend/privy", () => {
  class PrivyConfigurationError extends Error {}
  const users: Record<string, { userId: string; wallet: string }> = {
    "merchant-token": { userId: "did:privy:merchant", wallet: "merchant-wallet" },
    "buyer-token": { userId: "did:privy:buyer", wallet: "buyer-wallet" },
    "stranger-token": { userId: "did:privy:stranger", wallet: "stranger-wallet" },
  };
  return {
    PrivyConfigurationError,
    verifyPrivyAccessToken: vi.fn(async (token: string) => {
      const user = users[token];
      if (!user) throw new Error("Invalid access token");
      return { userId: user.userId };
    }),
    getPrivyEmbeddedSolanaWallet: vi.fn(async (userId: string) => {
      const user = Object.values(users).find((item) => item.userId === userId);
      return user ? { address: user.wallet, walletId: "w" } : null;
    }),
  };
});

vi.mock("../lib/backend/escrow-actions", () => {
  class EscrowActionError extends Error {
    constructor(
      public readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    EscrowActionError,
    prepareEscrowAction: vi.fn(async () => ({
      transaction: "prepared-tx",
      action: "ship",
      escrowOrderAccount: "escrow-order",
    })),
    submitEscrowAction: vi.fn(async () => ({ txSignature: "lifecycle-signature" })),
    syncEscrowOrderStatus: vi.fn(),
  };
});

import { POST as prepare } from "../app/api/orders/[id]/escrow/[action]/route";
import { POST as submit } from "../app/api/orders/[id]/escrow/[action]/submit/route";
import { POST as sync } from "../app/api/orders/[id]/escrow/route";
import {
  EscrowActionError,
  prepareEscrowAction,
  submitEscrowAction,
  syncEscrowOrderStatus,
} from "../lib/backend/escrow-actions";
import { getPrivyEmbeddedSolanaWallet } from "../lib/backend/privy";
import { store } from "../lib/backend/store";
import { state } from "../lib/backend/store-state";
import type { Order } from "../lib/backend/types";
import { resetStore } from "./helpers/store-fixtures";

function seed(overrides: Partial<Order> = {}) {
  const timestamp = new Date().toISOString();
  const order: Order = {
    id: "order-1",
    productId: "product-1",
    merchantId: "did:privy:merchant",
    merchantWallet: "merchant-wallet",
    buyerWallet: "buyer-wallet",
    quantity: 1,
    amountUsdc: 0.3,
    status: "paid",
    inventoryReserved: false,
    settlement: "escrow",
    sponsored: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    ...overrides,
  };
  state.orders.set(order.id, order);
  return order;
}

function request(token: string | null, body: unknown = {}) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request("http://localhost/api/orders/order-1/escrow/ship", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const ctx = (action: string, id = "order-1") => ({
  params: Promise.resolve({ id, action }),
});

describe("escrow lifecycle routes", () => {
  beforeEach(() => {
    resetStore();
    seed();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication", async () => {
    expect((await prepare(request(null), ctx("ship"))).status).toBe(401);
    expect(prepareEscrowAction).not.toHaveBeenCalled();
  });

  it("hides orders from users who are neither merchant nor buyer", async () => {
    expect((await prepare(request("stranger-token"), ctx("ship"))).status).toBe(404);
    expect((await sync(request("stranger-token"), { params: Promise.resolve({ id: "order-1" }) })).status).toBe(404);
    expect(prepareEscrowAction).not.toHaveBeenCalled();
    expect(syncEscrowOrderStatus).not.toHaveBeenCalled();
  });

  it("treats a merchant DID with a different wallet as a stranger", async () => {
    // Same merchant DID, but Privy now resolves a different embedded wallet.
    vi.mocked(getPrivyEmbeddedSolanaWallet).mockResolvedValueOnce({
      address: "rotated-wallet",
      walletId: "w",
    });
    expect((await prepare(request("merchant-token"), ctx("ship"))).status).toBe(404);
    expect(prepareEscrowAction).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown action or order", async () => {
    expect((await prepare(request("merchant-token"), ctx("drain"))).status).toBe(404);
    expect((await prepare(request("merchant-token"), ctx("ship", "missing"))).status).toBe(404);
  });

  it.each([
    ["merchant-token", "ship", "merchant", "merchant-wallet"],
    ["merchant-token", "refund", "merchant", "merchant-wallet"],
    ["merchant-token", "claim", "merchant", "merchant-wallet"],
    ["buyer-token", "confirm-receipt", "buyer", "buyer-wallet"],
    ["buyer-token", "refund", "buyer", "buyer-wallet"],
  ])("lets %s prepare %s as %s", async (token, action, role, wallet) => {
    const response = await prepare(request(token), ctx(action));
    expect(response.status).toBe(200);
    expect(prepareEscrowAction).toHaveBeenCalledWith({
      order: expect.objectContaining({ id: "order-1" }),
      action,
      actor: { role, wallet },
    });
  });

  it.each([
    ["buyer-token", "ship"],
    ["buyer-token", "claim"],
    ["merchant-token", "confirm-receipt"],
  ])("refuses %s preparing %s", async (token, action) => {
    const response = await prepare(request(token), ctx(action));
    expect(response.status).toBe(403);
    expect(prepareEscrowAction).not.toHaveBeenCalled();
  });

  it("rejects any client-supplied action details", async () => {
    for (const body of [
      { destination: "attacker" },
      { wallet: "x" },
      { rentPayer: "x" },
    ]) {
      const response = await prepare(request("merchant-token", body), ctx("ship"));
      expect(response.status).toBe(400);
    }
    const response = await submit(
      request("merchant-token", { signedTransaction: "AA==", destination: "x" }),
      ctx("ship"),
    );
    expect(response.status).toBe(400);
    expect(prepareEscrowAction).not.toHaveBeenCalled();
    expect(submitEscrowAction).not.toHaveBeenCalled();
  });

  it("submits only the signed transaction for the resolved actor", async () => {
    const response = await submit(
      request("buyer-token", { signedTransaction: "c2lnbmVk" }),
      ctx("confirm-receipt"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ txSignature: "lifecycle-signature" });
    expect(submitEscrowAction).toHaveBeenCalledWith({
      order: expect.objectContaining({ id: "order-1" }),
      action: "confirm-receipt",
      actor: { role: "buyer", wallet: "buyer-wallet" },
      signedTransaction: "c2lnbmVk",
    });
    // Submitting does not change the stored status; only the sync does.
    expect(store.getOrder("order-1")?.status).toBe("paid");
  });

  it.each([
    ["window_not_elapsed", 409],
    ["escrow_state_mismatch", 409],
    ["actor_wallet_mismatch", 403],
  ])("maps %s to %i", async (code, status) => {
    vi.mocked(prepareEscrowAction).mockRejectedValueOnce(new EscrowActionError(code as never, "x"));
    const response = await prepare(request("merchant-token"), ctx("ship"));
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
  });

  it("reports the synced order and whether it changed", async () => {
    vi.mocked(syncEscrowOrderStatus).mockResolvedValueOnce({
      result: "updated",
      order: { ...store.getOrder("order-1")!, status: "shipped" },
    });
    const response = await sync(request("buyer-token"), { params: Promise.resolve({ id: "order-1" }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      changed: true,
      order: { status: "shipped" },
    });
  });
});
