export type ProductStatus = "active" | "inactive" | "sold_out";
export type OrderStatus = "pending" | "paid" | "failed" | "cancelled";

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
  status: OrderStatus;
  inventoryReserved: boolean;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
};
