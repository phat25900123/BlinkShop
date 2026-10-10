import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  decodeTransferCheckedInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createSponsoredUsdcTransferTransaction,
  SponsoredCheckoutError,
  type SponsoredCheckoutDependencies,
} from "../lib/backend/sponsored-checkout";

const mint = new PublicKey("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const buyer = Keypair.generate().publicKey;
const merchant = Keypair.generate().publicKey;
const merchantB = Keypair.generate().publicKey;
const sponsor = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

describe("sponsored Privy transaction construction", () => {
  beforeEach(() => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("MERCHANT_WALLET", merchant.toBase58());
    vi.stubEnv("SOLANA_CLUSTER", "devnet");
    vi.stubEnv(
      "SOLANA_SPONSOR_SECRET_KEY_BASE64",
      Buffer.from(sponsor.secretKey).toString("base64"),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function dependencies(
    accounts: "both" | "buyer-only" | "none",
    selectedMerchant = merchant,
  ): Promise<SponsoredCheckoutDependencies> {
    const buyerAta = await getAssociatedTokenAddress(mint, buyer);
    const merchantAta = await getAssociatedTokenAddress(mint, selectedMerchant);

    return {
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 100,
      }),
      loadTokenAccount: async (address) => {
        if (accounts !== "none" && address.equals(buyerAta)) {
          return { mint, owner: buyer };
        }
        if (accounts === "both" && address.equals(merchantAta)) {
          return { mint, owner: selectedMerchant };
        }
        return null;
      },
    };
  }

  it("builds one exact checked USDC transfer with no ATA or close instruction", async () => {
    const result = await createSponsoredUsdcTransferTransaction(
      buyer.toBase58(),
      merchant.toBase58(),
      0.6,
      await dependencies("both"),
    );
    const transaction = Transaction.from(
      Buffer.from(result.serializedTransaction, "base64"),
    );

    expect(transaction.instructions).toHaveLength(1);
    const instruction = transaction.instructions[0];
    expect(instruction.programId.equals(TOKEN_PROGRAM_ID)).toBe(true);
    expect(instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)).toBe(false);
    expect(instruction.programId.equals(SystemProgram.programId)).toBe(false);
    expect(instruction.programId.equals(ComputeBudgetProgram.programId)).toBe(false);
    expect(instruction.data[0]).not.toBe(9);

    const decoded = decodeTransferCheckedInstruction(instruction);
    expect(decoded.keys.source.pubkey.toBase58()).toBe(result.buyerTokenAccount);
    expect(decoded.keys.mint.pubkey.toBase58()).toBe(mint.toBase58());
    expect(decoded.keys.destination.pubkey.toBase58()).toBe(
      result.merchantTokenAccount,
    );
    expect(decoded.keys.owner.pubkey.toBase58()).toBe(buyer.toBase58());
    expect(decoded.data.amount).toBe(BigInt(600_000));
    expect(decoded.data.decimals).toBe(6);
    expect(transaction.feePayer?.toBase58()).toBe(sponsor.publicKey.toBase58());
    expect(transaction.signatures.map((entry) => entry.publicKey.toBase58())).toEqual([
      sponsor.publicKey.toBase58(),
      buyer.toBase58(),
    ]);
    expect(result.sponsorWallet).toBe(sponsor.publicKey.toBase58());
    expect(result.messageHash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(result.merchantWallet).toBe(merchant.toBase58());
    expect(result.usdcMint).toBe(mint.toBase58());
  });

  it("returns a controlled error when the buyer USDC ATA is missing", async () => {
    await expect(
      createSponsoredUsdcTransferTransaction(
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("none"),
      ),
    ).rejects.toMatchObject({
      code: "buyer_usdc_account_missing",
    } satisfies Partial<SponsoredCheckoutError>);
  });

  it("returns a controlled configuration error when the merchant USDC ATA is missing", async () => {
    await expect(
      createSponsoredUsdcTransferTransaction(
        buyer.toBase58(),
        merchant.toBase58(),
        0.3,
        await dependencies("buyer-only"),
      ),
    ).rejects.toMatchObject({
      code: "merchant_usdc_account_missing",
    } satisfies Partial<SponsoredCheckoutError>);
  });

  it("routes merchant B checkout to merchant B even when the legacy global points to A", async () => {
    vi.stubEnv("MERCHANT_WALLET", merchant.toBase58());
    const result = await createSponsoredUsdcTransferTransaction(
      buyer.toBase58(),
      merchantB.toBase58(),
      0.3,
      await dependencies("both", merchantB),
    );
    const transaction = Transaction.from(
      Buffer.from(result.serializedTransaction, "base64"),
    );
    const transfer = decodeTransferCheckedInstruction(
      transaction.instructions[0],
    );

    expect(result.merchantWallet).toBe(merchantB.toBase58());
    expect(transfer.keys.destination.pubkey.toBase58()).toBe(
      (await getAssociatedTokenAddress(mint, merchantB)).toBase58(),
    );
  });

  it("rejects a missing product-owned merchant payout wallet", async () => {
    await expect(
      createSponsoredUsdcTransferTransaction(
        buyer.toBase58(),
        "",
        0.3,
        await dependencies("both"),
      ),
    ).rejects.toMatchObject({ code: "configuration_missing" });
  });
});
