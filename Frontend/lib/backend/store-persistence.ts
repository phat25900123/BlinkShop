import fs from "node:fs";
import path from "node:path";
import type { Order, Product } from "./types";

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

export interface StorePersistenceAdapter {
  readonly kind: "json";
  load(): LoadedStore;
  save(products: Product[], orders: Order[]): void;
}

const dataDirectory = path.join(
  process.cwd(),
  "data",
);

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

    return {
      exists: true,
      products: parsed.products,
      orders: parsed.orders,
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
