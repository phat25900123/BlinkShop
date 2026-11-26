import { createHash } from "node:crypto";

import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { describe, expect, it } from "vitest";

import {
  CREATE_ORDER_ACCOUNTS,
  CREATE_ORDER_DISCRIMINATOR,
  createEscrowOrderInstruction,
  decodeCreateOrderData,
  encodeCreateOrderData,
  escrowOrderId,
  findEscrowOrderAddress,
  findEscrowVaultAddress,
} from "../lib/backend/escrow";

const programId = new PublicKey("3T1GHqWTm8DhvwsoxoYRy5mRDoHgR4zCoEuf2nVxZcmw");

const anchorDiscriminator = (namespace: string, name: string) =>
  createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);

describe("escrow instruction encoding", () => {
  it("pins the create_order discriminator to the Anchor derivation and the IDL", () => {
    expect(CREATE_ORDER_DISCRIMINATOR.equals(anchorDiscriminator("global", "create_order"))).toBe(true);
    // Value from program/target/idl/blinkshop_escrow.json (generated, gitignored).
    expect([...CREATE_ORDER_DISCRIMINATOR]).toEqual([141, 54, 37, 207, 237, 210, 250, 215]);
  });

  it("derives the on-chain order id as sha256 of the BlinkShop order id", () => {
    const id = escrowOrderId("order-123");
    expect(id).toHaveLength(32);
    expect(id.equals(createHash("sha256").update("order-123").digest())).toBe(true);
    expect(escrowOrderId("order-124").equals(id)).toBe(false);
  });

  it("derives the order and vault PDAs from the program seeds", () => {
    const merchant = Keypair.generate().publicKey;
    const id = escrowOrderId("order-1");
    const order = findEscrowOrderAddress(programId, merchant, id);
    const vault = findEscrowVaultAddress(programId, order);

    expect(order.equals(
      PublicKey.findProgramAddressSync(
        [Buffer.from("order"), merchant.toBuffer(), id],
        programId,
      )[0],
    )).toBe(true);
    expect(vault.equals(
      PublicKey.findProgramAddressSync([Buffer.from("vault"), order.toBuffer()], programId)[0],
    )).toBe(true);
    // Merchant isolation: the same order id under another merchant is a different account.
    expect(
      findEscrowOrderAddress(programId, Keypair.generate().publicKey, id).equals(order),
    ).toBe(false);
  });

  it("encodes args little-endian and round-trips them", () => {
    const args = {
      orderId: escrowOrderId("o"),
      amount: BigInt(600_000),
      shipWindowSeconds: BigInt(604_800),
      protectionWindowSeconds: BigInt(259_200),
    };
    const data = encodeCreateOrderData(args);

    expect(data).toHaveLength(64);
    expect(data.subarray(40, 48).equals(Buffer.from([0xc0, 0x27, 0x09, 0, 0, 0, 0, 0]))).toBe(true);
    expect(decodeCreateOrderData(data)).toEqual(args);
  });

  it("refuses to decode data with a wrong discriminator or length", () => {
    const data = encodeCreateOrderData({
      orderId: escrowOrderId("o"),
      amount: BigInt(1),
      shipWindowSeconds: BigInt(1),
      protectionWindowSeconds: BigInt(1),
    });
    const wrong = Buffer.from(data);
    wrong[0] ^= 1;

    expect(decodeCreateOrderData(wrong)).toBeNull();
    expect(decodeCreateOrderData(Buffer.concat([data, Buffer.from([0])]))).toBeNull();
    expect(decodeCreateOrderData(data.subarray(0, 63))).toBeNull();
  });

  it("rejects out-of-range values when encoding", () => {
    const base = {
      orderId: escrowOrderId("o"),
      amount: BigInt(1),
      shipWindowSeconds: BigInt(1),
      protectionWindowSeconds: BigInt(1),
    };
    expect(() => encodeCreateOrderData({ ...base, amount: BigInt(0) })).toThrow();
    expect(() => encodeCreateOrderData({ ...base, shipWindowSeconds: BigInt(0) })).toThrow();
    expect(() => encodeCreateOrderData({ ...base, orderId: Buffer.alloc(31) })).toThrow();
  });

  it("lays out accounts exactly as the CreateOrder struct", () => {
    const keys = {
      buyer: Keypair.generate().publicKey,
      rentPayer: Keypair.generate().publicKey,
      merchant: Keypair.generate().publicKey,
      mint: Keypair.generate().publicKey,
      buyerToken: Keypair.generate().publicKey,
      order: Keypair.generate().publicKey,
      vault: Keypair.generate().publicKey,
    };
    const instruction = createEscrowOrderInstruction(programId, keys, {
      orderId: escrowOrderId("o"),
      amount: BigInt(1),
      shipWindowSeconds: BigInt(1),
      protectionWindowSeconds: BigInt(1),
    });

    expect(CREATE_ORDER_ACCOUNTS).toEqual([
      "buyer", "rentPayer", "merchant", "mint", "buyerToken",
      "order", "vault", "tokenProgram", "systemProgram",
    ]);
    expect(instruction.programId.equals(programId)).toBe(true);
    expect(instruction.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [keys.buyer.toBase58(), true, true],
      [keys.rentPayer.toBase58(), true, true],
      [keys.merchant.toBase58(), false, false],
      [keys.mint.toBase58(), false, false],
      [keys.buyerToken.toBase58(), false, true],
      [keys.order.toBase58(), false, true],
      [keys.vault.toBase58(), false, true],
      [TOKEN_PROGRAM_ID.toBase58(), false, false],
      [SystemProgram.programId.toBase58(), false, false],
    ]);
  });
});
