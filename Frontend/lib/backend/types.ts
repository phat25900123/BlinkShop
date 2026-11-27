export type ProductStatus = "active" | "inactive" | "sold_out";
/**
 * Order lifecycle. "paid" means the escrow is funded (or, for legacy "direct"
 * orders, the merchant was paid). Escrow orders then move to "shipped" and
 * finally "released" (merchant paid) or "refunded" (buyer paid back), always
 * mirroring verified on-chain escrow state.
 */
export type OrderStatus =
  | "pending"
  | "paid"
  | "shipped"
  | "released"
  | "refunded"
  | "failed"
  | "cancelled";

/** Statuses reached only after a verified payment. */
export const PAID_OR_LATER_STATUSES: readonly OrderStatus[] = [
  "paid",
  "shipped",
  "released",
  "refunded",
];

export function isPaidOrLater(status: OrderStatus) {
  return PAID_OR_LATER_STATUSES.includes(status);
}

export type EscrowActionName = "ship" | "confirm-receipt" | "refund" | "claim";

/**
 * How an order's USDC moved: "escrow" funds the BlinkShop escrow program;
 * "direct" is a legacy transfer straight to the merchant (orders created
 * before the escrow integration). Ship/refund only apply to "escrow".
 */
export type OrderSettlement = "escrow" | "direct";

export type ProductVariant = {
  id: string;
  name: string;
  value: string;
  inventory: number;
};

export type Product = {
  id: string;
  merchantId: string;
  merchantWallet: string;
  name: string;
  description: string;
  priceUsdc: number;
  imageUrl: string;
  inventory: number;
  status: ProductStatus;
  variants: ProductVariant[];
  createdAt: string;
  updatedAt: string;
};

export type Order = {
  id: string;
  productId: string;
  merchantId: string;
  merchantWallet: string;
  buyerWallet: string;
  variant?: string;
  quantity: number;
  amountUsdc: number;
  sponsoredTransactionHash?: string;
  txSignature?: string;
  settlement: OrderSettlement;
  /** True when BlinkShop's sponsor pays the fee and rent for this order. */
  sponsored: boolean;
  /**
   * Escrow lifecycle transaction BlinkShop prepared and is waiting for the
   * signer to return. Only one may be outstanding per order.
   */
  escrowAction?: {
    action: EscrowActionName;
    signer: string;
    messageHash: string;
    preparedAt: string;
  };
  /** Last lifecycle transaction the sponsor co-signed for this order. */
  escrowActionSignature?: string;
  shippedAt?: string;
  releasedAt?: string;
  refundedAt?: string;
  status: OrderStatus;
  inventoryReserved: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
