/**
 * Client-safe escrow lifecycle helpers shared by the merchant dashboard and
 * the buyer order page. Pure functions only: everything here only decides
 * what to show. The server re-checks every action (role, wallet, store
 * status and on-chain state) before it builds or co-signs a transaction.
 */

export type EscrowActionName = "ship" | "confirm-receipt" | "refund" | "claim";

export type OrderStatusName =
  | "pending"
  | "paid"
  | "shipped"
  | "released"
  | "refunded"
  | "failed"
  | "cancelled";

/** The order fields BlinkShop exposes to the order's merchant and buyer. */
export type OrderView = {
  id: string;
  productId: string;
  productName: string;
  variant?: string;
  quantity: number;
  amountUsdc: number;
  status: OrderStatusName;
  settlement: "escrow" | "direct";
  sponsored: boolean;
  buyerWallet: string;
  merchantWallet: string;
  txSignature?: string;
  escrowActionSignature?: string;
  createdAt: string;
  shippedAt?: string;
  releasedAt?: string;
  refundedAt?: string;
};

/** On-chain deadlines, as ISO strings; releaseAfter is null until shipped. */
export type EscrowTiming = {
  status: "funded" | "shipped" | "released" | "refunded";
  shipBy: string;
  releaseAfter: string | null;
};

export type ViewerRole = "merchant" | "buyer";

export type LifecycleBadge = {
  label: string;
  tone: "pending" | "funded" | "shipped" | "released" | "refunded" | "failed";
};

export function lifecycleBadge(
  order: Pick<OrderView, "status" | "settlement">,
): LifecycleBadge {
  switch (order.status) {
    case "paid":
      return order.settlement === "escrow"
        ? { label: "Funded", tone: "funded" }
        : { label: "Paid", tone: "released" };
    case "shipped":
      return { label: "Shipped", tone: "shipped" };
    case "released":
      return { label: "Released", tone: "released" };
    case "refunded":
      return { label: "Refunded", tone: "refunded" };
    case "pending":
      return { label: "Pending", tone: "pending" };
    case "cancelled":
      return { label: "Cancelled", tone: "failed" };
    default:
      return { label: "Failed", tone: "failed" };
  }
}

function hasPassed(iso: string | null | undefined, now: number) {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && now >= time;
}

/** Program rule: a buyer refund needs now > ship_by (strictly after). */
function isStrictlyAfter(iso: string | null | undefined, now: number) {
  if (!iso) return false;
  const time = Date.parse(iso);
  return Number.isFinite(time) && now > time;
}

/**
 * Buyer actions run through the BlinkShop sponsor with the buyer's Privy
 * embedded wallet. Orders paid from an external wallet (Blink/Phantom) are
 * buyer-funded and that buyer has no Privy wallet to sign with here.
 */
export function buyerActionsSupported(
  order: Pick<OrderView, "settlement" | "sponsored">,
) {
  return order.settlement === "escrow" && order.sponsored;
}

export function merchantActions(
  order: Pick<OrderView, "status" | "settlement">,
  timing: EscrowTiming | null,
  now: number,
): EscrowActionName[] {
  if (order.settlement !== "escrow") return [];
  if (order.status === "paid") return ["ship", "refund"];
  if (order.status === "shipped") {
    return hasPassed(timing?.releaseAfter, now) ? ["claim", "refund"] : ["refund"];
  }
  return [];
}

export function buyerActions(
  order: Pick<OrderView, "status" | "settlement" | "sponsored">,
  timing: EscrowTiming | null,
  now: number,
): EscrowActionName[] {
  if (!buyerActionsSupported(order)) return [];
  if (order.status === "shipped") return ["confirm-receipt"];
  if (order.status === "paid" && isStrictlyAfter(timing?.shipBy, now)) {
    return ["refund"];
  }
  return [];
}

export const ACTION_LABELS: Record<ViewerRole, Record<EscrowActionName, string>> = {
  merchant: {
    ship: "Mark shipped",
    refund: "Refund",
    claim: "Claim payout",
    "confirm-receipt": "Confirm receipt",
  },
  buyer: {
    ship: "Mark shipped",
    refund: "Claim refund",
    claim: "Claim payout",
    "confirm-receipt": "Confirm receipt",
  },
};

export const ACTION_CONFIRMATIONS: Partial<Record<EscrowActionName, string>> = {
  refund: "Refund the full amount to the buyer? This cannot be undone.",
  "confirm-receipt":
    "Confirm you received this order? The payment will be released to the merchant.",
};

