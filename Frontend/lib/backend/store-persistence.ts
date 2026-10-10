import fs from "node:fs";
import path from "node:path";
import type { Order, Product } from "./types";

type LegacyProduct = Omit<Product, "merchantWallet"> & {
  merchantWallet?: unknown;
};

type LegacyOrder = Omit<Order, "merchantWallet"> & {
  merchantWallet?: unknown;
};

export type PersistedStore = {
  version: 1;
  products: Product[];
  orders: Order[];
};

export type LoadedStore = {
  exists: boolean;
  products: Product[];
  orders: Order[];
};

function legacyMerchantId(merchantId: string) {
  const configuredLegacyDid = process.env.PRIVY_MERCHANT_USER_ID?.trim();

  return merchantId === "merchant-aria-studio" && configuredLegacyDid
    ? configuredLegacyDid
    : merchantId;
}

function storedWallet(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : fallback;
}

/**
 * Keeps the existing Railway JSON volume readable while new records use the
 * self-service merchant schema. Legacy environment variables are migration
 * inputs only; they never determine ownership or payout for new products.
 */
export function normalizeLegacyStore(input: {
  products: LegacyProduct[];
  orders: LegacyOrder[];
}): Pick<LoadedStore, "products" | "orders"> {
  const legacyWallet = process.env.MERCHANT_WALLET?.trim() || "";
  const products = input.products.map((product) => ({
    ...product,
    merchantId: legacyMerchantId(product.merchantId),
    merchantWallet: storedWallet(product.merchantWallet, legacyWallet),
  }));
  const productsById = new Map(products.map((product) => [product.id, product]));
  const orders = input.orders.map((order) => {
    const product = productsById.get(order.productId);

    return {
      ...order,
      merchantId: legacyMerchantId(order.merchantId),
      merchantWallet: storedWallet(
        order.merchantWallet,
        product?.merchantWallet || legacyWallet,
      ),
    };
  });

  return { products, orders };
}

export interface StorePersistenceAdapter {
  readonly kind: "json";
  load(): LoadedStore;
  save(products: Product[], orders: Order[]): void;
}

const configuredDataDirectory = process.env.DATA_DIR?.trim();

const dataDirectory = configuredDataDirectory
  ? path.resolve(configuredDataDirectory)
  : path.join(process.cwd(), "data");

const storeFile = path.join(
  dataDirectory,
  "store.json",
);

function loadStoreFromDisk(): LoadedStore {
  try {
    if (!fs.existsSync(storeFile)) {
      return {
        exists: false,
        products: [],
        orders: [],
      };
    }

    const raw = fs.readFileSync(
      storeFile,
      "utf8",
    );

    const parsed = JSON.parse(
      raw,
    ) as Partial<PersistedStore>;

    if (
      !Array.isArray(parsed.products) ||
      !Array.isArray(parsed.orders)
    ) {
      throw new Error(
        "Invalid BlinkShop store format",
      );
    }

    const normalized = normalizeLegacyStore({
      products: parsed.products as LegacyProduct[],
      orders: parsed.orders as LegacyOrder[],
    });

    return {
      exists: true,
      ...normalized,
    };
  } catch (error) {
    console.error(
      "Failed to load BlinkShop store:",
      error instanceof Error
        ? error.message
        : error,
    );

    return {
      exists: false,
      products: [],
      orders: [],
    };
  }
}

function saveStoreToDisk(
  products: Product[],
  orders: Order[],
) {
  try {
    fs.mkdirSync(dataDirectory, {
      recursive: true,
    });

    const data: PersistedStore = {
      version: 1,
      products,
      orders,
    };

    fs.writeFileSync(
      storeFile,
      JSON.stringify(data, null, 2),
      "utf8",
    );
  } catch (error) {
    console.error(
      "Failed to save BlinkShop store:",
      error instanceof Error
        ? error.message
        : error,
    );
  }
}

export function getStoreFilePath() {
  return storeFile;
}

export const jsonPersistenceAdapter: StorePersistenceAdapter = {
  kind: "json",
  load: loadStoreFromDisk,
  save: saveStoreToDisk,
};
