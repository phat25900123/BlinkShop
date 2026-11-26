import "server-only";

import {
  getAccount,
  getAssociatedTokenAddress,
  TokenError,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  Transaction,
  type BlockhashWithExpiryBlockHeight,
} from "@solana/web3.js";

import {
  markShippedInstruction,
  settleInstruction,
  type EscrowAction,
} from "@/lib/backend/escrow";
import {
  readEscrowOrderState,
  type EscrowOrderState,
  type EscrowStateDependencies,
} from "@/lib/backend/solana";
import { getSolanaSponsorPublicKey } from "@/lib/backend/solana-sponsor";
import {
  defaultSponsorSigningDependencies,
  getSponsoredTransactionMessageHash,
  SponsoredSubmissionError,
  verifyAndSponsorTransaction,
  type SponsorSigningDependencies,
} from "@/lib/backend/sponsor-signing";
import { store } from "@/lib/backend/store";
import type { Order } from "@/lib/backend/types";

/**
 * Escrow order lifecycle after payment: ship, confirm receipt, refund, claim.
 *
 * Same shape as the sponsored checkout:
 *   prepare  - the server builds a transaction with exactly one escrow
 *              instruction (all accounts derived from the server order and
 *              the authenticated on-chain escrow account), sponsor as fee
 *              payer, and binds its message hash to the order;
 *   submit   - the signer's copy must match that exact instruction and hash,
 *              then the sponsor signs last and BlinkShop broadcasts;
 *   sync     - the store moves forward only to the status read from the
 *              authenticated on-chain escrow account.
 */

export type EscrowActor = {
  role: "merchant" | "buyer";
  wallet: string;
};

export type EscrowActionErrorCode =
  | "order_not_escrow"
  | "order_status_invalid"
  | "actor_not_allowed"
  | "actor_wallet_mismatch"
  | "escrow_account_missing"
  | "escrow_account_invalid"
  | "escrow_state_mismatch"
  | "window_not_elapsed"
  | "destination_token_missing"
  | "action_not_prepared";

export class EscrowActionError extends Error {
  constructor(
    public readonly code: EscrowActionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "EscrowActionError";
  }
}

export type EscrowActionDependencies = EscrowStateDependencies & {
  getLatestBlockhash: () => Promise<BlockhashWithExpiryBlockHeight>;
  now: () => number;
};

function defaultActionDependencies(): EscrowActionDependencies {
  const connection = new Connection(
    process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
    "confirmed",
  );
  return {
    getAccountInfo: (address) => connection.getAccountInfo(address, "confirmed"),
    loadTokenAccount: async (address) => {
      try {
        return await getAccount(connection, address, "confirmed");
      } catch (error) {
        if (error instanceof TokenError) return null;
        throw error;
      }
    },
    getLatestBlockhash: () => connection.getLatestBlockhash("confirmed"),
    now: () => Date.now(),
  };
}

/** Which store statuses, actors and on-chain states each action accepts. */
const RULES: Record<
  EscrowAction,
  {
    storeStatuses: Order["status"][];
    roles: EscrowActor["role"][];
  }
> = {
  ship: { storeStatuses: ["paid"], roles: ["merchant"] },
  "confirm-receipt": { storeStatuses: ["shipped"], roles: ["buyer"] },
  refund: { storeStatuses: ["paid", "shipped"], roles: ["merchant", "buyer"] },
  claim: { storeStatuses: ["shipped"], roles: ["merchant"] },
};

function requireActorAllowed(order: Order, action: EscrowAction, actor: EscrowActor) {
  if (order.settlement !== "escrow") {
    throw new EscrowActionError(
      "order_not_escrow",
      "This order was paid directly and has no escrow to manage.",
    );
  }
  if (!RULES[action].storeStatuses.includes(order.status)) {
    throw new EscrowActionError(
      "order_status_invalid",
      `This action is not available for a ${order.status} order.`,
    );
  }
  if (!RULES[action].roles.includes(actor.role)) {
    throw new EscrowActionError(
      "actor_not_allowed",
      "You are not allowed to perform this action on the order.",
    );
  }
  const expectedWallet =
    actor.role === "merchant" ? order.merchantWallet : order.buyerWallet;
  if (actor.wallet !== expectedWallet) {
    throw new EscrowActionError(
      "actor_wallet_mismatch",
      "Your wallet is not the wallet recorded on this order.",
    );
  }
}

