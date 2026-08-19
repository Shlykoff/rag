import { defineConfig } from "vitest/config";
import path from "node:path";

// Config for tests that hit a real, local Supabase (Docker) instance --
// see README "Running the integration tests" for how to run these
// (`npm run test:integration`, which loads .env.local via Node's
// --env-file). Kept separate from vitest.config.mts (plain `npm test`) so
// the default test run never requires Docker/`supabase start`.
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(
        import.meta.dirname,
        "node_modules/server-only/empty.js"
      ),
    },
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.integration.test.ts"],
    exclude: ["node_modules", ".next"],
    // DB round-trips (RPC calls, inserts/deletes) are slower than the pure
    // unit tests -- give them more headroom than vitest's 5s default.
    testTimeout: 20_000,
  },
});
