import { createHash } from "node:crypto";

import {
  Keypair,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { decodeEscrowOrderAccount } from "../lib/backend/escrow";
import {
  verifyEscrowPayment,
  type EscrowPaymentVerificationDependencies,
} from "../lib/backend/solana";

const keypair = (offset: number) =>
  Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => (i + offset) % 256)).publicKey;

const programId = new PublicKey("3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw");
const mint = keypair(1);
const otherMint = keypair(11);
const buyer = keypair(21);
const merchant = keypair(31);
const merchantB = keypair(41);
const attacker = keypair(51);
const sponsor = keypair(61);

const expected = {
  orderId: "order-1",
  buyerWallet: buyer.toBase58(),
  merchantWallet: merchant.toBase58(),
  amountUsdc: 0.6,
};

const sha256 = (value: string) => createHash("sha256").update(value).digest();
const orderPda = (merchantKey: PublicKey, orderId: string) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("order"), merchantKey.toBuffer(), sha256(orderId)],
    programId,
  )[0];
const vaultPda = (order: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("vault"), order.toBuffer()], programId)[0];

const ORDER = orderPda(merchant, "order-1");
const VAULT = vaultPda(ORDER);

type OrderFields = {
  discriminator: Buffer;
  orderId: Buffer;
  merchant: PublicKey;
  buyer: PublicKey;
  rentPayer: PublicKey;
  mint: PublicKey;
  amount: bigint;
  status: number;
  length: number;
};

// Independent borsh layout of `pub struct Order` (lib.rs), not the app decoder.
function orderAccountData(overrides: Partial<OrderFields> = {}) {
  const fields: OrderFields = {
    discriminator: sha256("account:Order").subarray(0, 8),
    orderId: sha256("order-1"),
    merchant,
    buyer,
    rentPayer: sponsor,
    mint,
    amount: BigInt(600_000),
    status: 0,
    length: 210,
    ...overrides,
  };
  const data = Buffer.alloc(fields.length);
  fields.discriminator.copy(data, 0);
  fields.orderId.copy(data, 8);
  fields.merchant.toBuffer().copy(data, 40);
  fields.buyer.toBuffer().copy(data, 72);
  fields.rentPayer.toBuffer().copy(data, 104);
  fields.mint.toBuffer().copy(data, 136);
  if (fields.length >= 210) {
    data.writeBigUInt64LE(fields.amount, 168);
    data[176] = fields.status;
    data.writeBigInt64LE(BigInt(1_700_000_000), 177);
    data.writeBigInt64LE(BigInt(1_700_604_800), 185);
    data.writeBigInt64LE(BigInt(259_200), 193);
    data.writeBigInt64LE(BigInt(0), 201);
    data[209] = 254;
  }
  return data;
}

function parsedTransaction(options: { err?: unknown; keys?: PublicKey[] } = {}) {
  return {
    meta: { err: options.err ?? null, preTokenBalances: [], postTokenBalances: [] },
    transaction: {
      message: {
        accountKeys: (options.keys ?? [sponsor, buyer, ORDER, VAULT, programId]).map(
          (pubkey) => ({ pubkey, signer: false, writable: false }),
        ),
        instructions: [],
      },
      signatures: ["sig"],
    },
  } as unknown as ParsedTransactionWithMeta;
}

function dependencies(
  overrides: Partial<EscrowPaymentVerificationDependencies> = {},
): EscrowPaymentVerificationDependencies {
  return {
    getParsedTransaction: vi.fn(async () => parsedTransaction()),
    getAccountInfo: vi.fn(async (address: PublicKey) =>
      address.equals(ORDER) ? { owner: programId, data: orderAccountData() } : null,
    ),
    loadTokenAccount: vi.fn(async (address: PublicKey) =>
      address.equals(VAULT) ? { mint, owner: ORDER, amount: BigInt(600_000) } : null,
    ),
    ...overrides,
  };
}

const verify = (
  deps = dependencies(),
  expectation: typeof expected = expected,
) => verifyEscrowPayment("sig", expectation, deps);

