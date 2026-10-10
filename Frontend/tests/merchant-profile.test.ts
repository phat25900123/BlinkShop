import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/backend/privy", () => {
  class PrivyConfigurationError extends Error {}

  return {
    PrivyConfigurationError,
    verifyPrivyAccessToken: vi.fn(async (token: string) => {
      if (token === "merchant-a-token") {
        return { userId: "did:privy:merchant-a" };
      }
      if (token === "merchant-b-token") {
        return { userId: "did:privy:merchant-b" };
      }
      if (token === "configuration-error") {
        throw new PrivyConfigurationError();
      }
      throw new Error("Invalid token");
    }),
    getPrivyEmbeddedSolanaWallet: vi.fn(async (userId: string) => ({
      address:
        userId === "did:privy:merchant-a"
          ? "11111111111111111111111111111111"
          : "Vote111111111111111111111111111111111111111",
      walletId: `wallet-${userId}`,
    })),
  };
});

vi.mock("../lib/backend/solana", () => ({
  getMerchantPayoutReadiness: vi.fn(async (wallet: string) => ({
    payoutUsdcAta: `ata:${wallet}`,
    payoutReady: true,
  })),
}));

import { GET as getMerchantProfile } from "../app/api/merchant/me/route";
import { getPrivyEmbeddedSolanaWallet } from "../lib/backend/privy";
import { getMerchantPayoutReadiness } from "../lib/backend/solana";

function request(token?: string, query = "") {
  return new NextRequest(`http://localhost/api/merchant/me${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

describe("merchant payout profile", () => {
  beforeEach(() => {
    vi.mocked(getMerchantPayoutReadiness).mockResolvedValue({
      payoutUsdcAta: "merchant-usdc-ata",
      payoutReady: true,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requires authentication", async () => {
    expect((await getMerchantProfile(request())).status).toBe(401);
  });

  it("rejects an invalid Privy token", async () => {
    expect(
      (await getMerchantProfile(request("invalid-token"))).status,
    ).toBe(401);
  });

  it("returns a controlled 503 for missing Privy server configuration", async () => {
    expect(
      (await getMerchantProfile(request("configuration-error"))).status,
    ).toBe(503);
  });

  it.each([
    [
      "merchant-a-token",
      "did:privy:merchant-a",
      "11111111111111111111111111111111",
    ],
    [
      "merchant-b-token",
      "did:privy:merchant-b",
      "Vote111111111111111111111111111111111111111",
    ],
  ])(
    "returns the authenticated merchant identity and embedded payout wallet for %s",
    async (token, merchantId, payoutWallet) => {
      const response = await getMerchantProfile(request(token));
      const data = (await response.json()) as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(data).toMatchObject({
        merchantId,
        payoutWallet,
        payoutUsdcAta: "merchant-usdc-ata",
        payoutReady: true,
      });
      expect(getPrivyEmbeddedSolanaWallet).toHaveBeenCalledWith(merchantId);
      expect(getMerchantPayoutReadiness).toHaveBeenCalledWith(payoutWallet);
    },
  );

  it("ignores attempts to request another merchant through query parameters", async () => {
    const response = await getMerchantProfile(
      request("merchant-a-token", "?merchantId=did:privy:merchant-b"),
    );
    const data = (await response.json()) as {
      merchantId: string;
      payoutWallet: string;
    };

    expect(data.merchantId).toBe("did:privy:merchant-a");
    expect(data.payoutWallet).toBe("11111111111111111111111111111111");
  });

  it("reports setup required without requiring a positive USDC balance", async () => {
    vi.mocked(getMerchantPayoutReadiness).mockResolvedValueOnce({
      payoutUsdcAta: "merchant-usdc-ata",
      payoutReady: false,
    });
    const response = await getMerchantProfile(request("merchant-a-token"));
    const data = (await response.json()) as { payoutReady: boolean };

    expect(response.status).toBe(200);
    expect(data.payoutReady).toBe(false);
  });

  it("returns 409 while the embedded merchant wallet is provisioning", async () => {
    vi.mocked(getPrivyEmbeddedSolanaWallet).mockResolvedValueOnce(null);
    const response = await getMerchantProfile(request("merchant-a-token"));
    const data = (await response.json()) as { code?: string };

    expect(response.status).toBe(409);
    expect(data.code).toBe("embedded_wallet_unavailable");
  });

  it("returns a controlled 502 when Privy user lookup fails", async () => {
    vi.mocked(getPrivyEmbeddedSolanaWallet).mockRejectedValueOnce(
      new Error("Privy unavailable"),
    );
    const response = await getMerchantProfile(request("merchant-a-token"));

    expect(response.status).toBe(502);
  });

  it("returns a controlled 503 when Solana payment configuration is missing", async () => {
    vi.mocked(getMerchantPayoutReadiness).mockRejectedValueOnce(
      new Error("Solana payment configuration is missing"),
    );
    const response = await getMerchantProfile(request("merchant-a-token"));

    expect(response.status).toBe(503);
  });

  it("returns a controlled 502 when payout readiness RPC lookup fails", async () => {
    vi.mocked(getMerchantPayoutReadiness).mockRejectedValueOnce(
      new Error("RPC unavailable"),
    );
    const response = await getMerchantProfile(request("merchant-a-token"));

    expect(response.status).toBe(502);
  });
});
