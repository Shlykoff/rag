import { defineConfig } from "vitest/config";
import path from "node:path";

// Mirrors the `@/*` -> `./*` path alias from tsconfig.json so tests can use
// the same imports as application code (e.g. `@/lib/ai`).
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      // Next.js's webpack config resolves the `server-only` marker package
      // to its empty/no-op export (via the `react-server` package.json
      // export condition) so importing it in real server code is a no-op.
      // Vitest runs plain Node without that condition, so `server-only`'s
      // default export (which unconditionally throws) would break every
      // test that imports a module guarded by `import "server-only"` --
      // alias it to the same empty module Next.js itself uses.
      "server-only": path.resolve(
        import.meta.dirname,
        "node_modules/server-only/empty.js"
      ),
    },
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
    // *.integration.test.ts files need a live local Supabase (Docker) --
    // they live under vitest.integration.config.mts / `npm run
    // test:integration` instead, so plain `npm test` never requires Docker
    // to be running and stays safe to run in any environment/CI.
    exclude: ["node_modules", ".next", "**/*.integration.test.ts"],
  },
});
