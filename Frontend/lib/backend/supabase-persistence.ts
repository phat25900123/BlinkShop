import type { Order, Product } from "./types";

type ProductRow = {
  id: string;
  merchant_id: string;
  name: string;
  description: string;
  price_usdc: number | string;
  image_url: string;
  inventory: number;
  status: Product["status"];
  variants: Product["variants"];
  created_at: string;
  updated_at: string;
};

type OrderRow = {
  id: string;
  product_id: string;
  merchant_id: string;
  buyer_wallet: string;
  variant: string | null;
  quantity: number;
  amount_usdc: number | string;
  tx_signature: string | null;
  status: Order["status"];
  inventory_reserved: boolean;
  created_at: string;
  updated_at: string;
  expires_at: string;
};

function productFromRow(row: ProductRow): Product {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    name: row.name,
    description: row.description,
    priceUsdc: Number(row.price_usdc),
    imageUrl: row.image_url,
    inventory: row.inventory,
    status: row.status,
    variants: row.variants,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function productToRow(product: Product): ProductRow {
  return {
    id: product.id,
    merchant_id: product.merchantId,
    name: product.name,
    description: product.description,
    price_usdc: product.priceUsdc,
    image_url: product.imageUrl,
    inventory: product.inventory,
    status: product.status,
    variants: product.variants,
    created_at: product.createdAt,
    updated_at: product.updatedAt,
  };
}

function orderFromRow(row: OrderRow): Order {
  return {
    id: row.id,
    productId: row.product_id,
    merchantId: row.merchant_id,
    buyerWallet: row.buyer_wallet,
    ...(row.variant ? { variant: row.variant } : {}),
    quantity: row.quantity,
    amountUsdc: Number(row.amount_usdc),
    ...(row.tx_signature ? { txSignature: row.tx_signature } : {}),
    status: row.status,
    inventoryReserved: row.inventory_reserved,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function orderToRow(order: Order): OrderRow {
  return {
    id: order.id,
    product_id: order.productId,
    merchant_id: order.merchantId,
    buyer_wallet: order.buyerWallet,
    variant: order.variant || null,
    quantity: order.quantity,
    amount_usdc: order.amountUsdc,
    tx_signature: order.txSignature || null,
    status: order.status,
    inventory_reserved: order.inventoryReserved,
    created_at: order.createdAt,
    updated_at: order.updatedAt,
    expires_at: order.expiresAt,
  };
}

/**
 * Server-only persistence primitives for the Supabase migration.
 *
 * This adapter is intentionally not selected by store-state yet. The current
 * synchronous business store protects the tested local flow; production
 * activation also needs transactional reserve/release database functions so
 * multiple serverless instances cannot oversell the same inventory.
 */
export class SupabasePersistenceAdapter {
  private readonly baseUrl: string;
  private readonly serviceRoleKey: string;

  constructor() {
    const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
    this.baseUrl = `${url}/rest/v1`;
    this.serviceRoleKey = serviceRoleKey;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        apikey: this.serviceRoleKey,
        Authorization: `Bearer ${this.serviceRoleKey}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`Supabase persistence request failed with status ${response.status}`);
    }
    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }

  async load() {
    const [productRows, orderRows] = await Promise.all([
      this.request<ProductRow[]>("products?select=*&order=created_at.asc"),
      this.request<OrderRow[]>("orders?select=*&order=created_at.asc"),
    ]);
    return {
      exists: productRows.length > 0 || orderRows.length > 0,
      products: productRows.map(productFromRow),
      orders: orderRows.map(orderFromRow),
    };
  }

  async upsertProduct(product: Product) {
    await this.request<void>("products?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(productToRow(product)),
    });
  }

  async deleteProduct(id: string) {
    await this.request<void>(`products?id=eq.${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" },
    });
  }

  async upsertOrder(order: Order) {
    await this.request<void>("orders?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(orderToRow(order)),
    });
  }
}
