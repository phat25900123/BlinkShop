export type ProductStatus = "active" | "inactive" | "sold_out";
export type OrderStatus = "pending" | "paid" | "failed" | "cancelled";

export type ProductVariant = {
  id: string;
  name: string;
  value: string;
  inventory: number;
};

export type Product = {
  id: string;
  merchantId: string;
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
  buyerWallet: string;
  variant?: string;
  quantity: number;
  amountUsdc: number;
  txSignature?: string;
  status: OrderStatus;
  createdAt: string;
  updatedAt: string;
};