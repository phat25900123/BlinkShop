import { vi } from "vitest";

// Business-rule tests use an in-memory state and must never touch the checked-in
// demo store or depend on filesystem persistence.
vi.mock("../lib/backend/store-persistence", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../lib/backend/store-persistence")>();

  return {
    ...actual,
    jsonPersistenceAdapter: {
      kind: "json",
      load: () => ({
        exists: true,
        products: [],
        orders: [],
      }),
      save: vi.fn(),
    },
  };
});