/** "2d 4h", "3h 12m", "45s"; "ended" once the deadline passed. */
export function formatCountdown(targetIso: string | null | undefined, now: number) {
  if (!targetIso) return null;
  const target = Date.parse(targetIso);
  if (!Number.isFinite(target)) return null;
  let seconds = Math.floor((target - now) / 1000);
  if (seconds <= 0) return "ended";

  const days = Math.floor(seconds / 86_400);
  seconds -= days * 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds -= hours * 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds -= minutes * 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Released revenue: escrow orders released to the merchant, plus legacy
 * direct orders (their USDC went straight to the merchant). In escrow:
 * funded or shipped escrow orders. Pending, failed, cancelled and refunded
 * orders count toward neither.
 */
export function revenueSummary(
  orders: Pick<OrderView, "status" | "settlement" | "amountUsdc">[],
) {
  let released = 0;
  let inEscrow = 0;
  for (const order of orders) {
    if (order.status === "released") released += order.amountUsdc;
    else if (order.status === "paid" && order.settlement === "direct") {
      released += order.amountUsdc;
    } else if (
      order.settlement === "escrow" &&
      (order.status === "paid" || order.status === "shipped")
    ) {
      inEscrow += order.amountUsdc;
    }
  }
  return { released, inEscrow };
}

export function explorerTxUrl(signature: string) {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=devnet`;
}

const ERROR_MESSAGES: Record<string, string> = {
  window_not_elapsed: "The time window for this action has not ended yet.",
  escrow_state_mismatch:
    "The order already changed on-chain. Refresh to see its current status.",
  order_status_invalid:
    "This action is no longer available for the order. Refresh to see its current status.",
  actor_not_allowed: "You are not allowed to perform this action.",
  actor_wallet_mismatch: "Your wallet is not the wallet recorded on this order.",
  destination_token_missing:
    "The USDC token account that receives the funds does not exist.",
  sponsor_balance_low:
    "BlinkShop cannot cover network fees right now. Please try again later.",
  blockhash_expired: "The transaction expired before it was sent. Please try again.",
  transaction_message_mismatch:
    "The order changed while you were signing. Please try again.",
  broadcast_failed:
    "The network did not confirm the transaction. Refresh before trying again.",
  embedded_wallet_unavailable:
    "Your embedded wallet is still being created. Wait a moment and try again.",
};

export function friendlyEscrowError(code: string | undefined, fallback: string) {
  return (code && ERROR_MESSAGES[code]) || fallback;
}

export class EscrowActionRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EscrowActionRequestError";
  }
}

export type EscrowActionStep = "preparing" | "signing" | "submitting" | "syncing";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function readJson(response: Response) {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

async function postOrThrow(fetcher: FetchLike, url: string, body?: unknown) {
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const code = typeof data.code === "string" ? data.code : undefined;
    const error = typeof data.error === "string" ? data.error : "Request failed";
    throw new EscrowActionRequestError(
      friendlyEscrowError(code, error),
      code,
      response.status,
    );
  }
  return data;
}

export type SyncResponse = {
  order: OrderView;
  changed: boolean;
  escrow: EscrowTiming | null;
};

/**
 * prepare -> sign (Privy embedded wallet) -> submit -> sync. The client
 * sends only the action name and, on submit, the signed transaction; the
 * server derives every account and amount itself.
 */
export async function runEscrowAction(input: {
  orderId: string;
  action: EscrowActionName;
  fetcher: FetchLike;
  sign: (transaction: Uint8Array) => Promise<Uint8Array>;
  onStep?: (step: EscrowActionStep) => void;
  wait?: (ms: number) => Promise<void>;
}) {
  const wait =
    input.wait ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const base = `/api/orders/${encodeURIComponent(input.orderId)}/escrow`;

  input.onStep?.("preparing");
  const prepared = await postOrThrow(input.fetcher, `${base}/${input.action}`);
  if (typeof prepared.transaction !== "string") {
    throw new EscrowActionRequestError("The server did not return a transaction.");
  }

  input.onStep?.("signing");
  const signed = await input.sign(decodeBase64(prepared.transaction));

  input.onStep?.("submitting");
  const submitted = await postOrThrow(input.fetcher, `${base}/${input.action}/submit`, {
    signedTransaction: encodeBase64(signed),
  });
  const txSignature =
    typeof submitted.txSignature === "string" ? submitted.txSignature : "";

  input.onStep?.("syncing");
  // The store only moves once the change is visible on-chain; a short retry
  // covers RPC lag after a confirmed broadcast.
  let synced: SyncResponse | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    synced = (await postOrThrow(input.fetcher, base)) as unknown as SyncResponse;
    if (synced.changed || attempt === 2) break;
    await wait(1500);
  }

  return { txSignature, synced };
}

export function decodeBase64(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

export function encodeBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export const STEP_LABELS: Record<EscrowActionStep, string> = {
  preparing: "Preparing…",
  signing: "Waiting for signature…",
  submitting: "Sending…",
  syncing: "Confirming on Solana…",
};
