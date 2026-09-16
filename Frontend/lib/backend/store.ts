import { randomUUID } from "node:crypto";
import type { Order, Product, ProductStatus, ProductVariant } from "./types";

const merchantId = "merchant-aria-studio";
const now = new Date().toISOString();

const products = new Map<string, Product>([
  ["blk-001", { id: "blk-001", merchantId, name: "Afterglow hoodie", description: "A limited studio edition hoodie.", priceUsdc: 48, imageUrl: "https://images.unsplash.com/photo-1556821840-3a63f95609a7?auto=format&fit=crop&w=900&q=85", inventory: 24, status: "active", variants: [{ id: "s", name: "Size", value: "S", inventory: 6 }, { id: "m", name: "Size", value: "M", inventory: 10 }, { id: "l", name: "Size", value: "L", inventory: 8 }], createdAt: now, updatedAt: now }],
  ["blk-002", { id: "blk-002", merchantId, name: "Signal cap", description: "A signal for the next drop.", priceUsdc: 22, imageUrl: "https://images.unsplash.com/photo-1521369909029-2afed882baee?auto=format&fit=crop&w=900&q=85", inventory: 61, status: "active", variants: [], createdAt: now, updatedAt: now }],
  ["blk-003", { id: "blk-003", merchantId, name: "Studio pass 2026", description: "Access to the Aria Studio session.", priceUsdc: 12, imageUrl: "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=85", inventory: 120, status: "active", variants: [], createdAt: now, updatedAt: now }],
]);

const orders = new Map<string, Order>();

function refreshStatus(product: Product): Product {
  const status: ProductStatus = product.inventory === 0 ? "sold_out" : product.status === "sold_out" ? "active" : product.status;
  return { ...product, status };
}

export const store = {
  listProducts() { return [...products.values()].map(refreshStatus); },
  getProduct(id: string) { const product = products.get(id); return product ? refreshStatus(product) : undefined; },
  createProduct(input: Omit<Product, "id" | "createdAt" | "updatedAt" | "status">) {
    const timestamp = new Date().toISOString();
    const product: Product = { ...input, id: `blk-${randomUUID().slice(0, 8)}`, status: input.inventory > 0 ? "active" : "sold_out", createdAt: timestamp, updatedAt: timestamp };
    products.set(product.id, product);
    return product;
  },
  updateProduct(id: string, input: Partial<Pick<Product, "name" | "description" | "priceUsdc" | "imageUrl" | "inventory" | "status" | "variants">>) {
    const current = products.get(id);
    if (!current) return undefined;
    const product = refreshStatus({ ...current, ...input, updatedAt: new Date().toISOString() });
    products.set(id, product);
    return product;
  },
  deleteProduct(id: string) { return products.delete(id); },
  listOrders() { return [...orders.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
  getOrder(id: string) { return orders.get(id); },
  findOrderBySignature(signature: string) { return [...orders.values()].find((order) => order.txSignature === signature); },
  createOrder(input: Omit<Order, "id" | "createdAt" | "updatedAt" | "status">) {
    const timestamp = new Date().toISOString();
    const order: Order = { ...input, id: `order-${randomUUID().slice(0, 8)}`, status: "pending", createdAt: timestamp, updatedAt: timestamp };
    orders.set(order.id, order);
    return order;
  },
  attachSignature(id: string, signature: string) {
    const order = orders.get(id);
    if (!order) return undefined;
    const updated = { ...order, txSignature: signature, updatedAt: new Date().toISOString() };
    orders.set(id, updated);
    return updated;
  },
  markPaid(id: string) {
    const order = orders.get(id);
    if (!order || order.status === "paid") return order;
    const product = products.get(order.productId);
    if (!product || product.inventory < order.quantity) return undefined;
    products.set(product.id, refreshStatus({ ...product, inventory: product.inventory - order.quantity, updatedAt: new Date().toISOString() }));
    const updated = { ...order, status: "paid" as const, updatedAt: new Date().toISOString() };
    orders.set(id, updated);
    return updated;
  },
  markFailed(id: string) {
    const order = orders.get(id);
    if (!order || order.status === "paid") return order;
    const updated = { ...order, status: "failed" as const, updatedAt: new Date().toISOString() };
    orders.set(id, updated);
    return updated;
  },
};

export function normalizeVariants(value: unknown): ProductVariant[] {
  if (!Array.isArray(value)) return [];
  return value.filter((variant): variant is ProductVariant => typeof variant === "object" && variant !== null && typeof (variant as ProductVariant).name === "string" && typeof (variant as ProductVariant).value === "string" && Number.isInteger((variant as ProductVariant).inventory)).map((variant) => ({ id: variant.id || randomUUID(), name: variant.name, value: variant.value, inventory: variant.inventory }));
}