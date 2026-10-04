import { vi } from "vitest";

// Business-rule tests use an in-memory state and must never touch the checked-in
// demo store or depend on filesystem persistence.
vi.mock("../lib/backend/store-persistence", () => ({
  jsonPersistenceAdapter: {
    kind: "json",
    load: () => ({
      exists: true,
      products: [],
      orders: [],
    }),
    save: vi.fn(),
  },
}));
