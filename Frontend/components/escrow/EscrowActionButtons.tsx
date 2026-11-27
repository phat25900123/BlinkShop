"use client";

import { useCallback, useEffect, useState } from "react";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";

import { useBlinkShopAuth } from "@/components/providers/PrivyProvider";
import {
  ACTION_CONFIRMATIONS,
  ACTION_LABELS,
  EscrowActionRequestError,
  runEscrowAction,
  STEP_LABELS,
  type EscrowActionName,
  type EscrowActionStep,
  type SyncResponse,
  type ViewerRole,
} from "@/lib/escrow-ui";

/** Ticks every `intervalMs` so countdowns stay current. */
export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** fetch with the Privy access token; the server resolves who the caller is. */
export function useAuthorizedFetch() {
  const { getAccessToken } = useBlinkShopAuth();
  return useCallback(
    async (input: string, init: RequestInit = {}) => {
      const token = await getAccessToken();
      if (!token) {
        throw new EscrowActionRequestError(
          "Your session expired. Sign in again to continue.",
          "session_expired",
          401,
        );
      }
      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    },
    [getAccessToken],
  );
}

function friendlySigningError(error: unknown) {
  if (error instanceof EscrowActionRequestError) return error.message;
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("reject") || message.includes("cancel")) {
    return "The signature request was cancelled. Nothing was sent.";
  }
  return "The action could not be completed. Refresh the order and try again.";
}

/**
 * Buttons for escrow lifecycle actions. Each click: prepare on the server,
 * sign with the signed-in user's Privy embedded wallet, submit, then sync.
 * Must render inside the Privy provider (auth.configured).
 */
export function EscrowActionButtons({
  orderId,
  role,
  actions,
  onSettled,
  compact = false,
}: {
  orderId: string;
  role: ViewerRole;
  actions: EscrowActionName[];
  onSettled: (result: { txSignature: string; synced: SyncResponse | null }) => void;
  compact?: boolean;
}) {
  const auth = useBlinkShopAuth();
  const { wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const authorizedFetch = useAuthorizedFetch();
  const [running, setRunning] = useState<EscrowActionName | null>(null);
  const [step, setStep] = useState<EscrowActionStep | null>(null);
  const [error, setError] = useState("");

  const wallet = wallets.find(
    (item) =>
      item.address === auth.embeddedSolanaWallet &&
      item.standardWallet.name === "Privy",
  );

  if (actions.length === 0) return null;

  const run = async (action: EscrowActionName) => {
    const confirmation = ACTION_CONFIRMATIONS[action];
    if (confirmation && !window.confirm(confirmation)) return;
    if (!wallet) {
      setError("Your embedded wallet is still loading. Try again in a moment.");
      return;
    }

    setRunning(action);
    setError("");
    try {
      const result = await runEscrowAction({
        orderId,
        action,
        fetcher: authorizedFetch,
        onStep: setStep,
        sign: async (transaction) => {
          const { signedTransaction } = await signTransaction({
            transaction,
            wallet,
            chain: "solana:devnet",
          });
          return signedTransaction;
        },
      });
      onSettled(result);
    } catch (caught) {
      setError(friendlySigningError(caught));
    } finally {
      setRunning(null);
      setStep(null);
    }
  };

  return (
    <div className={`escrow-actions ${compact ? "compact" : ""}`}>
      <div className="escrow-action-buttons">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            className={action === "refund" ? "danger-button" : "secondary-button"}
            disabled={running !== null || !wallet}
            aria-busy={running === action}
            onClick={() => void run(action)}
          >
            {running === action && step ? STEP_LABELS[step] : ACTION_LABELS[role][action]}
          </button>
        ))}
      </div>
      {error && (
        <p className="escrow-action-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
