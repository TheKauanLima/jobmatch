import { defineConfig } from "vitest/config";

/**
 * Minimal Vitest config for unit/integration-level tests of plain TS
 * modules and Next.js route-adjacent logic (middleware, lib helpers).
 *
 * Deliberately no Playwright/e2e infra here — see CLAUDE.md / ARCHITECTURE.md
 * for why unit+integration is the right scope for now.
 */
export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: ["node_modules/**", ".next/**"],
    globals: true,
  },
});