async function authenticatedEscrowState(
  order: Order,
  dependencies: EscrowStateDependencies,
) {
  const state = await readEscrowOrderState(
    {
      orderId: order.id,
      buyerWallet: order.buyerWallet,
      merchantWallet: order.merchantWallet,
      amountUsdc: order.amountUsdc,
    },
    dependencies,
  );
  if (state.state === "missing") {
    throw new EscrowActionError(
      "escrow_account_missing",
      "The escrow account for this order was not found on-chain.",
    );
  }
  if (state.state === "invalid") {
    throw new EscrowActionError(
      "escrow_account_invalid",
      "The on-chain escrow account does not match this order.",
    );
  }
  return state;
}

/** Mirrors the program's own preconditions so we never sponsor a doomed tx. */
function requireOnChainPreconditions(
  state: Extract<EscrowOrderState, { state: "ok" }>,
  action: EscrowAction,
  actor: EscrowActor,
  nowSeconds: bigint,
) {
  const { status, shipBy, releaseAfter } = state.account;
  const mismatch = () =>
    new EscrowActionError(
      "escrow_state_mismatch",
      `The on-chain escrow is ${status}; this action is not available.`,
    );

  switch (action) {
    case "ship":
      if (status !== "funded") throw mismatch();
      return;
    case "confirm-receipt":
      if (status !== "shipped") throw mismatch();
      return;
    case "claim":
      if (status !== "shipped") throw mismatch();
      if (nowSeconds < releaseAfter) {
        throw new EscrowActionError(
          "window_not_elapsed",
          "The buyer-protection window has not ended yet.",
        );
      }
      return;
    case "refund":
      if (actor.role === "merchant") {
        if (status !== "funded" && status !== "shipped") throw mismatch();
        return;
      }
      // A buyer may only reclaim an order the merchant never shipped in time.
      if (status !== "funded") throw mismatch();
      if (nowSeconds <= shipBy) {
        throw new EscrowActionError(
          "window_not_elapsed",
          "The merchant still has time to ship this order.",
        );
      }
      return;
  }
}

/** The exact instruction for an action, from server and on-chain state only. */
async function expectedActionInstruction(
  state: Extract<EscrowOrderState, { state: "ok" }>,
  action: EscrowAction,
  signer: PublicKey,
) {
  if (action === "ship") {
    return {
      instruction: markShippedInstruction(state.programId, {
        merchant: signer,
        order: state.orderAddress,
      }),
      destination: null,
    };
  }

  // confirm_receipt and claim can only pay the merchant; refund only the
  // buyer. The program enforces it too; deriving it here means the sponsor
  // never co-signs a transaction that names any other destination.
  const destinationOwner = action === "refund" ? state.buyer : state.merchant;
  const destination = await getAssociatedTokenAddress(state.mint, destinationOwner);
  return {
    instruction: settleInstruction(state.programId, action, {
      caller: signer,
      order: state.orderAddress,
      mint: state.mint,
      vault: state.vaultAddress,
      destinationToken: destination,
      // Pinned by the program to the recorded rent payer (sponsor or buyer).
      rentPayer: state.account.rentPayer,
    }),
    destination: { address: destination, owner: destinationOwner },
  };
}

