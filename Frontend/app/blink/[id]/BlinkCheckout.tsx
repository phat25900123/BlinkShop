"use client";

import { useState } from "react";
import {
  useSignTransaction,
  useWallets,
} from "@privy-io/react-auth/solana";
import { Transaction } from "@solana/web3.js";

import { useBlinkShopAuth } from "@/components/providers/PrivyProvider";
import type { Product } from "@/lib/backend/types";
import { getSolanaProvider } from "@/lib/phantom";

type CheckoutStatus =
  | "idle"
  | "authenticating"
  | "connecting"
  | "creating"
  | "sponsoring"
  | "signing"
  | "sending"
  | "confirming"
  | "paid"
  | "failed";

type Receipt = {
  orderId: string;
  signature: string;
  wallet: string;
  sponsored: boolean;
};

type CheckoutState = {
  status: CheckoutStatus;
  setStatus: (status: CheckoutStatus) => void;
  setMessage: (message: string) => void;
  setReceipt: (receipt: Receipt) => void;
};

function formatUsdc(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function shortValue(value: string) {
  return value.length > 12 ? `${value.slice(0, 5)}...${value.slice(-5)}` : value;
}

function friendlyPaymentError(error: unknown) {
  const original = error instanceof Error ? error.message : "";
  const message = original.toLowerCase();

  if (message.includes("usdc token account")) return original;
  if (message.includes("pending checkout")) return original;
  if (message.includes("session") || message.includes("unauthorized")) {
    return "Your BlinkShop session expired. Sign in again to continue.";
  }
  if (message.includes("sponsor") || message.includes("fee sponsorship")) {
    return "Sponsored network fees are unavailable. Check the BlinkShop Devnet sponsor configuration and try again.";
  }
  if (message.includes("reject") || message.includes("cancel")) {
    return "The wallet request was cancelled. No payment was made.";
  }
  if (message.includes("insufficient") || message.includes("stock")) {
    return "That quantity is no longer available. Choose a lower quantity and try again.";
  }
  if (message.includes("network") || message.includes("cluster")) {
    return "The Solana Devnet request failed. Check the wallet network and try again.";
  }
  if (message.includes("wallet") || message.includes("phantom")) {
    return "The selected wallet is unavailable. Wait for it to finish loading, then try again.";
  }
  if (message.includes("confirm") || message.includes("verif")) {
    return "We could not verify the payment yet. Check the transaction before trying again.";
  }
  if (message.includes("transaction")) {
    return "The transaction could not be sent. Please try again.";
  }

  return "Payment could not be completed. Please try again.";
}

function decodeBase64Transaction(serializedTransaction: string) {
  return Uint8Array.from(
    atob(serializedTransaction),
    (character) => character.charCodeAt(0),
  );
}

function encodeBase64Transaction(transaction: Uint8Array) {
  let binary = "";
  for (const byte of transaction) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function confirmPayment(
  orderId: string,
  signature: string,
  setMessage: (message: string) => void,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch("/api/orders/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, txSignature: signature }),
    });
    const confirmation = (await response.json()) as {
      error?: string;
      message?: string;
    };

    if (response.ok) return;
    if (response.status !== 202 || attempt === 2) {
      throw new Error(
        confirmation.error ||
          confirmation.message ||
          "Payment confirmation failed",
      );
    }

    setMessage("Verifying payment on Solana...");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  throw new Error("Payment confirmation failed");
}

function PrivyPaymentControl({
  product,
  quantity,
  variant,
  total,
  unavailable,
  busy,
  checkout,
}: {
  product: Product;
  quantity: number;
  variant: string;
  total: number;
  unavailable: boolean;
  busy: boolean;
  checkout: CheckoutState;
}) {
  const auth = useBlinkShopAuth();
  const { ready: walletsReady, wallets } = useWallets();
  const { signTransaction } = useSignTransaction();
  const embeddedWallet = wallets.find(
    (wallet) =>
      wallet.address === auth.embeddedSolanaWallet &&
      wallet.standardWallet.name === "Privy",
  );
  const walletLoading =
    auth.authenticated &&
    (!auth.ready || !walletsReady || !auth.embeddedSolanaWallet || !embeddedWallet);

  const payWithPrivy = async () => {
    if (!embeddedWallet || !auth.embeddedSolanaWallet) return;

    try {
      checkout.setStatus("creating");
      checkout.setMessage("Preparing payment...");
      const accessToken = await auth.getAccessToken();
      if (!accessToken) throw new Error("Your session expired");

      const response = await fetch(`/api/checkout/privy/${product.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          quantity,
          ...(variant ? { variant } : {}),
        }),
      });
      const checkoutResponse = (await response.json()) as {
        transaction?: string;
        orderId?: string;
        buyerWallet?: string;
        error?: string;
      };

      if (
        !response.ok ||
        !checkoutResponse.transaction ||
        !checkoutResponse.orderId ||
        !checkoutResponse.buyerWallet
      ) {
        throw new Error(
          checkoutResponse.error || "Unable to create payment transaction",
        );
      }

      if (checkoutResponse.buyerWallet !== embeddedWallet.address) {
        throw new Error("Authenticated wallet does not match the payment wallet");
      }

      checkout.setStatus("signing");
      checkout.setMessage("Waiting for wallet signature...");
      const { signedTransaction } = await signTransaction({
        transaction: decodeBase64Transaction(checkoutResponse.transaction),
        wallet: embeddedWallet,
        chain: "solana:devnet",
      });

      checkout.setStatus("sponsoring");
      checkout.setMessage("Securing sponsored network fee...");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      checkout.setStatus("sending");
      checkout.setMessage("Sending payment...");
      const submitResponse = await fetch(
        `/api/checkout/privy/${product.id}/submit`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orderId: checkoutResponse.orderId,
            signedTransaction: encodeBase64Transaction(signedTransaction),
          }),
        },
      );
      const submission = (await submitResponse.json()) as {
        txSignature?: string;
        error?: string;
      };
      if (!submitResponse.ok || !submission.txSignature) {
        throw new Error(
          submission.error || "Unable to send the sponsored payment",
        );
      }

      checkout.setStatus("confirming");
      checkout.setMessage("Verifying payment on Solana...");
      await confirmPayment(
        checkoutResponse.orderId,
        submission.txSignature,
        checkout.setMessage,
      );

      checkout.setReceipt({
        orderId: checkoutResponse.orderId,
        signature: submission.txSignature,
        wallet: embeddedWallet.address,
        sponsored: true,
      });
      checkout.setStatus("paid");
      checkout.setMessage("Payment confirmed");
    } catch (error) {
      checkout.setStatus("failed");
      checkout.setMessage(friendlyPaymentError(error));
    }
  };

  const label = !auth.ready
    ? "Loading sign in..."
    : !auth.authenticated
      ? "Continue with email"
      : walletLoading
        ? "Creating embedded wallet..."
        : checkout.status === "creating"
          ? "Preparing payment..."
          : checkout.status === "sponsoring"
            ? "Securing network fee..."
            : checkout.status === "signing"
              ? "Waiting for wallet signature..."
              : checkout.status === "sending"
                ? "Sending payment..."
                : checkout.status === "confirming"
                  ? "Verifying payment..."
                  : `Pay ${formatUsdc(total)} USDC`;

  return (
    <>
      <button
        className="checkout-button"
        type="button"
        disabled={busy || unavailable || !auth.ready || walletLoading}
        onClick={() => {
          if (!auth.authenticated) {
            checkout.setStatus("authenticating");
            checkout.setMessage("Sign in with email to continue.");
            auth.login();
            return;
          }

          void payWithPrivy();
        }}
      >
        {label}<span>{busy ? "..." : ">"}</span>
      </button>

      {auth.authenticated && auth.embeddedSolanaWallet && (
        <div className="buyer-wallet-row">
          <span>Embedded wallet</span>
          <span className="mono">{shortValue(auth.embeddedSolanaWallet)}</span>
          <button type="button" onClick={() => void auth.logout()} disabled={busy}>
            Sign out
          </button>
        </div>
      )}
      <p className="sponsorship-note">Network fee sponsored by BlinkShop</p>
    </>
  );
}

export function BlinkCheckout({ product }: { product: Product }) {
  const auth = useBlinkShopAuth();
  const firstAvailableVariant =
    product.variants.find((item) => item.inventory > 0)?.value || "";
  const [variant, setVariant] = useState(firstAvailableVariant);
  const [quantity, setQuantity] = useState(1);
  const [phantomWalletAddress, setPhantomWalletAddress] = useState("");
  const [status, setStatus] = useState<CheckoutStatus>("idle");
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const selectedVariant = product.variants.find((item) => item.value === variant);
  const available = product.variants.length > 0
    ? selectedVariant?.inventory ?? 0
    : product.inventory;
  const unavailable = product.status !== "active" || available <= 0;
  const total = product.priceUsdc * quantity;
  const busy = [
    "connecting",
    "creating",
    "sponsoring",
    "signing",
    "sending",
    "confirming",
  ].includes(status);

  const checkout: CheckoutState = {
    status,
    setStatus,
    setMessage,
    setReceipt,
  };

  const connectPhantom = async () => {
    const wallet = getSolanaProvider();
    if (!wallet) throw new Error("Phantom was not found");

    setStatus("connecting");
    setMessage("Connecting Phantom...");
    const response = await wallet.connect();
    const address = response.publicKey?.toString() || wallet.publicKey?.toString();
    if (!address) throw new Error("Wallet address was not returned");
    setPhantomWalletAddress(address);
    setStatus("idle");
    setMessage("");
    return { wallet, address };
  };

  const payWithPhantom = async () => {
    if (unavailable || quantity < 1 || quantity > available) {
      setStatus("failed");
      setMessage("That quantity is no longer available. Choose another option and try again.");
      return;
    }

    try {
      const connected = phantomWalletAddress
        ? { wallet: getSolanaProvider(), address: phantomWalletAddress }
        : await connectPhantom();
      if (!connected.wallet) throw new Error("Phantom is unavailable");

      setStatus("creating");
      setMessage("Preparing Phantom payment...");
      const actionResponse = await fetch(`/api/actions/product/${product.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: connected.address,
          quantity,
          ...(variant ? { variant } : {}),
        }),
      });
      const action = (await actionResponse.json()) as {
        transaction?: string;
        orderId?: string;
        message?: string;
      };
      if (!actionResponse.ok || !action.transaction || !action.orderId) {
        throw new Error(action.message || "Unable to create payment transaction");
      }

      setStatus("signing");
      setMessage("Waiting for Phantom signature...");
      const transaction = Transaction.from(decodeBase64Transaction(action.transaction));
      let signature: string;

      if (connected.wallet.signAndSendTransaction) {
        const result = await connected.wallet.signAndSendTransaction(transaction);
        signature = result.signature;
      } else {
        const signedTransaction = await connected.wallet.signTransaction(transaction);
        if (!connected.wallet.sendRawTransaction) {
          throw new Error("Wallet does not support sending transactions");
        }
        signature = await connected.wallet.sendRawTransaction(
          signedTransaction.serialize(),
        );
      }

      setStatus("confirming");
      setMessage("Verifying payment on Solana...");
      await confirmPayment(action.orderId, signature, setMessage);
      setReceipt({
        orderId: action.orderId,
        signature,
        wallet: connected.address,
        sponsored: false,
      });
      setStatus("paid");
      setMessage("Payment confirmed");
    } catch (error) {
      setStatus("failed");
      setMessage(friendlyPaymentError(error));
    }
  };

  if (status === "paid" && receipt) {
    return (
      <div className="blink-checkout payment-complete" role="status" aria-live="polite">
        <div className="success-mark">OK</div>
        <p className="checkout-eyebrow">PAYMENT CONFIRMED</p>
        <h2>Your order is paid.</h2>
        <p className="success-copy">The USDC transfer was verified on Solana Devnet.</p>
        <dl className="receipt-details">
          <div><dt>Order ID</dt><dd>{receipt.orderId}</dd></div>
          <div><dt>Amount</dt><dd>{formatUsdc(total)} USDC</dd></div>
          {variant && <div><dt>Variant</dt><dd>{variant}</dd></div>}
          <div><dt>Quantity</dt><dd>{quantity}</dd></div>
          <div><dt>Wallet</dt><dd className="mono">{shortValue(receipt.wallet)}</dd></div>
          <div><dt>Transaction</dt><dd className="mono">{shortValue(receipt.signature)}</dd></div>
        </dl>
        {receipt.sponsored && (
          <p className="sponsorship-note">Network fee sponsored by BlinkShop</p>
        )}
        <div className="receipt-actions">
          <a
            className="primary-button"
            href={`https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet`}
            target="_blank"
            rel="noreferrer"
          >
            View transaction
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="blink-checkout">
      {product.variants.length > 0 && (
        <fieldset className="variant-fieldset" disabled={busy}>
          <legend>{product.variants[0].name}</legend>
          <div className="choice-options">
            {product.variants.map((item) => {
              const soldOut = item.inventory <= 0;
              return (
                <button
                  className={`choice ${variant === item.value ? "selected" : ""} ${soldOut ? "sold-out" : ""}`}
                  type="button"
                  disabled={busy || soldOut}
                  aria-pressed={variant === item.value}
                  key={item.id}
                  onClick={() => {
                    setVariant(item.value);
                    setQuantity(1);
                    setMessage("");
                    setStatus("idle");
                  }}
                  title={soldOut ? "Out of stock" : `${item.inventory} available`}
                >
                  <span>{item.value}</span>
                  <small>{soldOut ? "Sold out" : `${item.inventory} available`}</small>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="quantity-row">
        <span>Quantity <small>{available} available</small></span>
        <div className="quantity-control">
          <button type="button" aria-label="Decrease quantity" disabled={busy || unavailable || quantity <= 1} onClick={() => setQuantity((current) => Math.max(1, current - 1))}>-</button>
          <b>{quantity}</b>
          <button type="button" aria-label="Increase quantity" disabled={busy || unavailable || quantity >= available} onClick={() => setQuantity((current) => Math.min(current + 1, available))}>+</button>
        </div>
      </div>

      <div className="checkout-total">
        <span>Total</span>
        <strong>{formatUsdc(total)} <small>USDC</small></strong>
      </div>

      {auth.configured ? (
        <PrivyPaymentControl
          product={product}
          quantity={quantity}
          variant={variant}
          total={total}
          unavailable={unavailable}
          busy={busy}
          checkout={checkout}
        />
      ) : (
        <button
          className="checkout-button"
          type="button"
          disabled={busy || unavailable}
          onClick={() => void payWithPhantom()}
        >
          {phantomWalletAddress
            ? `Pay ${formatUsdc(total)} USDC with Phantom`
            : "Connect Phantom"}
          <span>{busy ? "..." : ">"}</span>
        </button>
      )}

      {auth.configured && (
        <button
          className="phantom-fallback-button"
          type="button"
          disabled={busy || unavailable}
          onClick={() => void payWithPhantom()}
        >
          {phantomWalletAddress
            ? `Pay ${formatUsdc(total)} USDC with Phantom`
            : "Use Phantom instead"}
        </button>
      )}

      {message && (
        <p
          className={`payment-message ${status === "failed" ? "error" : ""}`}
          role={status === "failed" ? "alert" : "status"}
          aria-live="polite"
        >
          {message}
        </p>
      )}
      <p className="secure-note">
        Secured by Solana. USDC on Devnet
        {phantomWalletAddress && (
          <>. <span className="mono">{shortValue(phantomWalletAddress)}</span></>
        )}
      </p>
    </div>
  );
}
