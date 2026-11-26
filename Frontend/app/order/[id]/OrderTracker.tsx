"use client";

import { useCallback, useEffect, useState } from "react";

import {
  EscrowActionButtons,
  useAuthorizedFetch,
  useNow,
} from "@/components/escrow/EscrowActionButtons";
import { useBlinkShopAuth } from "@/components/providers/PrivyProvider";
import {
  buyerActions,
  buyerActionsSupported,
  explorerTxUrl,
  formatCountdown,
  lifecycleBadge,
  type EscrowTiming,
  type OrderView,
  type SyncResponse,
  type ViewerRole,
} from "@/lib/escrow-ui";

type LoadState =
  | { kind: "loading" }
  | { kind: "not_found" }
  | { kind: "error"; message: string }
  | { kind: "ready"; order: OrderView; escrow: EscrowTiming | null };

function formatUsdc(value: number) {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(value);
}

function shortValue(value: string) {
  return value.length > 12 ? `${value.slice(0, 5)}...${value.slice(-5)}` : value;
}

const NOT_FOUND = {
  kind: "not_found",
} as const;

type AuthorizedFetch = ReturnType<typeof useAuthorizedFetch>;

/** The order for the signed-in buyer; anything else reads as not found. */
async function fetchBuyerOrder(
  authorizedFetch: AuthorizedFetch,
  orderId: string,
): Promise<LoadState> {
  const url = `/api/orders/${encodeURIComponent(orderId)}/escrow`;
  try {
    const response = await authorizedFetch(url);
    if (response.status === 404) return NOT_FOUND;
    if (!response.ok) return { kind: "error", message: "Unable to load this order." };
    const data = (await response.json()) as { order: OrderView; roles: ViewerRole[] };
    // This page is for the buyer. The merchant has the dashboard.
    if (!data.roles.includes("buyer")) return NOT_FOUND;

    let order = data.order;
    let escrow: EscrowTiming | null = null;
    if (
      order.settlement === "escrow" &&
      (order.status === "paid" || order.status === "shipped")
    ) {
      // Bring the status up to date with the chain and read the deadlines.
      const synced = await authorizedFetch(url, { method: "POST" });
      if (synced.ok) {
        const body = (await synced.json()) as SyncResponse;
        order = body.order;
        escrow = body.escrow;
      }
    }
    return { kind: "ready", order, escrow };
  } catch {
    return { kind: "error", message: "Unable to load this order." };
  }
}

function useBuyerOrder(orderId: string, enabled: boolean) {
  const authorizedFetch = useAuthorizedFetch();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const reload = useCallback(async () => {
    setState(await fetchBuyerOrder(authorizedFetch, orderId));
  }, [authorizedFetch, orderId]);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void fetchBuyerOrder(authorizedFetch, orderId).then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, authorizedFetch, orderId]);

  return { state, setState, reload };
}

function Countdown({ order, escrow, now }: { order: OrderView; escrow: EscrowTiming | null; now: number }) {
  if (order.settlement !== "escrow") return null;

  if (order.status === "paid") {
    const left = formatCountdown(escrow?.shipBy, now);
    if (!left) return null;
    return (
      <div className="order-countdown">
        <span>Merchant must ship within</span>
        <strong>{left === "ended" ? "Deadline passed" : left}</strong>
      </div>
    );
  }

  if (order.status === "shipped") {
    const left = formatCountdown(escrow?.releaseAfter, now);
    if (!left) return null;
    return (
      <div className="order-countdown">
        <span>Buyer protection ends in</span>
        <strong>{left === "ended" ? "Ended" : left}</strong>
      </div>
    );
  }

  return null;
}

function StatusExplanation({ order, escrow, now }: { order: OrderView; escrow: EscrowTiming | null; now: number }) {
  if (order.settlement === "direct") {
    return <p className="success-copy">This order was paid directly to the merchant before escrow protection was available.</p>;
  }
  switch (order.status) {
    case "pending":
      return <p className="success-copy">Waiting for payment to be confirmed.</p>;
    case "paid": {
      const passed = formatCountdown(escrow?.shipBy, now) === "ended";
      return (
        <p className="success-copy">
          {passed
            ? "The merchant did not ship in time. You can claim a full refund."
            : "Your payment is held in escrow until the merchant ships."}
        </p>
      );
    }
    case "shipped":
      return (
        <p className="success-copy">
          The merchant marked this order as shipped. Confirm receipt once it arrives;
          otherwise the payment is released to the merchant when buyer protection ends.
        </p>
      );
    case "released":
      return <p className="success-copy">The payment was released to the merchant. This order is complete.</p>;
    case "refunded":
      return <p className="success-copy">This order was refunded. The USDC was returned to your wallet.</p>;
    default:
      return <p className="success-copy">This checkout did not complete. No payment was taken.</p>;
  }
}

