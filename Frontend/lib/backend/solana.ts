import {
  Connection,
  PublicKey,
  Transaction,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, createTransferInstruction, getAccount, getAssociatedTokenAddress } from "@solana/spl-token";

const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const usdcMint = process.env.SOLANA_USDC_MINT;
const merchantWallet = process.env.MERCHANT_WALLET;

export function getSolanaConfig() {
  return { rpcUrl, usdcMint, merchantWallet };
}

function requireConfig() {
  if (!usdcMint || !merchantWallet) throw new Error("Solana payment configuration is missing");
  return { mint: new PublicKey(usdcMint), merchant: new PublicKey(merchantWallet) };
}

export async function createUsdcTransferTransaction(buyerWallet: string, amountUsdc: number) {
  const { mint, merchant } = requireConfig();
  const buyer = new PublicKey(buyerWallet);
  const connection = new Connection(rpcUrl, "confirmed");
  const [buyerTokenAccount, merchantTokenAccount, latestBlockhash] = await Promise.all([
    getAssociatedTokenAddress(mint, buyer),
    getAssociatedTokenAddress(mint, merchant),
    connection.getLatestBlockhash("confirmed"),
  ]);
  const amount = BigInt(Math.round(amountUsdc * 1_000_000));
  const transaction = new Transaction({ blockhash: latestBlockhash.blockhash, lastValidBlockHeight: latestBlockhash.lastValidBlockHeight, feePayer: buyer });
const [buyerAccount, merchantAccount] = await Promise.all([
  getAccount(connection, buyerTokenAccount).catch(() => null),
  getAccount(connection, merchantTokenAccount).catch(() => null),
]);

// Buyer chưa có USDC ATA → tạo ATA cho buyer
if (!buyerAccount) {
  transaction.add(
    createAssociatedTokenAccountInstruction(
      buyer,              // payer
      buyerTokenAccount,  // ATA address
      buyer,              // owner
      mint,
    ),
  );
}

// Merchant chưa có USDC ATA → tạo ATA cho merchant
if (!merchantAccount) {
  transaction.add(
    createAssociatedTokenAccountInstruction(
      buyer,                 // payer
      merchantTokenAccount,  // ATA address
      merchant,              // owner
      mint,
    ),
  );
}
transaction.add(
  createTransferInstruction(
    buyerTokenAccount,
    merchantTokenAccount,
    buyer,
    amount,
  ),
);
  return { serializedTransaction: transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64"), blockhash: latestBlockhash.blockhash, merchantWallet: merchant.toBase58(), usdcMint: mint.toBase58() };
}

export type PaymentVerification = "valid" | "invalid" | "pending";

type PaymentValidationExpectation = {
  amountBaseUnits: number;
  buyer: string;
  buyerTokenAccount: string;
  merchant: string;
  merchantTokenAccount: string;
  mint: string;
};

/**
 * Validates only transaction evidence fetched from Solana against server-owned
 * expectations. Client-reported payment success, amount, and destination never
 * participate in this decision.
 */
export function validateUsdcPaymentTransaction(
  transaction: ParsedTransactionWithMeta,
  expected: PaymentValidationExpectation,
) {
  if (transaction.meta?.err) return false;

  const tokenBalanceDelta = (
    owner: string,
    direction: "in" | "out",
  ) => {
    const before = transaction.meta?.preTokenBalances?.find(
      (balance) =>
        balance.owner === owner &&
        balance.mint === expected.mint,
    );

    const after = transaction.meta?.postTokenBalances?.find(
      (balance) =>
        balance.owner === owner &&
        balance.mint === expected.mint,
    );

    const beforeAmount = Number(
      before?.uiTokenAmount.amount || 0,
    );

    const afterAmount = Number(
      after?.uiTokenAmount.amount || 0,
    );

    const delta = afterAmount - beforeAmount;

    return direction === "in"
      ? delta === expected.amountBaseUnits
      : delta === -expected.amountBaseUnits;
  };

  const hasTransfer =
    transaction.transaction.message.instructions.some(
      (instruction) => {
        if (
          !("parsed" in instruction) ||
          instruction.program !== "spl-token"
        ) {
          return false;
        }

        const parsed = instruction.parsed as {
          type?: string;
          info?: {
            authority?: string;
            source?: string;
            destination?: string;
            amount?: string;
            mint?: string;
            tokenAmount?: {
              amount?: string;
              mint?: string;
            };
          };
        };

        if (
          parsed.type !== "transfer" &&
          parsed.type !== "transferChecked"
        ) {
          return false;
        }

        const info = parsed.info;

        if (!info) return false;

        const transferredAmount =
          parsed.type === "transferChecked"
            ? info.tokenAmount?.amount
            : info.amount;

        const transferredMint =
          parsed.type === "transferChecked"
            ? info.tokenAmount?.mint
            : info.mint;

        return (
          transferredAmount === String(expected.amountBaseUnits) &&
          info.authority === expected.buyer &&
          info.source === expected.buyerTokenAccount &&
          info.destination === expected.merchantTokenAccount &&
          (!transferredMint || transferredMint === expected.mint)
        );
      },
    );

  return (
    hasTransfer &&
    tokenBalanceDelta(expected.merchant, "in") &&
    tokenBalanceDelta(expected.buyer, "out")
  );
}

export async function verifyUsdcPayment(signature: string, expected: { buyerWallet: string; amountUsdc: number }): Promise<PaymentVerification> {
  const { mint, merchant } = requireConfig();
  const connection = new Connection(rpcUrl, "confirmed");
  const transaction = await connection.getParsedTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  if (!transaction) return "pending";
  if (transaction.meta?.err) return "invalid";
  const expectedAmount = Math.round(expected.amountUsdc * 1_000_000);
  const buyer = new PublicKey(expected.buyerWallet).toBase58();
const buyerTokenAccount = (
  await getAssociatedTokenAddress(mint, new PublicKey(buyer))
).toBase58();

const merchantTokenAccount = (
  await getAssociatedTokenAddress(mint, merchant)
).toBase58();

return validateUsdcPaymentTransaction(transaction, {
  amountBaseUnits: expectedAmount,
  buyer,
  buyerTokenAccount,
  merchant: merchant.toBase58(),
  merchantTokenAccount,
  mint: mint.toBase58(),
})
  ? "valid"
  : "invalid";
}
