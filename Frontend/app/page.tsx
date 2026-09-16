"use client";

import { useState } from "react";
import { Transaction } from "@solana/web3.js";

type WalletProvider = {
  publicKey?: { toString(): string };
  connect(): Promise<{ publicKey?: { toString(): string } }>;
  signTransaction(transaction: Transaction): Promise<Transaction>;
  sendRawTransaction(transaction: Uint8Array): Promise<string>;
};

declare global {
  interface Window {
    solana?: WalletProvider;
  }
}

type Product = {
  id: string;
  name: string;
  price: number;
  inventory: number;
  status: "Live" | "Draft";
  image: string;
  color: string;
};

const products: Product[] = [
  { id: "blk-001", name: "Afterglow hoodie", price: 48, inventory: 24, status: "Live", image: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=900&q=85", color: "#e9c2a9" },
  { id: "blk-002", name: "Signal cap", price: 22, inventory: 61, status: "Live", image: "https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=900&q=85", color: "#b7c2ad" },
  { id: "blk-003", name: "Studio pass 2026", price: 12, inventory: 120, status: "Live", image: "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=85", color: "#d5c7e8" },
];

const orders = [
  { id: "#BLK-1048", product: "Afterglow hoodie", buyer: "7xK...mP2", amount: 48, status: "Paid", time: "2 min ago" },
  { id: "#BLK-1047", product: "Studio pass 2026", buyer: "Fj3...8Qv", amount: 12, status: "Paid", time: "18 min ago" },
  { id: "#BLK-1046", product: "Signal cap", buyer: "2sA...rL9", amount: 22, status: "Pending", time: "41 min ago" },
];

function Icon({ children }: { children: React.ReactNode }) {
  return <span className="nav-icon" aria-hidden="true">{children}</span>;
}

export default function Home() {
  const [active, setActive] = useState("Overview");
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [connected, setConnected] = useState(false);
  const [walletAddress, setWalletAddress] = useState("");
  const [paymentStatus, setPaymentStatus] = useState<"idle" | "connecting" | "creating" | "signing" | "sending" | "confirming" | "paid" | "failed">("idle");
  const [paymentMessage, setPaymentMessage] = useState("");
  const [quantity, setQuantity] = useState(1);

  const openCheckout = (product: Product) => {
    setSelectedProduct(product);
    setConnected(false);
    setWalletAddress("");
    setPaymentStatus("idle");
    setPaymentMessage("");
    setQuantity(1);
  };

  const connectWallet = async () => {
    const wallet = window.solana;
    if (!wallet) {
      setPaymentStatus("failed");
      setPaymentMessage("No Solana wallet found. Install Phantom or another compatible wallet.");
      return;
    }
    setPaymentStatus("connecting");
    try {
      const response = await wallet.connect();
      const address = response.publicKey?.toString() || wallet.publicKey?.toString();
      if (!address) throw new Error("Wallet address was not returned");
      setWalletAddress(address);
      setConnected(true);
      setPaymentStatus("idle");
      setPaymentMessage("");
    } catch {
      setPaymentStatus("failed");
      setPaymentMessage("Wallet connection was cancelled. Please try again.");
    }
  };

  const disconnectWallet = () => {
    setConnected(false);
    setWalletAddress("");
    setPaymentStatus("idle");
    setPaymentMessage("");
  };

  const payForProduct = async () => {
    if (!selectedProduct || !walletAddress) return;
    const wallet = window.solana;
    if (!wallet) {
      setPaymentStatus("failed");
      setPaymentMessage("Your wallet is no longer available. Reconnect and try again.");
      return;
    }
    try {
      setPaymentStatus("creating");
      setPaymentMessage("Preparing a payment from the backend...");
      const actionResponse = await fetch(`/api/actions/product/${selectedProduct.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account: walletAddress, quantity }),
      });
      const action = await actionResponse.json() as { transaction?: string; orderId?: string; error?: string };
      if (!actionResponse.ok || !action.transaction || !action.orderId) throw new Error(action.error || "Unable to create payment transaction");
      setPaymentStatus("signing");
      setPaymentMessage("Review and approve the transaction in your wallet...");
      const transaction = Transaction.from(Uint8Array.from(atob(action.transaction), (character) => character.charCodeAt(0)));
      const signedTransaction = await wallet.signTransaction(transaction);
      setPaymentStatus("sending");
      setPaymentMessage("Sending payment to Solana...");
      const signature = await wallet.sendRawTransaction(signedTransaction.serialize());
      setPaymentStatus("confirming");
      setPaymentMessage("Waiting for backend confirmation...");
      const confirmationResponse = await fetch("/api/orders/confirm", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId: action.orderId, txSignature: signature }) });
      const confirmation = await confirmationResponse.json() as { error?: string };
      if (!confirmationResponse.ok) throw new Error(confirmation.error || "Payment confirmation failed");
      setPaymentStatus("paid");
      setPaymentMessage(`Order ${action.orderId} is confirmed on Solana.`);
    } catch (error) {
      setPaymentStatus("failed");
      setPaymentMessage(error instanceof Error ? error.message : "Payment failed. Please try again.");
    }
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">B</span><span>blinkshop</span></div>
        <div className="workspace-switcher"><span className="avatar">A</span><span><b>Aria Studio</b><small>Merchant workspace</small></span><span className="chevron">⌄</span></div>
        <nav className="main-nav">
          <p className="nav-label">Workspace</p>
          {[["Overview", "◒"], ["Products", "□"], ["Orders", "≡"], ["Blink links", "↗"]].map(([label, icon]) => (
            <button className={`nav-item ${active === label ? "active" : ""}`} key={label} onClick={() => setActive(label)}><Icon>{icon}</Icon>{label}{label === "Orders" && <span className="nav-count">3</span>}</button>
          ))}
          <p className="nav-label nav-label-spaced">Manage</p>
          <button className={`nav-item ${active === "Settings" ? "active" : ""}`} onClick={() => setActive("Settings")}><Icon>⚙</Icon>Settings</button>
        </nav>
        <div className="sidebar-bottom"><div className="credit-row"><span className="solana-dot" /> Devnet connected <span className="live-dot" /></div><div className="help-row">? <span>Help center</span><span className="version">v0.1 beta</span></div></div>
      </aside>

      <section className="content-area">
        <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{active}</strong></div><div className="top-actions"><button className="icon-button" aria-label="Notifications">♧<span className="notification-dot" /></button><button className="profile-button"><span className="avatar small">A</span> <span>Aria</span> <span>⌄</span></button></div></header>
        <div className="content-inner">
          <div className="page-heading"><div><p className="eyebrow">MONDAY, SEPTEMBER 14, 2026</p><h1>Good morning, Aria<span className="heading-period">.</span></h1><p className="subheading">Your social commerce is moving.</p></div><button className="primary-button" onClick={() => openCheckout(products[0])}><span>＋</span> Create product</button></div>

          <section className="stats-grid">
            <article className="stat-card"><div className="stat-top"><span>Total sales</span><span className="stat-icon mint">↗</span></div><strong>$2,480.00</strong><div className="stat-foot"><span className="trend">↑ 18.4%</span> <span>vs last month</span></div></article>
            <article className="stat-card"><div className="stat-top"><span>Orders</span><span className="stat-icon lemon">◌</span></div><strong>86</strong><div className="stat-foot"><span className="trend">↑ 12.8%</span> <span>vs last month</span></div></article>
            <article className="stat-card"><div className="stat-top"><span>Conversion rate</span><span className="stat-icon lilac">⌁</span></div><strong>4.8%</strong><div className="stat-foot"><span className="trend">↑ 0.6%</span> <span>vs last month</span></div></article>
          </section>

          <section className="feature-band"><div className="feature-copy"><span className="feature-kicker">BLINK TIP 01</span><h2>Turn attention<br /><i>into action.</i></h2><p>Your products are ready to be shared.<br />Make every post shoppable.</p><button className="dark-button" onClick={() => setActive("Blink links")}>Explore blink links <span>↗</span></button></div><div className="feature-art"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><div className="art-card"><span className="art-badge">LIVE</span><div className="art-image" /><div className="art-meta"><strong>afterglow hoodie</strong><span>48 USDC <b>↗</b></span></div></div><span className="art-caption">SHAREABLE<br />CHECKOUT</span></div></section>

          <div className="section-header"><div><h2 className="section-title">Your products</h2><p className="section-description">Products currently available through your Blinks.</p></div><button className="text-button" onClick={() => setActive("Products")}>View all <span>→</span></button></div>
          <section className="product-grid">{products.map((product) => <article className="product-card" key={product.id}><div className="product-image" style={{ backgroundColor: product.color }}><img src={product.image} alt={product.name} /><span className={`status-pill ${product.status.toLowerCase()}`}><i />{product.status}</span><button className="more-button" aria-label={`More options for ${product.name}`}>•••</button></div><div className="product-info"><div><h3>{product.name}</h3><p>{product.price} USDC <span>·</span> {product.inventory} in stock</p></div><button className="buy-button" onClick={() => openCheckout(product)}>Open Blink <span>↗</span></button></div></article>)}</section>

          <div className="section-header orders-heading"><div><h2 className="section-title">Recent orders</h2><p className="section-description">The latest activity across your checkout links.</p></div><button className="text-button" onClick={() => setActive("Orders")}>View all <span>→</span></button></div>
          <section className="orders-table"><div className="table-row table-head"><span>Order</span><span>Product</span><span>Buyer wallet</span><span>Amount</span><span>Status</span><span>Placed</span></div>{orders.map((order) => <div className="table-row" key={order.id}><strong>{order.id}</strong><span>{order.product}</span><span className="mono">{order.buyer}</span><span>{order.amount} USDC</span><span className={`order-status ${order.status.toLowerCase()}`}><i />{order.status}</span><span className="muted">{order.time}</span></div>)}</section>
        </div>
      </section>

      {selectedProduct && <div className="modal-backdrop" onClick={() => setSelectedProduct(null)}><section className="checkout-modal" onClick={(event) => event.stopPropagation()}><button className="close-button" aria-label="Close checkout" onClick={() => setSelectedProduct(null)}>×</button><div className="checkout-visual" style={{ backgroundColor: selectedProduct.color }}><img src={selectedProduct.image} alt={selectedProduct.name} /><span className="checkout-label">BLINKSHOP / DEVNET</span></div><div className="checkout-content"><div className="checkout-eyebrow">INSTANT CHECKOUT</div><h2>{selectedProduct.name}</h2><p className="checkout-description">A direct, wallet-native purchase from Aria Studio.</p><div className="choice-row"><span>Edition</span><div className="choice-options"><button className="choice selected">Standard</button><button className="choice">Collector</button></div></div><div className="quantity-row"><span>Quantity</span><div className="quantity-control"><button disabled={paymentStatus === "creating" || paymentStatus === "signing" || paymentStatus === "sending" || paymentStatus === "confirming"} onClick={() => setQuantity(Math.max(1, quantity - 1))}>−</button><b>{quantity}</b><button disabled={paymentStatus === "creating" || paymentStatus === "signing" || paymentStatus === "sending" || paymentStatus === "confirming"} onClick={() => setQuantity(Math.min(5, quantity + 1))}>＋</button></div></div><div className="checkout-total"><span>Total</span><strong>{selectedProduct.price * quantity} <small>USDC</small></strong></div>{paymentStatus === "paid" ? <div className="payment-success"><span>✓</span><div><strong>Payment confirmed</strong><p>{paymentMessage}</p></div></div> : <><button className="checkout-button" disabled={paymentStatus === "connecting" || paymentStatus === "creating" || paymentStatus === "signing" || paymentStatus === "sending" || paymentStatus === "confirming"} onClick={connected ? payForProduct : connectWallet}>{paymentStatus === "connecting" ? "Connecting wallet..." : paymentStatus === "creating" ? "Creating transaction..." : paymentStatus === "signing" ? "Waiting for signature..." : paymentStatus === "sending" ? "Sending payment..." : paymentStatus === "confirming" ? "Confirming payment..." : connected ? `Sign & pay ${selectedProduct.price * quantity} USDC` : "Connect wallet"}<span>↗</span></button>{paymentMessage && <p className={`payment-message ${paymentStatus === "failed" ? "error" : ""}`}>{paymentMessage}</p>}</>}<p className="secure-note"><span>◈</span> Secured by Solana · USDC on Devnet {walletAddress && <>· {walletAddress.slice(0, 4)}...{walletAddress.slice(-4)} <button className="wallet-disconnect" onClick={disconnectWallet}>Disconnect</button></>}</p></div></section></div>}
    </main>
  );
}
