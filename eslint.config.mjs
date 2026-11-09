import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // docs/ARCHITECTURE.md §13.14: production code under lib/** and app/**
  // must never import test doubles or fixtures from /tests/**. Test files
  // next to their module (*.test.ts) are the only allowed importers.
  {
    files: ["lib/**/*.{ts,tsx}", "app/**/*.{ts,tsx}"],
    ignores: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/tests", "@/tests/**", "**/tests", "**/tests/**"],
              message:
                "lib/** and app/** must not import from /tests/** (ARCHITECTURE.md §13.14). Only *.test.ts files may.",
            },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
