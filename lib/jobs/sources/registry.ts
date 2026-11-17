import { themuseAdapter } from "@/lib/jobs/sources/themuse";
import type { JobSourceAdapter, JobSourceSlug } from "@/lib/jobs/sources/types";

/**
 * Source slug → adapter (docs/ARCHITECTURE.md §13.6.2). A source enabled in
 * `job_sources` without an adapter here is skipped (and logged) by
 * `ingest.sync_source`. M1.6 adds usajobs / greenhouse / lever.
 */
export const SOURCE_ADAPTERS: Readonly<Partial<Record<JobSourceSlug, JobSourceAdapter>>> = {
  themuse: themuseAdapter,
};

export function getSourceAdapter(
  slug: JobSourceSlug,
  adapters: Readonly<Partial<Record<JobSourceSlug, JobSourceAdapter>>> = SOURCE_ADAPTERS,
): JobSourceAdapter | null {
  return Object.prototype.hasOwnProperty.call(adapters, slug) ? (adapters[slug] ?? null) : null;
}

/** Names of `adapter.requiredEnv` entries that are unset or blank. */
export function missingAdapterEnv(
  adapter: JobSourceAdapter,
  env: Record<string, string | undefined> = process.env,
): string[] {
  return adapter.requiredEnv.filter((name) => !env[name]?.trim());
}
