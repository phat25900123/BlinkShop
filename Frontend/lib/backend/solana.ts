import {
  Connection,
  PublicKey,
  type ParsedTransactionWithMeta,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddress,
  TokenError,
} from "@solana/spl-token";

import {
  decodeEscrowOrderAccount,
  escrowOrderId,
  findEscrowOrderAddress,
  findEscrowVaultAddress,
  type EscrowOrderAccount,
} from "@/lib/backend/escrow";
import { getEscrowConfig } from "@/lib/backend/escrow-config";
import { usdcToBaseUnits } from "@/lib/backend/sponsor-limits";

export function getSolanaConfig() {
  return {
    rpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    usdcMint: process.env.SOLANA_USDC_MINT,
    // Legacy compatibility only. New payment routing always uses the product
    // and order merchantWallet snapshot.
    merchantWallet: process.env.MERCHANT_WALLET,
  };
}

function requirePaymentConfig(merchantWallet: string) {
  const { usdcMint } = getSolanaConfig();

  if (!usdcMint || !merchantWallet.trim()) {
    throw new Error("Solana payment configuration is missing");
  }

  return {
    mint: new PublicKey(usdcMint),
    merchant: new PublicKey(merchantWallet),
  };
}

export type PaymentVerification = "valid" | "invalid" | "pending";

export type PaymentVerificationDependencies = {
  getParsedTransaction: (
    signature: string,
  ) => Promise<ParsedTransactionWithMeta | null>;
};

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

export async function verifyUsdcPayment(
  signature: string,
  expected: {
    buyerWallet: string;
    merchantWallet: string;
    amountUsdc: number;
  },
  injectedDependencies?: PaymentVerificationDependencies,
): Promise<PaymentVerification> {
  const { mint, merchant } = requirePaymentConfig(expected.merchantWallet);
  const transaction = injectedDependencies
    ? await injectedDependencies.getParsedTransaction(signature)
    : await new Connection(
        getSolanaConfig().rpcUrl,
        "confirmed",
      ).getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
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

type PayoutTokenAccount = {
  mint: PublicKey;
  owner: PublicKey;
};

export type MerchantPayoutReadinessDependencies = {
  loadTokenAccount: (address: PublicKey) => Promise<PayoutTokenAccount | null>;
};

export async function getMerchantPayoutReadiness(
  payoutWallet: string,
  injectedDependencies?: MerchantPayoutReadinessDependencies,
) {
  const { mint, merchant } = requirePaymentConfig(payoutWallet);
  const payoutUsdcAta = await getAssociatedTokenAddress(mint, merchant);
  const dependencies =
    injectedDependencies ??
    {
      loadTokenAccount: async (address: PublicKey) => {
        try {
          return await getAccount(
            new Connection(getSolanaConfig().rpcUrl, "confirmed"),
            address,
            "confirmed",
          );
        } catch (error) {
          if (error instanceof TokenError) {
            return null;
          }

          throw error;
        }
      },
    };
  const account = await dependencies.loadTokenAccount(payoutUsdcAta);

  return {
    payoutUsdcAta: payoutUsdcAta.toBase58(),
    payoutReady:
      Boolean(account) &&
      account!.mint.equals(mint) &&
      account!.owner.equals(merchant),
  };
}

// ---------------------------------------------------------------------------
// Escrow payment verification
// ---------------------------------------------------------------------------

type EscrowAccountInfo = {
  owner: PublicKey;
  data: Buffer | Uint8Array;
};

type EscrowVaultAccount = {
  mint: PublicKey;
  /** SPL token authority of the vault. */
  owner: PublicKey;
  amount: bigint;
};

export type EscrowPaymentVerificationDependencies = {
  getParsedTransaction: (
    signature: string,
  ) => Promise<ParsedTransactionWithMeta | null>;
  getAccountInfo: (address: PublicKey) => Promise<EscrowAccountInfo | null>;
  loadTokenAccount: (address: PublicKey) => Promise<EscrowVaultAccount | null>;
};

export type EscrowPaymentExpectation = {
  orderId: string;
  buyerWallet: string;
  merchantWallet: string;
  amountUsdc: number;
};

function defaultEscrowVerificationDependencies(): EscrowPaymentVerificationDependencies {
  const connection = new Connection(getSolanaConfig().rpcUrl, "confirmed");
  return {
    getParsedTransaction: (signature) =>
      connection.getParsedTransaction(signature, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }),
    getAccountInfo: (address) => connection.getAccountInfo(address, "confirmed"),
    loadTokenAccount: async (address) => {
      try {
        return await getAccount(connection, address, "confirmed");
      } catch (error) {
        if (error instanceof TokenError) return null;
        throw error;
      }
    },
  };
}

/**
 * Proves a BlinkShop order is funded by reading on-chain escrow state, not
 * token balance deltas:
 *
 * 1. The submitted signature is a successful transaction that touched this
 *    order's PDA through the escrow program (ties the stored signature to the
 *    order so it cannot be an unrelated transaction).
 * 2. The order PDA (seeds "order", merchant, sha256(order id)) is owned by the
 *    escrow program and decodes as an `Order` whose order id, merchant, buyer,
 *    mint and amount all equal the server's own record, with status Funded
 *    or Shipped (the merchant may ship before confirmation runs). Released and
 *    Refunded orders no longer hold the payment and are rejected.
 * 3. The vault PDA is a token account for that mint, whose authority is the
 *    order PDA, holding exactly the order amount.
 *
 * Every expected value comes from the server order snapshot and server
 * configuration; nothing reported by the client is trusted.
 */
