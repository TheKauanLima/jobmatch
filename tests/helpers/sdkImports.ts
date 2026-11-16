/**
 * Test-only import scanner for the SDK guard tests (lib/claude/client.test.ts,
 * lib/claude/outputSchemas.test.ts). Checks what files IMPORT, not how
 * identifiers happen to be spelled, so renaming an import (`import X from`)
 * can't bypass a guard.
 *
 * Deliberately simple and conservative: comments are stripped first, then
 * every static import/re-export, side-effect import, dynamic `import()` and
 * `require()` with a string-literal specifier is collected. Type-only imports
 * (`import type ...`, `export type ... from`, or `import { type A, type B }`
 * where every specifier is a type) are marked `typeOnly`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const REPO_ROOT = process.cwd();

const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** Test files and test support code (tests/**) are exempt from the guards. */
export function isTestFile(relPath: string): boolean {
  return /\.test\.(ts|tsx)$/.test(relPath) || relPath.startsWith("tests/");
}

export function toRel(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join("/");
}

/** Every source file under the repo root, skipping node_modules and dot-dirs (.next, .git, ...). */
export function repoSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (SOURCE_EXT.test(entry)) files.push(toRel(full));
    }
  };
  walk(REPO_ROOT);
  return files.sort();
}

export type ImportSite = {
  specifier: string;
  typeOnly: boolean;
  /** Local names bound to values from this import (default, named, namespace). */
  bindings: string[];
  kind: "static" | "side-effect" | "dynamic";
};

/** Removes block and line comments (approximate; good enough for guard scans). */
export function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:\w"'`])\/\/.*$/gm, "$1");
}

function parseClause(clause: string): { typeOnly: boolean; bindings: string[] } {
  const bindings: string[] = [];
  let valueSpecifiers = 0;
  let typeSpecifiers = 0;
  const braces = clause.match(/\{([\s\S]*)\}/);
  const outside = clause.replace(/\{[\s\S]*\}/, "").replace(/,/g, " ").trim();
  if (braces) {
    for (const raw of braces[1].split(",")) {
      const spec = raw.trim();
      if (!spec) continue;
      if (/^type\s/.test(spec)) {
        typeSpecifiers += 1;
        continue;
      }
      valueSpecifiers += 1;
      const alias = spec.match(/\bas\s+([\w$]+)$/);
      bindings.push(alias ? alias[1] : spec);
    }
  }
  const ns = outside.match(/\*\s+as\s+([\w$]+)/);
  if (ns) {
    bindings.push(ns[1]);
    valueSpecifiers += 1;
  }
  const def = outside.replace(/\*\s+as\s+[\w$]+/, "").trim();
  if (def && def !== "*") {
    bindings.push(def);
    valueSpecifiers += 1;
  }
  if (outside === "*") valueSpecifiers += 1; // export * from
  return { typeOnly: valueSpecifiers === 0 && typeSpecifiers > 0, bindings };
}

export function importsOf(source: string): ImportSite[] {
  const text = stripComments(source);
  const sites: ImportSite[] = [];

  const staticRe = /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;'"`]*?)\s*from\s*["']([^"']+)["']/g;
  for (const m of text.matchAll(staticRe)) {
    const typeKeyword = Boolean(m[2]);
    const parsed = parseClause(m[3]);
    sites.push({
      specifier: m[4],
      typeOnly: typeKeyword || parsed.typeOnly,
      bindings: typeKeyword ? [] : parsed.bindings,
      kind: "static",
    });
  }
  for (const m of text.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)) {
    sites.push({ specifier: m[1], typeOnly: false, bindings: [], kind: "side-effect" });
  }
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    sites.push({ specifier: m[1], typeOnly: false, bindings: [], kind: "dynamic" });
  }
  return sites;
}

export const isSdkSpecifier = (specifier: string): boolean => /^@anthropic-ai\/sdk(\/|$)/.test(specifier);

/** Non-type SDK imports per (non-test) file. */
export function sdkValueImports(files: string[] = repoSourceFiles()): Array<{ file: string; site: ImportSite }> {
  const out: Array<{ file: string; site: ImportSite }> = [];
  for (const file of files) {
    if (isTestFile(file)) continue;
    for (const site of importsOf(readFileSync(join(REPO_ROOT, file), "utf8"))) {
      if (isSdkSpecifier(site.specifier) && !site.typeOnly) out.push({ file, site });
    }
  }
  return out;
}

/**
 * Client-constructor expressions an SDK import binds in a file: a default or
 * `Anthropic` named binding is constructed as `new X(`, and a namespace
 * binding as `new NS.Anthropic(` / `new NS.default(`. (`new X.SomeError(` is an
 * error class, not a client, so it isn't one.)
 */
export function clientConstructorNames(site: ImportSite, source: string): string[] {
  const names: string[] = [];
  const nsMatch = new RegExp(`import\\s+\\*\\s+as\\s+([\\w$]+)\\s+from\\s*["']${site.specifier.replace(/[/.]/g, "\\$&")}["']`);
  const ns = stripComments(source).match(nsMatch)?.[1];
  for (const b of site.bindings) {
    if (b === ns) names.push(`${b}.Anthropic`, `${b}.default`);
    else names.push(b);
  }
  return names;
}

/**
 * The argument text of each `new <Name>(...)` for the given constructor
 * expressions (e.g. `Anthropic`, `NS.Anthropic`), by balanced-paren scan.
 */
export function constructorCalls(source: string, names: string[]): string[] {
  const text = stripComments(source);
  const out: string[] = [];
  for (const name of names) {
    const re = new RegExp(`\\bnew\\s+${name.replace(/[$.]/g, "\\$&")}\\s*\\(`, "g");
    for (const m of text.matchAll(re)) {
      let depth = 0;
      let end = m.index + m[0].length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === "(") depth += 1;
        else if (text[end] === ")" && --depth === 0) break;
      }
      out.push(text.slice(m.index, end + 1));
    }
  }
  return out;
}
