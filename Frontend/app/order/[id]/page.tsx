import type { Metadata } from "next";

import { OrderTracker } from "./OrderTracker";

type Context = { params: Promise<{ id: string }> };

export const metadata: Metadata = {
  title: "Track your order · BlinkShop",
  robots: { index: false },
};

/**
 * Buyer order tracking. The page itself reads no order data: the client
 * loads it through the authenticated API, which only answers the order's
 * own buyer (or merchant) and 404s for everyone else.
 */
export default async function OrderPage({ params }: Context) {
  const { id } = await params;

  return (
    <main className="blink-fallback">
      <div className="blink-fallback-card order-tracker-card">
        <div className="blink-fallback-brand">
          <span className="brand-mark">B</span>
          <span className="brand-wordmark">
            Blink<span className="brand-wordmark-accent">Shop</span>
          </span>
          <span className="network-chip">Solana Devnet</span>
        </div>
        <div className="blink-fallback-content">
          <OrderTracker orderId={id} />
        </div>
      </div>
    </main>
  );
}
