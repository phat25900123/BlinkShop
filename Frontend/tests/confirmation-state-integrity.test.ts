import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as confirmAction } from "../app/api/actions/product/[id]/confirm/route";
import { POST as confirmOrder } from "../app/api/orders/confirm/route";
import { verifyEscrowPayment, verifyUsdcPayment } from "../lib/backend/solana";
import { store } from "../lib/backend/store";
import { state } from "../lib/backend/store-state";
import { addProduct, resetStore } from "./helpers/store-fixtures";

vi.mock("@/lib/backend/solana", () => ({
  verifyUsdcPayment: vi.fn(),
  verifyEscrowPayment: vi.fn(),
}));

const buyerWallet = "11111111111111111111111111111111";

function reserveOrder() {
  const product = addProduct({ inventory: 6 });
  const order = store.createOrder({
    productId: product.id,
    buyerWallet,
    quantity: 1,
    amountUsdc: product.priceUsdc,
  });

  if (!order) throw new Error("Expected order reservation to succeed");
  return order;
}

function orderRequest(orderId: string, txSignature: string) {
  return new Request("http://localhost/api/orders/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderId, txSignature }),
  }) as NextRequest;
}

function actionRequest(orderId: string, productId: string, signature: string) {
  return new Request(
    `http://localhost/api/actions/product/${productId}/confirm?orderId=${orderId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signature, account: buyerWallet }),
    },
  ) as NextRequest;
}

async function finishPendingVerification<T>(responsePromise: Promise<T>) {
  await Promise.resolve();
  await vi.runAllTimersAsync();
  return responsePromise;
}

function expectReservationIntact(orderId: string, productId: string) {
  expect(store.getOrder(orderId)).toMatchObject({
    status: "pending",
    inventoryReserved: true,
  });
  expect(store.getOrder(orderId)?.txSignature).toBeUndefined();
  expect(store.getProduct(productId)?.inventory).toBe(5);
}

describe("confirmation state integrity", () => {
  beforeEach(() => {
    resetStore();
    vi.useFakeTimers();
    vi.mocked(verifyUsdcPayment).mockReset().mockResolvedValue("valid");
    vi.mocked(verifyEscrowPayment).mockReset().mockResolvedValue("valid");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a pending signature unbound in the generic confirmation route", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("pending");

    const response = await finishPendingVerification(
      confirmOrder(orderRequest(order.id, "nonexistent-signature")),
    );

    expect(response.status).toBe(202);
    expectReservationIntact(order.id, order.productId);
  });

  it("keeps an invalid signature from failing the generic order", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("invalid");

    const response = await confirmOrder(
      orderRequest(order.id, "invalid-signature"),
    );

    expect(response.status).toBe(422);
    expectReservationIntact(order.id, order.productId);
  });

  it("accepts a legitimate signature after a malicious pending attempt", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("pending");

    await finishPendingVerification(
      confirmOrder(orderRequest(order.id, "malicious-signature")),
    );
    expectReservationIntact(order.id, order.productId);

    vi.mocked(verifyEscrowPayment).mockResolvedValue("valid");
    const response = await confirmOrder(
      orderRequest(order.id, "real-signature"),
    );

    expect(response.status).toBe(200);
    expect(store.getOrder(order.id)).toMatchObject({
      status: "paid",
      txSignature: "real-signature",
      inventoryReserved: false,
    });
  });

  it("accepts a legitimate signature after an invalid attempt", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("invalid");

    expect(
      (await confirmOrder(orderRequest(order.id, "invalid-signature"))).status,
    ).toBe(422);
    expectReservationIntact(order.id, order.productId);

    vi.mocked(verifyEscrowPayment).mockResolvedValue("valid");
    const response = await confirmOrder(
      orderRequest(order.id, "real-signature"),
    );

    expect(response.status).toBe(200);
    expect(store.getOrder(order.id)).toMatchObject({
      status: "paid",
      txSignature: "real-signature",
    });
  });

  it("binds a valid signature only after verification completes", async () => {
    const order = reserveOrder();
    let markVerificationStarted!: () => void;
    let resolveVerification!: (result: "valid") => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const verificationResult = new Promise<"valid">((resolve) => {
      resolveVerification = resolve;
    });

    vi.mocked(verifyEscrowPayment).mockImplementationOnce(async () => {
      markVerificationStarted();
      return verificationResult;
    });

    const responsePromise = confirmOrder(
      orderRequest(order.id, "verified-signature"),
    );
    await verificationStarted;

    expectReservationIntact(order.id, order.productId);

    resolveVerification("valid");
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(store.getOrder(order.id)).toMatchObject({
      status: "paid",
      txSignature: "verified-signature",
    });
  });

  it("re-checks expiry after asynchronous verification before binding", async () => {
    const order = reserveOrder();
    let markVerificationStarted!: () => void;
    let resolveVerification!: (result: "valid") => void;
    const verificationStarted = new Promise<void>((resolve) => {
      markVerificationStarted = resolve;
    });
    const verificationResult = new Promise<"valid">((resolve) => {
      resolveVerification = resolve;
    });

    vi.mocked(verifyEscrowPayment).mockImplementationOnce(async () => {
      markVerificationStarted();
      return verificationResult;
    });

    const responsePromise = confirmOrder(
      orderRequest(order.id, "late-signature"),
    );
    await verificationStarted;
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    resolveVerification("valid");

    const response = await responsePromise;

    expect(response.status).toBe(409);
    expect(store.getOrder(order.id)).toMatchObject({
      status: "cancelled",
      inventoryReserved: false,
    });
    expect(store.getOrder(order.id)?.txSignature).toBeUndefined();
    expect(store.getProduct(order.productId)?.inventory).toBe(6);
  });

  it("does not bind a pending signature in the Solana Action route", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("pending");

    const response = await finishPendingVerification(
      confirmAction(
        actionRequest(order.id, order.productId, "nonexistent-signature"),
        { params: Promise.resolve({ id: order.productId }) },
      ),
    );

    expect(response.status).toBe(409);
    expectReservationIntact(order.id, order.productId);
  });

  it("does not fail or bind an invalid signature in the Solana Action route", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("invalid");

    const response = await confirmAction(
      actionRequest(order.id, order.productId, "invalid-signature"),
      { params: Promise.resolve({ id: order.productId }) },
    );

    expect(response.status).toBe(422);
    expectReservationIntact(order.id, order.productId);
  });

  it("accepts a legitimate Action signature after a pending attempt", async () => {
    const order = reserveOrder();
    vi.mocked(verifyEscrowPayment).mockResolvedValue("pending");

    await finishPendingVerification(
      confirmAction(
        actionRequest(order.id, order.productId, "malicious-signature"),
        { params: Promise.resolve({ id: order.productId }) },
      ),
    );
    expectReservationIntact(order.id, order.productId);

    vi.mocked(verifyEscrowPayment).mockResolvedValue("valid");
    const response = await confirmAction(
      actionRequest(order.id, order.productId, "real-signature"),
      { params: Promise.resolve({ id: order.productId }) },
    );

    expect(response.status).toBe(200);
    expect(store.getOrder(order.id)).toMatchObject({
      status: "paid",
      txSignature: "real-signature",
      inventoryReserved: false,
    });
  });

  it("verifies new orders from escrow state in both confirmation routes", async () => {
    const generic = reserveOrder();
    expect(generic.settlement).toBe("escrow");
    await confirmOrder(orderRequest(generic.id, "escrow-signature-a"));

    const action = reserveOrder();
    await confirmAction(
      actionRequest(action.id, action.productId, "escrow-signature-b"),
      { params: Promise.resolve({ id: action.productId }) },
    );

    expect(verifyEscrowPayment).toHaveBeenCalledTimes(2);
    expect(verifyEscrowPayment).toHaveBeenCalledWith("escrow-signature-a", {
      orderId: generic.id,
      buyerWallet: generic.buyerWallet,
      merchantWallet: generic.merchantWallet,
      amountUsdc: generic.amountUsdc,
    });
    expect(verifyUsdcPayment).not.toHaveBeenCalled();
  });

  it("keeps legacy direct orders on transfer verification in both routes", async () => {
    const generic = reserveOrder();
    const action = reserveOrder();
    for (const order of [generic, action]) {
      state.orders.set(order.id, { ...store.getOrder(order.id)!, settlement: "direct" });
    }

    expect((await confirmOrder(orderRequest(generic.id, "direct-signature-a"))).status).toBe(200);
    expect(
      (await confirmAction(
        actionRequest(action.id, action.productId, "direct-signature-b"),
        { params: Promise.resolve({ id: action.productId }) },
      )).status,
    ).toBe(200);

    expect(verifyUsdcPayment).toHaveBeenCalledTimes(2);
    expect(verifyEscrowPayment).not.toHaveBeenCalled();
  });
});
