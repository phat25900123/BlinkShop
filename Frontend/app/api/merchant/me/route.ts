import { NextRequest, NextResponse } from "next/server";
import { PublicKey } from "@solana/web3.js";

import { requirePrivyUser } from "@/lib/backend/auth";
import { getPrivyEmbeddedSolanaWallet } from "@/lib/backend/privy";
import { getMerchantPayoutReadiness } from "@/lib/backend/solana";

function errorResponse(error: string, status: number, code?: string) {
  return NextResponse.json(
    { error, ...(code ? { code } : {}) },
    { status },
  );
}

export async function GET(request: NextRequest) {
  const authentication = await requirePrivyUser(request);
  if (!authentication.ok) return authentication.response;

  let wallet: Awaited<ReturnType<typeof getPrivyEmbeddedSolanaWallet>>;
  try {
    wallet = await getPrivyEmbeddedSolanaWallet(authentication.user.userId);
  } catch {
    return errorResponse(
      "Unable to load your merchant payout wallet",
      502,
      "privy_user_lookup_failed",
    );
  }

  if (!wallet) {
    return errorResponse(
      "Your merchant wallet is still being created. Please wait and try again.",
      409,
      "embedded_wallet_unavailable",
    );
  }

  try {
    new PublicKey(wallet.address);
  } catch {
    return errorResponse(
      "Your merchant payout wallet is not a valid Solana address",
      502,
      "embedded_wallet_invalid",
    );
  }

  try {
    const readiness = await getMerchantPayoutReadiness(wallet.address);

    return NextResponse.json({
      merchantId: authentication.user.userId,
      payoutWallet: wallet.address,
      ...readiness,
    });
  } catch (error) {
    const configurationMissing =
      error instanceof Error &&
      error.message === "Solana payment configuration is missing";

    return errorResponse(
      configurationMissing
        ? "Solana payment configuration is missing"
        : "Unable to check your Devnet USDC payout account",
      configurationMissing ? 503 : 502,
      configurationMissing
        ? "solana_configuration_missing"
        : "payout_readiness_unavailable",
    );
  }
}