export async function verifyEscrowPayment(
  signature: string,
  expected: EscrowPaymentExpectation,
  injectedDependencies?: EscrowPaymentVerificationDependencies,
): Promise<PaymentVerification> {
  const { mint, merchant } = requirePaymentConfig(expected.merchantWallet);
  const { programId } = getEscrowConfig();
  const buyer = new PublicKey(expected.buyerWallet);
  const amount = usdcToBaseUnits(expected.amountUsdc);
  const onChainOrderId = escrowOrderId(expected.orderId);
  const orderAddress = findEscrowOrderAddress(programId, merchant, onChainOrderId);
  const vaultAddress = findEscrowVaultAddress(programId, orderAddress);
  const dependencies =
    injectedDependencies ?? defaultEscrowVerificationDependencies();

  const transaction = await dependencies.getParsedTransaction(signature);
  if (!transaction) return "pending";
  if (transaction.meta?.err) return "invalid";

  const accountKeys = transaction.transaction.message.accountKeys.map((entry) =>
    entry.pubkey.toBase58(),
  );
  if (
    !accountKeys.includes(programId.toBase58()) ||
    !accountKeys.includes(orderAddress.toBase58())
  ) {
    return "invalid";
  }

  const orderAccount = await dependencies.getAccountInfo(orderAddress);
  // The transaction is visible but the account is not yet: RPC lag.
  if (!orderAccount) return "pending";
  if (!orderAccount.owner.equals(programId)) return "invalid";

  const order = decodeEscrowOrderAccount(orderAccount.data);
  if (
    !order ||
    !order.orderId.equals(onChainOrderId) ||
    !order.merchant.equals(merchant) ||
    !order.buyer.equals(buyer) ||
    !order.mint.equals(mint) ||
    order.amount !== amount ||
    (order.status !== "funded" && order.status !== "shipped")
  ) {
    return "invalid";
  }

  const vault = await dependencies.loadTokenAccount(vaultAddress);
  if (
    !vault ||
    !vault.mint.equals(mint) ||
    !vault.owner.equals(orderAddress) ||
    vault.amount !== amount
  ) {
    return "invalid";
  }

  return "valid";
}

// ---------------------------------------------------------------------------
// Escrow order state (lifecycle actions and status sync)
// ---------------------------------------------------------------------------

export type EscrowStateDependencies = Pick<
  EscrowPaymentVerificationDependencies,
  "getAccountInfo" | "loadTokenAccount"
>;

export type EscrowOrderState =
  | { state: "missing" }
  | { state: "invalid" }
  | {
      state: "ok";
      programId: PublicKey;
      orderAddress: PublicKey;
      vaultAddress: PublicKey;
      mint: PublicKey;
      merchant: PublicKey;
      buyer: PublicKey;
      account: EscrowOrderAccount;
    };

function defaultEscrowStateDependencies(): EscrowStateDependencies {
  const { getAccountInfo, loadTokenAccount } =
    defaultEscrowVerificationDependencies();
  return { getAccountInfo, loadTokenAccount };
}

/**
 * Reads and authenticates an order's escrow account against the server order:
 * owned by the configured escrow program, at the PDA derived from the server
 * order id and merchant, with matching order id, merchant, buyer, mint and
 * amount. The vault must hold exactly the amount while Funded/Shipped and be
 * closed once Released/Refunded. Anything else is "invalid".
 */
export async function readEscrowOrderState(
  expected: EscrowPaymentExpectation,
  injectedDependencies?: EscrowStateDependencies,
): Promise<EscrowOrderState> {
  const { mint, merchant } = requirePaymentConfig(expected.merchantWallet);
  const { programId } = getEscrowConfig();
  const buyer = new PublicKey(expected.buyerWallet);
  const amount = usdcToBaseUnits(expected.amountUsdc);
  const onChainOrderId = escrowOrderId(expected.orderId);
  const orderAddress = findEscrowOrderAddress(programId, merchant, onChainOrderId);
  const vaultAddress = findEscrowVaultAddress(programId, orderAddress);
  const dependencies = injectedDependencies ?? defaultEscrowStateDependencies();

  const info = await dependencies.getAccountInfo(orderAddress);
  if (!info) return { state: "missing" };
  if (!info.owner.equals(programId)) return { state: "invalid" };

  const account = decodeEscrowOrderAccount(info.data);
  if (
    !account ||
    !account.orderId.equals(onChainOrderId) ||
    !account.merchant.equals(merchant) ||
    !account.buyer.equals(buyer) ||
    !account.mint.equals(mint) ||
    account.amount !== amount
  ) {
    return { state: "invalid" };
  }

  const vault = await dependencies.loadTokenAccount(vaultAddress);
  const holdsFunds = account.status === "funded" || account.status === "shipped";
  if (holdsFunds) {
    if (
      !vault ||
      !vault.mint.equals(mint) ||
      !vault.owner.equals(orderAddress) ||
      vault.amount !== amount
    ) {
      return { state: "invalid" };
    }
  } else if (vault) {
    // Settlement always closes the vault in the same instruction.
    return { state: "invalid" };
  }

  return {
    state: "ok",
    programId,
    orderAddress,
    vaultAddress,
    mint,
    merchant,
    buyer,
    account,
  };
}
