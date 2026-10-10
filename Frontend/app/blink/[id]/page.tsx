import { notFound } from "next/navigation";
import { store } from "@/lib/backend/store";
import { BlinkCheckout } from "./BlinkCheckout";

type Context = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

export default async function BlinkFallback({ params }: Context) {
  const { id } = await params;
  const product = store.getProduct(id);
  if (!product) notFound();

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const actionUrl = `${appUrl}/api/actions/product/${product.id}`;
  const availableVariants = product.variants.filter((variant) => variant.inventory > 0);
  const availability = product.variants.length > 0
    ? availableVariants.length > 0
      ? `${availableVariants.length} options available`
      : "Sold out"
    : product.inventory > 0
      ? `${product.inventory} available`
      : "Sold out";

  return (
    <main className="blink-fallback">
      <div className="blink-fallback-card">
        <div className="blink-fallback-brand"><span className="brand-mark">B</span><span className="brand-wordmark">Blink<span className="brand-wordmark-accent">Shop</span></span><span className="network-chip">Solana Devnet</span></div>
        <div className="blink-fallback-image" role="img" aria-label={product.name} style={product.imageUrl ? { backgroundImage: `url(${product.imageUrl})` } : undefined} />
        <div className="blink-fallback-content">
          <p className="eyebrow">BLINKSHOP MERCHANT</p>
          <h1>{product.name}</h1>
          <p className="blink-fallback-description">{product.description}</p>
          <div className="blink-fallback-price"><strong>{product.priceUsdc.toFixed(2)} <small>USDC</small></strong><span className={availability === "Sold out" ? "sold-out-text" : ""}>{availability}</span></div>
          <BlinkCheckout product={product} />
          {process.env.NODE_ENV !== "production" && <a className="blink-fallback-action-link" href={actionUrl}>View Action metadata <span>↗</span></a>}
          <p className="blink-fallback-note">Direct merchant checkout. Payments settle to the product owner in Devnet USDC.</p>
        </div>
      </div>
    </main>
  );
}
