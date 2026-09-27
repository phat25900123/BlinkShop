"use client";

import { useState } from "react";
import { Transaction } from "@solana/web3.js";
import type { Product } from "@/lib/backend/types";
import { getSolanaProvider } from "@/lib/phantom";

type CheckoutStatus =
  | "idle"
  | "connecting"
  | "creating"
  | "signing"
  | "sending"
  | "confirming"
  | "paid"
  | "failed";

type Receipt = {
  orderId: string;
  signature: string;
};

function formatUsdc(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function shortValue(value: string) {
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value;
}

function friendlyPaymentError(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";

  if (message.includes("reject") || message.includes("cancel")) {
    return "The wallet request was cancelled. No payment was made.";
  }
  if (message.includes("insufficient") || message.includes("stock")) {
    return "That quantity is no longer available. Choose a lower quantity and try again.";
  }
  if (message.includes("network") || message.includes("cluster")) {
    return "Please switch Phantom to Solana Devnet and try again.";
  }
  if (message.includes("wallet") || message.includes("phantom")) {
    return "Phantom is unavailable. Unlock or install Phantom, then try again.";
  }
  if (message.includes("confirm") || message.includes("verif")) {
    return "We could not verify the payment yet. Check Phantom before trying again.";
  }
  if (message.includes("transaction")) {
    return "The transaction could not be sent. Please check Phantom and try again.";
  }

  return "Payment could not be completed. Please try again.";
}

export function BlinkCheckout({ product }: { product: Product }) {
  const firstAvailableVariant =
    product.variants.find((item) => item.inventory > 0)?.value || "";
  const [variant, setVariant] = useState(firstAvailableVariant);
  const [quantity, setQuantity] = useState(1);
  const [walletAddress, setWalletAddress] = useState("");
  const [status, setStatus] = useState<CheckoutStatus>("idle");
  const [message, setMessage] = useState("");
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const selectedVariant = product.variants.find((item) => item.value === variant);
  const available = product.variants.length > 0
    ? selectedVariant?.inventory ?? 0
    : product.inventory;
  const isOutOfStock = available <= 0;
  const total = product.priceUsdc * quantity;
  const busy = ["connecting", "creating", "signing", "sending", "confirming"].includes(status);

  const connectWallet = async () => {
    const wallet = getSolanaProvider();
    if (!wallet) {
      setStatus("failed");
      setMessage("Phantom was not found. Install or enable Phantom, then refresh this page.");
      return;
    }

    setStatus("connecting");
    setMessage("Connecting wallet...");
    try {
      const response = await wallet.connect();
      const address = response.publicKey?.toString() || wallet.publicKey?.toString();
      if (!address) throw new Error("Wallet address was not returned");
      setWalletAddress(address);
      setStatus("idle");
      setMessage("");
    } catch (error) {
      setStatus("failed");
      setMessage(friendlyPaymentError(error));
    }
  };

  const pay = async () => {
    const wallet = getSolanaProvider();
    if (!wallet || !walletAddress) return connectWallet();
    if (isOutOfStock || quantity < 1 || quantity > available) {
      setStatus("failed");
      setMessage("That quantity is no longer available. Choose another option and try again.");
      return;
    }

    try {
      setStatus("creating");
      setMessage("Preparing payment...");
      const actionResponse = await fetch(`/api/actions/product/${product.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: walletAddress,
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
      setMessage("Waiting for signature...");
      const transaction = Transaction.from(
        Uint8Array.from(atob(action.transaction), (character) => character.charCodeAt(0)),
      );

      let signature: string;
      if (wallet.signAndSendTransaction) {
        const result = await wallet.signAndSendTransaction(transaction);
        signature = result.signature;
        setStatus("sending");
        setMessage("Sending payment...");
      } else {
        const signedTransaction = await wallet.signTransaction(transaction);
        setStatus("sending");
        setMessage("Sending payment...");
        if (!wallet.sendRawTransaction) {
          throw new Error("Wallet does not support sending transactions");
        }
        signature = await wallet.sendRawTransaction(signedTransaction.serialize());
      }

      setStatus("confirming");
      setMessage("Confirming payment...");
      let confirmed = false;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const confirmationResponse = await fetch("/api/orders/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: action.orderId, txSignature: signature }),
        });
        const confirmation = (await confirmationResponse.json()) as {
          error?: string;
          message?: string;
        };

        if (confirmationResponse.ok) {
          confirmed = true;
          break;
        }
        if (confirmationResponse.status !== 202 || attempt === 2) {
          throw new Error(confirmation.error || confirmation.message || "Payment confirmation failed");
        }

        setMessage("Confirming payment on Solana...");
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      if (!confirmed) throw new Error("Payment confirmation failed");
      setReceipt({ orderId: action.orderId, signature });
      setStatus("paid");
      setMessage("Payment confirmed");
    } catch (error) {
      setStatus("failed");
      setMessage(friendlyPaymentError(error));
    }
  };

  const ctaLabel = isOutOfStock
    ? "Out of stock"
    : product.status !== "active"
      ? "Unavailable"
      : status === "connecting"
        ? "Connecting wallet..."
        : status === "creating"
          ? "Preparing payment..."
          : status === "signing"
            ? "Waiting for signature..."
            : status === "sending"
              ? "Sending payment..."
              : status === "confirming"
                ? "Confirming payment..."
                : walletAddress
                  ? `Sign & pay ${formatUsdc(total)} USDC`
                  : "Connect wallet";

  if (status === "paid" && receipt) {
    return (
      <div className="blink-checkout payment-complete" role="status" aria-live="polite">
        <div className="success-mark">✓</div>
        <p className="checkout-eyebrow">PAYMENT CONFIRMED</p>
        <h2>Your order is paid.</h2>
        <p className="success-copy">The USDC transfer was verified on Solana Devnet.</p>
        <dl className="receipt-details">
          <div><dt>Order ID</dt><dd>{receipt.orderId}</dd></div>
          <div><dt>Amount</dt><dd>{formatUsdc(total)} USDC</dd></div>
          {variant && <div><dt>Variant</dt><dd>{variant}</dd></div>}
          <div><dt>Quantity</dt><dd>{quantity}</dd></div>
          <div><dt>Wallet</dt><dd className="mono">{shortValue(walletAddress)}</dd></div>
          <div><dt>Transaction</dt><dd className="mono">{shortValue(receipt.signature)}</dd></div>
        </dl>
        <div className="receipt-actions">
          <a className="primary-button" href={`https://explorer.solana.com/tx/${receipt.signature}?cluster=devnet`} target="_blank" rel="noreferrer">View transaction ↗</a>
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
                  onClick={() => { setVariant(item.value); setQuantity(1); setMessage(""); setStatus("idle"); }}
                  title={soldOut ? "Out of stock" : `${item.inventory} available`}
                >
                  <span>{item.value}</span><small>{soldOut ? "Sold out" : `${item.inventory} available`}</small>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <div className="quantity-row">
        <span>Quantity <small>{available} available</small></span>
        <div className="quantity-control">
          <button type="button" aria-label="Decrease quantity" disabled={busy || isOutOfStock || quantity <= 1} onClick={() => setQuantity((current) => Math.max(1, current - 1))}>−</button>
          <b>{quantity}</b>
          <button type="button" aria-label="Increase quantity" disabled={busy || isOutOfStock || quantity >= available} onClick={() => setQuantity((current) => Math.min(current + 1, available))}>＋</button>
        </div>
      </div>

      <div className="checkout-total"><span>Total</span><strong>{formatUsdc(total)} <small>USDC</small></strong></div>
      <button className="checkout-button" type="button" disabled={busy || product.status !== "active" || isOutOfStock} onClick={() => void (walletAddress ? pay() : connectWallet())}>
        {ctaLabel}<span>{busy ? "···" : "↗"}</span>
      </button>
      {message && <p className={`payment-message ${status === "failed" ? "error" : ""}`} role={status === "failed" ? "alert" : "status"} aria-live="polite">{message}</p>}
      <p className="secure-note"><span>◈</span> Secured by Solana · USDC on Devnet {walletAddress && <>· <span className="mono">{shortValue(walletAddress)}</span></>}</p>
    </div>
  );
}
