"use client";

import { useState, type FormEvent } from "react";

type DashboardProduct = {
  id: string;
  name: string;
  description: string;
  price: number;
  inventory: number;
  status: "Live" | "Draft" | "Sold out";
  image: string;
  variants: { id: string; name: string; value: string; inventory: number }[];
};

type DashboardOrder = {
  id: string;
  product: string;
  buyer: string;
  amount: number;
  status: string;
  time: string;
  variant?: string;
  quantity: number;
  txSignature?: string;
};

type Props = {
  active: "Products" | "Orders" | "Blink links";
  products: DashboardProduct[];
  orders: DashboardOrder[];
  onProductsChange: (products: DashboardProduct[]) => void;
  onCreateProduct: () => void;
};

function shortAddress(value: string) {
  return value.length > 12 ? `${value.slice(0, 5)}…${value.slice(-5)}` : value;
}

function statusClass(status: string) {
  return status.toLowerCase().replaceAll(" ", "-");
}

function productStock(product: DashboardProduct) {
  return product.variants.length > 0
    ? product.variants.reduce((total, variant) => total + variant.inventory, 0)
    : product.inventory;
}

export function DashboardViews({
  active,
  products,
  orders,
  onProductsChange,
  onCreateProduct,
}: Props) {
  const [editing, setEditing] = useState<DashboardProduct | null>(null);
  const [message, setMessage] = useState("");
  const [copiedId, setCopiedId] = useState("");
  const [saving, setSaving] = useState(false);

  const copyLink = async (id: string) => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/blink/${id}`);
      setCopiedId(id);
      setMessage("");
      window.setTimeout(() => setCopiedId(""), 1800);
    } catch {
      setMessage("Unable to copy this link. Open the Blink and copy its URL instead.");
    }
  };

  const deleteProduct = async (id: string) => {
    if (!window.confirm("Delete this product? This cannot be undone.")) return;

    const response = await fetch(`/api/products/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      setMessage(data.error || "Unable to delete product.");
      return;
    }

    setMessage("");
    onProductsChange(products.filter((product) => product.id !== id));
  };

  const saveProduct = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || saving) return;

    setSaving(true);
    setMessage("");

    try {
      const inventory = productStock(editing);
      const response = await fetch(`/api/products/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: editing.name.trim(),
          description: editing.description.trim(),
          priceUsdc: editing.price,
          inventory,
          imageUrl: editing.image.trim(),
          variants: editing.variants,
        }),
      });
      const data = (await response.json()) as {
        product?: {
          name: string;
          description: string;
          priceUsdc: number;
          inventory: number;
          imageUrl: string;
          status: "active" | "inactive" | "sold_out";
          variants: DashboardProduct["variants"];
        };
        error?: string;
      };

      if (!response.ok || !data.product) {
        throw new Error(data.error || "Unable to update product.");
      }

      const updated = data.product;
      onProductsChange(products.map((product) => product.id === editing.id ? {
        ...product,
        name: updated.name,
        description: updated.description,
        price: updated.priceUsdc,
        inventory: updated.inventory,
        image: updated.imageUrl,
        status: updated.status === "active" ? "Live" : updated.status === "sold_out" ? "Sold out" : "Draft",
        variants: updated.variants,
      } : product));
      setEditing(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to update product.");
    } finally {
      setSaving(false);
    }
  };

  const updateEditingVariant = (
    index: number,
    field: "name" | "value" | "inventory",
    value: string,
  ) => {
    if (!editing) return;
    setEditing({
      ...editing,
      variants: editing.variants.map((item, itemIndex) => itemIndex === index
        ? { ...item, [field]: field === "inventory" ? Number(value) : value }
        : item),
    });
  };

  const addEditingVariant = () => {
    if (!editing) return;
    setEditing({
      ...editing,
      variants: [...editing.variants, {
        id: crypto.randomUUID(), name: "Size", value: "", inventory: 0,
      }],
    });
  };

  const removeEditingVariant = (index: number) => {
    if (!editing) return;
    setEditing({
      ...editing,
      variants: editing.variants.filter((_, itemIndex) => itemIndex !== index),
    });
  };

  if (active === "Orders") {
    return (
      <section className="content-inner dashboard-view">
        <div className="page-heading">
          <div>
            <p className="eyebrow">FULFILLMENT</p>
            <h1>Orders<span className="heading-period">.</span></h1>
            <p className="subheading">Every reservation and payment created through your Blinks.</p>
          </div>
        </div>

        {orders.length > 0 ? (
          <section className="orders-table orders-table-full" aria-label="Orders">
            <div className="table-row table-row-full table-head">
              <span>Order</span><span>Product</span><span>Buyer</span><span>Variant</span>
              <span>Qty</span><span>Amount</span><span>Status</span><span>Placed</span><span>Transaction</span>
            </div>
            {orders.map((order) => (
              <div className="table-row table-row-full" key={order.id}>
                <strong title={order.id}>{shortAddress(order.id)}</strong>
                <span>{order.product}</span>
                <span className="mono" title={order.buyer}>{shortAddress(order.buyer)}</span>
                <span>{order.variant || "—"}</span>
                <span>{order.quantity}</span>
                <span>{order.amount.toFixed(2)} USDC</span>
                <span className={`order-status ${statusClass(order.status)}`}><i />{order.status}</span>
                <time className="muted">{order.time}</time>
                {order.txSignature ? (
                  <a className="table-link" href={`https://explorer.solana.com/tx/${order.txSignature}?cluster=devnet`} target="_blank" rel="noreferrer" title={order.txSignature}>View tx ↗</a>
                ) : <span className="muted">—</span>}
              </div>
            ))}
          </section>
        ) : (
          <div className="empty-state"><strong>No orders yet</strong><p>Your first Blink payment will appear here.</p></div>
        )}
      </section>
    );
  }

  if (active === "Blink links") {
    return (
      <section className="content-inner dashboard-view">
        <div className="page-heading">
          <div>
            <p className="eyebrow">SHAREABLE CHECKOUT</p>
            <h1>Blink links<span className="heading-period">.</span></h1>
            <p className="subheading">Share a checkout link anywhere your audience discovers a product.</p>
          </div>
        </div>

        {message && <p className="inline-alert error" role="alert">{message}</p>}
        {products.length > 0 ? (
          <section className="link-list">
            {products.map((product) => (
              <article className="link-row" key={product.id}>
                <div className="link-product"><strong>{product.name}</strong><span>/blink/{product.id}</span></div>
                <div className="link-meta"><b>{product.price.toFixed(2)} USDC</b><span className={`status-badge ${statusClass(product.status)}`}>{product.status}</span></div>
                <div className="link-actions">
                  <a className="secondary-button" href={`/blink/${product.id}`} target="_blank" rel="noreferrer">Open Blink ↗</a>
                  <button className="primary-button compact" type="button" onClick={() => void copyLink(product.id)}>{copiedId === product.id ? "Copied ✓" : "Copy link"}</button>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <div className="empty-state"><strong>No Blink links yet</strong><p>Create a product to generate its first checkout link.</p></div>
        )}
      </section>
    );
  }

  return (
    <section className="content-inner dashboard-view">
      <div className="page-heading">
        <div>
          <p className="eyebrow">CATALOG</p>
          <h1>Products<span className="heading-period">.</span></h1>
          <p className="subheading">Manage the products available through your Blinks.</p>
        </div>
        <button className="primary-button" type="button" onClick={onCreateProduct}><span>＋</span> Create product</button>
      </div>

      {message && <p className="inline-alert error" role="alert">{message}</p>}
      {products.length > 0 ? (
        <section className="manage-grid">
          {products.map((product) => (
            <article className="manage-card" key={product.id}>
              <div className="manage-card-image" role="img" aria-label={product.name} style={product.image ? { backgroundImage: `url(${product.image})` } : undefined}>
                <span className={`status-badge ${statusClass(product.status)}`}>{product.status}</span>
              </div>
              <div className="manage-card-body">
                <div className="manage-card-top"><div><h3>{product.name}</h3><p>{product.price.toFixed(2)} USDC · {productStock(product)} in stock</p></div></div>
                {product.variants.length > 0 && <p className="variant-summary">{product.variants.map((item) => `${item.value}: ${item.inventory}`).join(" · ")}</p>}
                <div className="manage-actions">
                  <button className="text-button" type="button" onClick={() => setEditing({ ...product, variants: product.variants.map((item) => ({ ...item })) })}>Edit</button>
                  <a className="text-button link-button" href={`/blink/${product.id}`} target="_blank" rel="noreferrer">Open Blink ↗</a>
                  <button className="text-button" type="button" onClick={() => void copyLink(product.id)}>{copiedId === product.id ? "Copied ✓" : "Copy link"}</button>
                  <button className="text-button danger-text" type="button" onClick={() => void deleteProduct(product.id)}>Delete</button>
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <div className="empty-state"><strong>No products yet</strong><p>Create your first product to start sharing a Blink.</p></div>
      )}

      {editing && (
        <div className="modal-backdrop" onClick={() => setEditing(null)}>
          <form className="edit-panel" onSubmit={saveProduct} onClick={(event) => event.stopPropagation()}>
            <button className="close-button" type="button" aria-label="Close editor" onClick={() => setEditing(null)}>×</button>
            <div className="checkout-eyebrow">EDIT PRODUCT</div><h2>{editing.name}</h2>
            <label>Name<input required value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} /></label>
            <label>Description<textarea rows={3} value={editing.description} onChange={(event) => setEditing({ ...editing, description: event.target.value })} /></label>
            <label>Price in USDC<input required min="0.01" step="0.01" type="number" value={editing.price} onChange={(event) => setEditing({ ...editing, price: Number(event.target.value) })} /></label>
            <div className="variant-editor">
              <div className="variant-editor-header"><span>Variants</span><button className="text-button" type="button" onClick={addEditingVariant}>+ Add variant</button></div>
              {editing.variants.map((item, index) => (
                <div className="variant-editor-row" key={item.id}>
                  <input aria-label="Variant group" required value={item.name} onChange={(event) => updateEditingVariant(index, "name", event.target.value)} />
                  <input aria-label="Variant value" required value={item.value} onChange={(event) => updateEditingVariant(index, "value", event.target.value)} />
                  <input aria-label="Variant inventory" required min="0" step="1" type="number" value={item.inventory} onChange={(event) => updateEditingVariant(index, "inventory", event.target.value)} />
                  <button className="text-button danger-text" type="button" aria-label={`Remove ${item.value || "variant"}`} onClick={() => removeEditingVariant(index)}>×</button>
                </div>
              ))}
            </div>
            <label>Inventory<input required min="0" step="1" type="number" value={productStock(editing)} disabled={editing.variants.length > 0} onChange={(event) => setEditing({ ...editing, inventory: Number(event.target.value) })} />{editing.variants.length > 0 && <small className="field-note">Calculated from variant stock</small>}</label>
            <label>Image URL<input type="url" value={editing.image} onChange={(event) => setEditing({ ...editing, image: event.target.value })} /></label>
            <button className="checkout-button" type="submit" disabled={saving}>{saving ? "Saving changes..." : "Save changes"}<span>↗</span></button>
          </form>
        </div>
      )}
    </section>
  );
}