function OrderDetails({
  order,
  escrow,
  onSettled,
  onRefresh,
}: {
  order: OrderView;
  escrow: EscrowTiming | null;
  onSettled: (synced: SyncResponse | null) => void;
  onRefresh: () => void;
}) {
  const now = useNow();
  const badge = lifecycleBadge(order);
  const actions = buyerActions(order, escrow, now);
  const externalWallet = order.settlement === "escrow" && !buyerActionsSupported(order);
  const lockedInEscrow =
    order.settlement === "escrow" && (order.status === "paid" || order.status === "shipped");

  return (
    <>
      <p className="checkout-eyebrow">ORDER STATUS</p>
      <h1 className="order-tracker-title">{order.productName}</h1>
      <span className={`order-status ${badge.tone}`}><i />{badge.label}</span>
      <StatusExplanation order={order} escrow={escrow} now={now} />
      <Countdown order={order} escrow={escrow} now={now} />

      <dl className="receipt-details">
        <div><dt>Order ID</dt><dd className="mono" title={order.id}>{shortValue(order.id)}</dd></div>
        <div><dt>Amount</dt><dd>{formatUsdc(order.amountUsdc)} USDC</dd></div>
        {order.variant && <div><dt>Variant</dt><dd>{order.variant}</dd></div>}
        <div><dt>Quantity</dt><dd>{order.quantity}</dd></div>
        <div><dt>Placed</dt><dd>{new Date(order.createdAt).toLocaleString()}</dd></div>
        <div><dt>Wallet</dt><dd className="mono" title={order.buyerWallet}>{shortValue(order.buyerWallet)}</dd></div>
      </dl>

      {externalWallet ? (
        lockedInEscrow && (
          <p className="order-note">
            This order was paid from an external wallet through a Blink, so confirming
            receipt and claiming a refund aren&apos;t available here. Contact the merchant
            about this order. They can still ship or refund it.
          </p>
        )
      ) : (
        <EscrowActionButtons
          orderId={order.id}
          role="buyer"
          actions={actions}
          onSettled={({ synced }) => onSettled(synced)}
        />
      )}

      <div className="receipt-actions">
        {order.txSignature && (
          <a className="secondary-button" href={explorerTxUrl(order.txSignature)} target="_blank" rel="noreferrer">
            Payment transaction ↗
          </a>
        )}
        {order.escrowActionSignature && (
          <a className="secondary-button" href={explorerTxUrl(order.escrowActionSignature)} target="_blank" rel="noreferrer">
            Latest update ↗
          </a>
        )}
        {lockedInEscrow && (
          <button className="secondary-button" type="button" onClick={onRefresh}>
            Refresh status
          </button>
        )}
      </div>
    </>
  );
}

function SignedInTracker({ orderId }: { orderId: string }) {
  const auth = useBlinkShopAuth();
  const ready = auth.ready && auth.authenticated;
  const { state, setState, reload } = useBuyerOrder(orderId, ready);

  if (!auth.ready || (ready && state.kind === "loading")) {
    return <p className="success-copy" role="status">Loading your order…</p>;
  }

  if (!auth.authenticated) {
    return (
      <>
        <p className="checkout-eyebrow">TRACK YOUR ORDER</p>
        <h1 className="order-tracker-title">Sign in to see this order</h1>
        <p className="success-copy">Use the same email you checked out with.</p>
        <button className="checkout-button" type="button" onClick={auth.login}>
          Continue with email<span>&gt;</span>
        </button>
      </>
    );
  }

  if (state.kind === "not_found") {
    return (
      <>
        <p className="checkout-eyebrow">TRACK YOUR ORDER</p>
        <h1 className="order-tracker-title">Order not found</h1>
        <p className="success-copy">
          We couldn&apos;t find this order for your account. Make sure you&apos;re signed in
          with the email you used at checkout.
        </p>
        <button className="secondary-button" type="button" onClick={() => void auth.logout()}>
          Sign out
        </button>
      </>
    );
  }

  if (state.kind === "error") {
    return (
      <>
        <p className="payment-message error" role="alert">{state.message}</p>
        <button className="secondary-button" type="button" onClick={() => void reload()}>
          Try again
        </button>
      </>
    );
  }

  if (state.kind !== "ready") return null;

  return (
    <OrderDetails
      order={state.order}
      escrow={state.escrow}
      onRefresh={() => void reload()}
      onSettled={(synced) => {
        if (synced) setState({ kind: "ready", order: synced.order, escrow: synced.escrow });
        else void reload();
      }}
    />
  );
}

export function OrderTracker({ orderId }: { orderId: string }) {
  const auth = useBlinkShopAuth();
  if (!auth.configured) {
    return (
      <p className="success-copy">
        Order tracking needs BlinkShop sign-in, which is not configured on this deployment.
      </p>
    );
  }
  return <SignedInTracker orderId={orderId} />;
}
