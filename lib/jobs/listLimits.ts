/**
 * Query-param bounds for `GET /api/job-descriptions` (docs/ARCHITECTURE.md
 * §2/§9.1/§9.3/§7.8.6). Used by `jobDescriptionListQuerySchema` in
 * `lib/validation/schemas.ts` and by `listJobDescriptions` /
 * `searchJobDescriptions` in `lib/supabase/queries/jobDescriptions.ts`
 * (which re-exports them for existing callers).
 *
 * NO IMPORTS: `lib/validation/schemas.ts` is imported by client components,
 * so anything it imports lands in the client bundle. These constants used to
 * live in the query module, which pulled it into the client bundle (§7.8.8
 * follow-up). `lib/jobs/listLimits.test.ts` enforces this.
 *
 * `JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH` must stay equal to
 * `JOBS_SEARCH_MAX_LENGTH` in `lib/client/jobsBoard.ts` (sync test there).
 */

/** Default/maximum page size for the job-description list, per §2. */
export const JOB_DESCRIPTIONS_DEFAULT_LIMIT = 20;
export const JOB_DESCRIPTIONS_MAX_LIMIT = 100;

/**
 * Maximum length (characters) accepted for `?q=` on
 * `GET /api/job-descriptions`, per §9.1/§9.3. A query-param bound, not a
 * POST-body field, so it lives here rather than among the
 * `JOB_DESCRIPTION_*_MAX_LENGTH` constants in `lib/validation/schemas.ts`.
 */
export const JOB_DESCRIPTION_SEARCH_QUERY_MAX_LENGTH = 200;