export async function prepareEscrowAction(
  input: { order: Order; action: EscrowAction; actor: EscrowActor },
  injectedDependencies?: EscrowActionDependencies,
) {
  const { order, action, actor } = input;
  requireActorAllowed(order, action, actor);

  const dependencies = injectedDependencies ?? defaultActionDependencies();
  const state = await authenticatedEscrowState(order, dependencies);
  requireOnChainPreconditions(
    state,
    action,
    actor,
    BigInt(Math.floor(dependencies.now() / 1000)),
  );

  const signer = new PublicKey(actor.wallet);
  const { instruction, destination } = await expectedActionInstruction(
    state,
    action,
    signer,
  );

  if (destination) {
    const account = await dependencies.loadTokenAccount(destination.address);
    if (
      !account ||
      !account.mint.equals(state.mint) ||
      !account.owner.equals(destination.owner)
    ) {
      throw new EscrowActionError(
        "destination_token_missing",
        action === "refund"
          ? "The buyer's USDC token account no longer exists."
          : "The merchant's USDC token account does not exist.",
      );
    }
  }

  const sponsor = getSolanaSponsorPublicKey();
  const latestBlockhash = await dependencies.getLatestBlockhash();
  const transaction = new Transaction({
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    feePayer: sponsor,
  }).add(instruction);
  const messageHash = getSponsoredTransactionMessageHash(transaction);

  const bound = store.bindEscrowAction(order.id, action, actor.wallet, messageHash);
  if (!bound) {
    throw new EscrowActionError(
      "order_status_invalid",
      "The order changed while the transaction was prepared.",
    );
  }

  return {
    transaction: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString("base64"),
    action,
    escrowOrderAccount: state.orderAddress.toBase58(),
  };
}

export type EscrowSubmitDependencies = SponsorSigningDependencies &
  EscrowActionDependencies & {
    getCurrentOrder: (orderId: string) => Order | undefined;
  };

function defaultSubmitDependencies(): EscrowSubmitDependencies {
  return {
    ...defaultSponsorSigningDependencies(),
    ...defaultActionDependencies(),
    getCurrentOrder: (orderId) => store.getOrder(orderId),
  };
}

export async function submitEscrowAction(
  input: {
    order: Order;
    action: EscrowAction;
    actor: EscrowActor;
    signedTransaction: string;
  },
  injectedDependencies?: EscrowSubmitDependencies,
) {
  const { order, action, actor } = input;
  requireActorAllowed(order, action, actor);

  const binding = order.escrowAction;
  if (!binding || binding.action !== action || binding.signer !== actor.wallet) {
    throw new EscrowActionError(
      "action_not_prepared",
      "Prepare this action before submitting it.",
    );
  }

  const dependencies = injectedDependencies ?? defaultSubmitDependencies();
  const state = await authenticatedEscrowState(order, dependencies);
  requireOnChainPreconditions(
    state,
    action,
    actor,
    BigInt(Math.floor(dependencies.now() / 1000)),
  );
  const signer = new PublicKey(actor.wallet);
  const { instruction } = await expectedActionInstruction(state, action, signer);

  const result = await verifyAndSponsorTransaction(
    {
      signedTransaction: input.signedTransaction,
      signer,
      expectedInstruction: instruction,
      boundMessageHash: binding.messageHash,
      recheck: () => {
        const current = dependencies.getCurrentOrder(order.id);
        if (
          !current ||
          current.status !== order.status ||
          current.escrowAction?.messageHash !== binding.messageHash
        ) {
          throw new SponsoredSubmissionError(
            "transaction_message_mismatch",
            "The order changed before sponsor signing.",
          );
        }
      },
      messages: {
        wrongProgram: "Only the BlinkShop escrow program can be sponsored.",
        mismatch: "The signed transaction does not match this order action.",
        expired:
          "The transaction expired before submission. Prepare the action again.",
        broadcastFailed:
          "The transaction broadcast result is unknown. Refresh the order status before retrying.",
      },
    },
    dependencies,
  );

  store.recordEscrowActionSignature(order.id, result.txSignature);
  return result;
}

const STORE_STATUS = {
  funded: "paid",
  shipped: "shipped",
  released: "released",
  refunded: "refunded",
} as const;

/**
 * Brings the store in line with the authenticated on-chain escrow state.
 * Only paid/shipped escrow orders are synced, and only forwards.
 */
export async function syncEscrowOrderStatus(
  order: Order,
  injectedDependencies?: EscrowStateDependencies,
) {
  if (order.settlement !== "escrow") {
    throw new EscrowActionError(
      "order_not_escrow",
      "This order was paid directly and has no escrow to sync.",
    );
  }
  if (order.status !== "paid" && order.status !== "shipped") {
    return { result: "unchanged" as const, order };
  }

  const state = await authenticatedEscrowState(
    order,
    injectedDependencies ?? defaultActionDependencies(),
  );
  return store.applyEscrowStatus(order.id, STORE_STATUS[state.account.status]);
}
