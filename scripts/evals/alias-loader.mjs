/**
 * Lets manual eval scripts import lib code under plain Node (>= 22.15, native
 * TypeScript type stripping) by resolving the tsconfig `@/*` path alias and
 * extensionless imports to `.ts` files. Used as:
 *
 *   node --import ./scripts/evals/alias-loader.mjs scripts/evals/<script>.ts
 *
 * In-thread synchronous hooks (`module.registerHooks`), no dependencies.
 * Not used by the app, Next.js, or vitest (they read tsconfig paths themselves).
 */

import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

function resolveFile(base) {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const file = resolveFile(repoRoot + specifier.slice(2));
      if (file) {
        return nextResolve(pathToFileURL(file).href, context);
      }
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
      const base = fileURLToPath(new URL(specifier, context.parentURL));
      if (!existsSync(base)) {
        const file = resolveFile(base);
        if (file) {
          return nextResolve(pathToFileURL(file).href, context);
        }
      }
    }
    return nextResolve(specifier, context);
  },
});
