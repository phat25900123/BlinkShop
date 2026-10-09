import "server-only";

import { Keypair } from "@solana/web3.js";

export type SolanaSponsorErrorCode =
  | "sponsor_cluster_invalid"
  | "sponsor_secret_missing"
  | "sponsor_secret_invalid";

export class SolanaSponsorConfigurationError extends Error {
  constructor(
    public readonly code: SolanaSponsorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SolanaSponsorConfigurationError";
  }
}

type SponsorEnvironment = {
  SOLANA_CLUSTER?: string;
  SOLANA_SPONSOR_SECRET_KEY_BASE64?: string;
};

function requireDevnet(environment: SponsorEnvironment) {
  if (environment.SOLANA_CLUSTER?.trim().toLowerCase() !== "devnet") {
    throw new SolanaSponsorConfigurationError(
      "sponsor_cluster_invalid",
      "BlinkShop fee sponsorship is configured for Solana Devnet only.",
    );
  }
}

export function getSolanaSponsorKeypair(
  environment: SponsorEnvironment = {
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
    SOLANA_SPONSOR_SECRET_KEY_BASE64:
      process.env.SOLANA_SPONSOR_SECRET_KEY_BASE64,
  },
) {
  requireDevnet(environment);

  const encodedSecret = environment.SOLANA_SPONSOR_SECRET_KEY_BASE64?.trim();
  if (!encodedSecret) {
    throw new SolanaSponsorConfigurationError(
      "sponsor_secret_missing",
      "The BlinkShop Devnet sponsor wallet is not configured.",
    );
  }

  try {
    const secret = Buffer.from(encodedSecret, "base64");
    if (
      secret.length !== 64 ||
      secret.toString("base64") !== encodedSecret
    ) {
      throw new Error("Invalid sponsor secret encoding");
    }

    return Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch {
    throw new SolanaSponsorConfigurationError(
      "sponsor_secret_invalid",
      "The BlinkShop Devnet sponsor wallet configuration is invalid.",
    );
  }
}

export function getSolanaSponsorPublicKey(
  environment: SponsorEnvironment = {
    SOLANA_CLUSTER: process.env.SOLANA_CLUSTER,
    SOLANA_SPONSOR_SECRET_KEY_BASE64:
      process.env.SOLANA_SPONSOR_SECRET_KEY_BASE64,
  },
) {
  return getSolanaSponsorKeypair(environment).publicKey;
}
