import { describe, expect, it, vi } from "vitest";

import {
  buyerActions,
  buyerActionsSupported,
  decodeBase64,
  encodeBase64,
  EscrowActionRequestError,
  formatCountdown,
  lifecycleBadge,
  merchantActions,
  revenueSummary,
  runEscrowAction,
  type EscrowTiming,
  type OrderView,
} from "../lib/escrow-ui";

const NOW = Date.parse("2026-11-26T12:00:00.000Z");
const iso = (offsetSeconds: number) => new Date(NOW + offsetSeconds * 1000).toISOString();

const timing = (overrides: Partial<EscrowTiming> = {}): EscrowTiming => ({
  status: "funded",
  shipBy: iso(3600),
  releaseAfter: null,
  ...overrides,
});

const order = (
  overrides: Partial<Pick<OrderView, "status" | "settlement" | "sponsored" | "amountUsdc">> = {},
) => ({
  status: "paid" as OrderView["status"],
  settlement: "escrow" as const,
  sponsored: true,
  amountUsdc: 1,
  ...overrides,
});

describe("lifecycle badge", () => {
  it.each([
    ["paid", "escrow", "Funded"],
    ["paid", "direct", "Paid"],
    ["shipped", "escrow", "Shipped"],
    ["released", "escrow", "Released"],
    ["refunded", "escrow", "Refunded"],
    ["pending", "escrow", "Pending"],
    ["failed", "escrow", "Failed"],
    ["cancelled", "escrow", "Cancelled"],
  ] as const)("%s/%s shows %s", (status, settlement, label) => {
    expect(lifecycleBadge({ status, settlement }).label).toBe(label);
  });
});

describe("merchant actions", () => {
  it("offers ship and refund on a funded escrow order", () => {
    expect(merchantActions(order(), timing(), NOW)).toEqual(["ship", "refund"]);
  });

  it("offers only refund while the protection window runs", () => {
    const shipped = order({ status: "shipped" });
    expect(merchantActions(shipped, timing({ status: "shipped", releaseAfter: iso(60) }), NOW))
      .toEqual(["refund"]);
    // Unknown deadline: never offer claim (the server would reject it anyway).
    expect(merchantActions(shipped, null, NOW)).toEqual(["refund"]);
  });

  it("adds claim once the protection window has ended", () => {
    const shipped = order({ status: "shipped" });
    expect(merchantActions(shipped, timing({ status: "shipped", releaseAfter: iso(0) }), NOW))
      .toEqual(["claim", "refund"]);
  });

  it.each(["pending", "released", "refunded", "failed", "cancelled"] as const)(
    "offers nothing on a %s order",
    (status) => {
      expect(merchantActions(order({ status }), timing(), NOW)).toEqual([]);
    },
  );

  it("offers nothing on a direct (pre-escrow) order", () => {
    expect(merchantActions(order({ settlement: "direct" }), null, NOW)).toEqual([]);
  });
});

describe("buyer actions", () => {
  it("offers confirm receipt when shipped", () => {
    expect(buyerActions(order({ status: "shipped" }), null, NOW)).toEqual(["confirm-receipt"]);
  });

  it("offers claim refund only strictly after the ship deadline", () => {
    expect(buyerActions(order(), timing({ shipBy: iso(60) }), NOW)).toEqual([]);
    // The program requires now > ship_by, so equal is still too early.
    expect(buyerActions(order(), timing({ shipBy: iso(0) }), NOW)).toEqual([]);
    expect(buyerActions(order(), timing({ shipBy: iso(-1) }), NOW)).toEqual(["refund"]);
    expect(buyerActions(order(), null, NOW)).toEqual([]);
  });

  it("hides buyer actions for Blink/Phantom (buyer-funded) orders", () => {
    const blink = order({ status: "shipped", sponsored: false });
    expect(buyerActionsSupported(blink)).toBe(false);
    expect(buyerActions(blink, null, NOW)).toEqual([]);
    expect(buyerActions(order({ sponsored: false }), timing({ shipBy: iso(-60) }), NOW)).toEqual([]);
  });

  it.each(["pending", "released", "refunded", "failed"] as const)(
    "offers nothing on a %s order",
    (status) => {
      expect(buyerActions(order({ status }), timing({ shipBy: iso(-60) }), NOW)).toEqual([]);
    },
  );
});

describe("countdown", () => {
  it.each([
    [2 * 86_400 + 3 * 3600 + 59, "2d 3h"],
    [3 * 3600 + 12 * 60 + 5, "3h 12m"],
    [4 * 60 + 9, "4m 9s"],
    [45, "45s"],
    [0, "ended"],
    [-10, "ended"],
  ])("%is left shows %s", (seconds, label) => {
    expect(formatCountdown(iso(seconds), NOW)).toBe(label);
  });

  it("returns null without a valid deadline", () => {
    expect(formatCountdown(null, NOW)).toBeNull();
    expect(formatCountdown("not a date", NOW)).toBeNull();
  });
});

