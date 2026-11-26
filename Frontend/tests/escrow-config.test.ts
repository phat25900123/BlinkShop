import { describe, expect, it } from "vitest";

import {
  DEFAULT_PROTECTION_WINDOW_SECONDS,
  DEFAULT_SHIP_WINDOW_SECONDS,
  ESCROW_MAX_WINDOW_SECONDS,
  getEscrowConfig,
  getSponsorLimits,
} from "../lib/backend/escrow-config";

const programId = "3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw";

describe("escrow configuration", () => {
  it("reads the program id and applies default windows", () => {
    const config = getEscrowConfig({ ESCROW_PROGRAM_ID: programId });

    expect(config.programId.toBase58()).toBe(programId);
    expect(config.shipWindowSeconds).toBe(BigInt(DEFAULT_SHIP_WINDOW_SECONDS));
    expect(config.protectionWindowSeconds).toBe(
      BigInt(DEFAULT_PROTECTION_WINDOW_SECONDS),
    );
    expect(DEFAULT_SHIP_WINDOW_SECONDS).toBe(604_800);
    expect(DEFAULT_PROTECTION_WINDOW_SECONDS).toBe(259_200);
  });

  it("reads explicit windows", () => {
    const config = getEscrowConfig({
      ESCROW_PROGRAM_ID: programId,
      SHIP_WINDOW_SECONDS: "60",
      PROTECTION_WINDOW_SECONDS: String(ESCROW_MAX_WINDOW_SECONDS),
    });

    expect(config.shipWindowSeconds).toBe(BigInt(60));
    expect(config.protectionWindowSeconds).toBe(
      BigInt(ESCROW_MAX_WINDOW_SECONDS),
    );
  });

  it("fails closed when the program id is missing", () => {
    expect(() => getEscrowConfig({})).toThrowError(
      expect.objectContaining({ code: "escrow_program_missing" }),
    );
  });

  it.each(["not-a-key", "11111111111111111111111111111111", ` x${programId}`])(
    "rejects an invalid program id %s",
    (value) => {
      expect(() => getEscrowConfig({ ESCROW_PROGRAM_ID: value })).toThrowError(
        expect.objectContaining({ code: "escrow_program_invalid" }),
      );
    },
  );

  it.each([
    "0",
    "-5",
    "1.5",
    "1e3",
    "abc",
    String(ESCROW_MAX_WINDOW_SECONDS + 1),
  ])("rejects an out-of-range or malformed window %s", (value) => {
    expect(() =>
      getEscrowConfig({ ESCROW_PROGRAM_ID: programId, SHIP_WINDOW_SECONDS: value }),
    ).toThrowError(expect.objectContaining({ code: "escrow_window_invalid" }));
    expect(() =>
      getEscrowConfig({
        ESCROW_PROGRAM_ID: programId,
        PROTECTION_WINDOW_SECONDS: value,
      }),
    ).toThrowError(expect.objectContaining({ code: "escrow_window_invalid" }));
  });
});

describe("sponsor limit configuration", () => {
  it("applies the documented defaults", () => {
    expect(getSponsorLimits({})).toEqual({
      minOrderBaseUnits: BigInt(10_000),
      buyerMaxPendingOrders: 3,
      buyerMaxOrdersPer24h: 30,
      sponsorMinBalanceLamports: 20_000_000,
    });
  });

  it("reads explicit values exactly in USDC base units", () => {
    expect(
      getSponsorLimits({
        MIN_ORDER_USDC: "1.5",
        BUYER_MAX_PENDING_ORDERS: "1",
        BUYER_MAX_ORDERS_PER_24H: "10",
        SPONSOR_MIN_BALANCE_LAMPORTS: "50000000",
      }),
    ).toEqual({
      minOrderBaseUnits: BigInt(1_500_000),
      buyerMaxPendingOrders: 1,
      buyerMaxOrdersPer24h: 10,
      sponsorMinBalanceLamports: 50_000_000,
    });
    expect(getSponsorLimits({ MIN_ORDER_USDC: "0.000001" }).minOrderBaseUnits).toBe(
      BigInt(1),
    );
  });

  it.each(["0", "0.0", "-1", "abc", "0.0000001", "1e-2"])(
    "rejects MIN_ORDER_USDC=%s",
    (value) => {
      expect(() => getSponsorLimits({ MIN_ORDER_USDC: value })).toThrowError(
        expect.objectContaining({ code: "sponsor_limit_invalid" }),
      );
    },
  );

  it.each([
    "BUYER_MAX_PENDING_ORDERS",
    "BUYER_MAX_ORDERS_PER_24H",
    "SPONSOR_MIN_BALANCE_LAMPORTS",
  ] as const)("rejects a zero, negative or fractional %s", (key) => {
    for (const value of ["0", "-1", "1.5", "x"]) {
      expect(() => getSponsorLimits({ [key]: value })).toThrowError(
        expect.objectContaining({ code: "sponsor_limit_invalid" }),
      );
    }
  });
});