describe("escrow payment verification from on-chain state", () => {
  beforeEach(() => {
    vi.stubEnv("SOLANA_USDC_MINT", mint.toBase58());
    vi.stubEnv("ESCROW_PROGRAM_ID", programId.toBase58());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a Funded order PDA and a vault holding exactly the amount", async () => {
    const deps = dependencies();
    expect(await verify(deps)).toBe("valid");
    expect(vi.mocked(deps.getAccountInfo).mock.calls[0][0].equals(ORDER)).toBe(true);
    expect(vi.mocked(deps.loadTokenAccount).mock.calls[0][0].equals(VAULT)).toBe(true);
  });

  it("also accepts a Shipped order while the vault still holds the amount", async () => {
    expect(
      await verify(
        dependencies({
          getAccountInfo: vi.fn(async () => ({
            owner: programId,
            data: orderAccountData({ status: 1 }),
          })),
        }),
      ),
    ).toBe("valid");
  });

  it("rejects a Shipped order whose vault no longer holds the amount", async () => {
    expect(
      await verify(
        dependencies({
          getAccountInfo: vi.fn(async () => ({
            owner: programId,
            data: orderAccountData({ status: 1 }),
          })),
          loadTokenAccount: vi.fn(async () => ({ mint, owner: ORDER, amount: BigInt(1) })),
        }),
      ),
    ).toBe("invalid");
  });

  it("does not depend on token balance deltas", async () => {
    // parsedTransaction() carries no pre/post token balances at all.
    expect(await verify()).toBe("valid");
  });

  it("decodes the independent fixture with the app decoder", () => {
    expect(decodeEscrowOrderAccount(orderAccountData())).toMatchObject({
      amount: BigInt(600_000),
      status: "funded",
      bump: 254,
      protectionWindow: BigInt(259_200),
    });
  });

  describe("transaction evidence", () => {
    it("is pending while the transaction is not visible", async () => {
      expect(
        await verify(dependencies({ getParsedTransaction: vi.fn(async () => null) })),
      ).toBe("pending");
    });

    it("rejects a failed transaction", async () => {
      expect(
        await verify(
          dependencies({
            getParsedTransaction: vi.fn(async () =>
              parsedTransaction({ err: { InstructionError: [0, "Custom"] } }),
            ),
          }),
        ),
      ).toBe("invalid");
    });

    it.each([
      ["the order PDA", [sponsor, buyer, VAULT, programId]],
      ["the escrow program", [sponsor, buyer, ORDER, VAULT]],
    ])("rejects an unrelated signature that does not touch %s", async (_label, keys) => {
      expect(
        await verify(
          dependencies({
            getParsedTransaction: vi.fn(async () => parsedTransaction({ keys })),
          }),
        ),
      ).toBe("invalid");
    });
  });

  describe("order account", () => {
    it("is pending when the transaction is visible but the account is not yet", async () => {
      expect(
        await verify(dependencies({ getAccountInfo: vi.fn(async () => null) })),
      ).toBe("pending");
    });

    it("rejects an order account not owned by the escrow program", async () => {
      expect(
        await verify(
          dependencies({
            getAccountInfo: vi.fn(async () => ({ owner: attacker, data: orderAccountData() })),
          }),
        ),
      ).toBe("invalid");
    });

    it.each([
      ["discriminator", { discriminator: Buffer.alloc(8) }],
      ["length", { length: 209 }],
      ["order id", { orderId: sha256("order-2") }],
      ["merchant", { merchant: attacker }],
      ["buyer", { buyer: attacker }],
      ["mint", { mint: otherMint }],
      ["amount (underpaid)", { amount: BigInt(599_999) }],
      ["amount (overpaid)", { amount: BigInt(600_001) }],
      ["status Released", { status: 2 }],
      ["status Refunded", { status: 3 }],
      ["unknown status", { status: 9 }],
    ] as const)("rejects a wrong %s", async (_label, override) => {
      expect(
        await verify(
          dependencies({
            getAccountInfo: vi.fn(async () => ({
              owner: programId,
              data: orderAccountData(override as Partial<OrderFields>),
            })),
          }),
        ),
      ).toBe("invalid");
    });
  });

  describe("vault", () => {
    it.each([
      ["missing", null],
      ["for another mint", { mint: otherMint, owner: ORDER, amount: BigInt(600_000) }],
      ["controlled by someone else", { mint, owner: attacker, amount: BigInt(600_000) }],
      ["short of the amount", { mint, owner: ORDER, amount: BigInt(599_999) }],
      ["already emptied", { mint, owner: ORDER, amount: BigInt(0) }],
    ])("rejects a vault that is %s", async (_label, vault) => {
      expect(
        await verify(dependencies({ loadTokenAccount: vi.fn(async () => vault) })),
      ).toBe("invalid");
    });
  });

  it("keeps merchants isolated: merchant A's funded escrow does not pay merchant B's order", async () => {
    const result = await verify(dependencies(), {
      ...expected,
      merchantWallet: merchantB.toBase58(),
    });
    expect(result).toBe("invalid");
  });

  it("derives everything from the server order, including the escrow program id", async () => {
    vi.stubEnv("ESCROW_PROGRAM_ID", attacker.toBase58());
    expect(await verify()).toBe("invalid");
  });
});