describe("revenue summary", () => {
  it("splits released revenue from funds still in escrow", () => {
    const summary = revenueSummary([
      order({ status: "released", amountUsdc: 5 }),
      order({ status: "paid", settlement: "direct", amountUsdc: 2 }),
      order({ status: "paid", amountUsdc: 3 }),
      order({ status: "shipped", amountUsdc: 4 }),
      order({ status: "refunded", amountUsdc: 100 }),
      order({ status: "failed", amountUsdc: 100 }),
      order({ status: "pending", amountUsdc: 100 }),
      order({ status: "cancelled", amountUsdc: 100 }),
    ]);
    expect(summary).toEqual({ released: 7, inEscrow: 7 });
  });
});

describe("runEscrowAction", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  it("prepares, signs, submits only the signed bytes, then syncs", async () => {
    const unsigned = Uint8Array.from([1, 2, 3]);
    const signed = Uint8Array.from([9, 8, 7, 6]);
    const calls: { url: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.endsWith("/ship")) return json({ transaction: encodeBase64(unsigned) });
      if (url.endsWith("/ship/submit")) return json({ txSignature: "sig-1" });
      return json({ order: { id: "order-1", status: "shipped" }, changed: true, escrow: null });
    });
    const sign = vi.fn(async () => signed);
    const steps: string[] = [];

    const result = await runEscrowAction({
      orderId: "order-1",
      action: "ship",
      fetcher,
      sign,
      onStep: (step) => steps.push(step),
    });

    expect(sign).toHaveBeenCalledWith(unsigned);
    expect(calls).toEqual([
      { url: "/api/orders/order-1/escrow/ship", body: {} },
      {
        url: "/api/orders/order-1/escrow/ship/submit",
        body: { signedTransaction: encodeBase64(signed) },
      },
      { url: "/api/orders/order-1/escrow", body: {} },
    ]);
    expect(steps).toEqual(["preparing", "signing", "submitting", "syncing"]);
    expect(result.txSignature).toBe("sig-1");
    expect(result.synced?.changed).toBe(true);
  });

  it("retries the sync a few times while the RPC lags", async () => {
    let syncs = 0;
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith("/claim")) return json({ transaction: encodeBase64(new Uint8Array([1])) });
      if (url.endsWith("/submit")) return json({ txSignature: "sig" });
      syncs += 1;
      return json({ order: {}, changed: syncs === 3, escrow: null });
    });
    const wait = vi.fn(async () => undefined);
    const result = await runEscrowAction({
      orderId: "o",
      action: "claim",
      fetcher,
      sign: async (tx) => tx,
      wait,
    });
    expect(syncs).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(result.synced?.changed).toBe(true);
  });

  it("stops before signing when prepare is rejected, with a clear message", async () => {
    const fetcher = vi.fn(async () =>
      json({ error: "raw", code: "window_not_elapsed" }, 409),
    );
    const sign = vi.fn();
    const error = await runEscrowAction({
      orderId: "o",
      action: "claim",
      fetcher,
      sign,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EscrowActionRequestError);
    expect(error).toMatchObject({
      code: "window_not_elapsed",
      status: 409,
      message: "The time window for this action has not ended yet.",
    });
    expect(sign).not.toHaveBeenCalled();
  });

  it("does not submit when the signer cancels", async () => {
    const fetcher = vi.fn(async () => json({ transaction: encodeBase64(new Uint8Array([1])) }));
    await expect(
      runEscrowAction({
        orderId: "o",
        action: "refund",
        fetcher,
        sign: async () => {
          throw new Error("User rejected the request");
        },
      }),
    ).rejects.toThrow("User rejected");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back to the server error text for unknown codes", async () => {
    const fetcher = vi.fn(async () => json({ error: "Order not found" }, 404));
    await expect(
      runEscrowAction({ orderId: "o", action: "ship", fetcher, sign: vi.fn() }),
    ).rejects.toMatchObject({ message: "Order not found", status: 404 });
  });

  it("escapes the order id in request paths", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string) => {
      urls.push(url);
      return json({ error: "x" }, 404);
    });
    await runEscrowAction({ orderId: "../products", action: "ship", fetcher, sign: vi.fn() })
      .catch(() => undefined);
    expect(urls).toEqual(["/api/orders/..%2Fproducts/escrow/ship"]);
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes", () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 255]);
    expect(decodeBase64(encodeBase64(bytes))).toEqual(bytes);
  });
});
