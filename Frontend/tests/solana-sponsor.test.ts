import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  getSolanaSponsorKeypair,
  getSolanaSponsorPublicKey,
} from "../lib/backend/solana-sponsor";

const sponsor = Keypair.fromSeed(
  Uint8Array.from({ length: 32 }, (_, index) => index + 11),
);

describe("Solana Devnet sponsor configuration", () => {
  it("fails closed when the sponsor secret is missing", () => {
    expect(() =>
      getSolanaSponsorKeypair({ SOLANA_CLUSTER: "devnet" }),
    ).toThrowError(/not configured/i);
  });

  it("rejects malformed and non-64-byte sponsor secrets", () => {
    expect(() =>
      getSolanaSponsorKeypair({
        SOLANA_CLUSTER: "devnet",
        SOLANA_SPONSOR_SECRET_KEY_BASE64: "not-base64",
      }),
    ).toThrowError(/invalid/i);
  });

  it("rejects every cluster except explicit Devnet", () => {
    expect(() =>
      getSolanaSponsorKeypair({
        SOLANA_CLUSTER: "mainnet-beta",
        SOLANA_SPONSOR_SECRET_KEY_BASE64: Buffer.from(
          sponsor.secretKey,
        ).toString("base64"),
      }),
    ).toThrowError(/Devnet only/i);
  });

  it("derives the public key from the configured 64-byte secret", () => {
    const environment = {
      SOLANA_CLUSTER: "devnet",
      SOLANA_SPONSOR_SECRET_KEY_BASE64: Buffer.from(
        sponsor.secretKey,
      ).toString("base64"),
    };

    expect(getSolanaSponsorKeypair(environment).secretKey).toEqual(
      sponsor.secretKey,
    );
    expect(getSolanaSponsorPublicKey(environment).toBase58()).toBe(
      sponsor.publicKey.toBase58(),
    );
  });
});
