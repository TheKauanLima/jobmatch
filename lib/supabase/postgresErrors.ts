/**
 * Shared helper for recognizing Postgres error code `22P02` ("invalid text
 * representation" — e.g. a malformed uuid string passed as a filter value)
 * across every `lib/supabase/queries/*` module that looks up a single row
 * by its `:id` path/query param (`getResumeById`, `getJobDescriptionById`,
 * `getMatchById`).
 *
 * Every primary key in this schema is `uuid default gen_random_uuid()`
 * (docs/ARCHITECTURE.md §1), so a malformed id string (e.g. the literal
 * `not-a-real-id` from a hand-edited URL) can never match a real row —
 * Postgres rejects it at the type-cast stage before the query's `WHERE`
 * clause even runs, and PostgREST surfaces that as a generic-looking
 * `PostgrestError` rather than "no rows found". Left unhandled, that error
 * propagates as a table-specific `*QueryError`, which route handlers treat
 * as a real DB failure — a misleading `500` with "please try again" copy,
 * since retrying a malformed id can never succeed. Special-casing this
 * error code lets `getResumeById`/`getJobDescriptionById`/`getMatchById`
 * return `null` instead (same as "no such row"), so it collapses into the
 * same clean `404` a well-formed-but-nonexistent id already produces.
 *
 * Deliberately keyed off the stable Postgres error code, not
 * `error.message` text — see `PostgrestError`'s own docstring
 * (`@supabase/postgrest-js`): "Branch on this rather than on `message`
 * text."
 */
const POSTGRES_INVALID_TEXT_REPRESENTATION = "22P02";

export function isInvalidInputSyntaxError(
  error: { code?: string | null } | null | undefined,
): boolean {
  return error?.code === POSTGRES_INVALID_TEXT_REPRESENTATION;
}
