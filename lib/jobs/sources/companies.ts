/**
 * The curated list of company job boards the daily sync polls
 * (docs/ARCHITECTURE.md §7.7.2). A reviewed code constant rather than a DB
 * table on purpose: adding or removing a company goes through code review,
 * and M1.5 later seeds `job_source_boards` from this file.
 *
 * Rules (enforced by companies.test.ts):
 * - `token` matches `^[a-z0-9][a-z0-9-]*$` (it is interpolated into the
 *   provider URL and into a `LIKE '${token}:%'` filter, §7.7.6);
 * - `(provider, token)` is unique;
 * - `displayName` is non-empty, and is the *only* source of the company name
 *   (Lever has none; Greenhouse's `company_name` isn't reliable);
 * - at most `MAX_COMPANIES_PER_RUN` entries (runtime budget, §7.7.5).
 *
 * Every token below was checked live on 2026-11-20 (HTTP 200 with at least
 * one job). A token that later starts failing is skipped and reported in the
 * daily run result (a 207 from the cron route) until it is removed here.
 * Tokens that fail the check are left out, not added commented-out.
 */

export type JobBoardProvider = "greenhouse" | "lever";

export type JobBoardCompany = {
  provider: JobBoardProvider;
  token: string;
  displayName: string;
};

/** Upper bound on `JOB_BOARD_COMPANIES.length` (§7.7.5). */
export const MAX_COMPANIES_PER_RUN = 40;

export const JOB_BOARD_COMPANIES: readonly JobBoardCompany[] = [
  // Greenhouse
  { provider: "greenhouse", token: "affirm", displayName: "Affirm" },
  { provider: "greenhouse", token: "airbnb", displayName: "Airbnb" },
  { provider: "greenhouse", token: "asana", displayName: "Asana" },
  { provider: "greenhouse", token: "brex", displayName: "Brex" },
  { provider: "greenhouse", token: "cloudflare", displayName: "Cloudflare" },
  { provider: "greenhouse", token: "coinbase", displayName: "Coinbase" },
  { provider: "greenhouse", token: "databricks", displayName: "Databricks" },
  { provider: "greenhouse", token: "datadog", displayName: "Datadog" },
  { provider: "greenhouse", token: "discord", displayName: "Discord" },
  { provider: "greenhouse", token: "dropbox", displayName: "Dropbox" },
  { provider: "greenhouse", token: "duolingo", displayName: "Duolingo" },
  { provider: "greenhouse", token: "figma", displayName: "Figma" },
  { provider: "greenhouse", token: "gitlab", displayName: "GitLab" },
  { provider: "greenhouse", token: "instacart", displayName: "Instacart" },
  { provider: "greenhouse", token: "lyft", displayName: "Lyft" },
  { provider: "greenhouse", token: "mongodb", displayName: "MongoDB" },
  { provider: "greenhouse", token: "pinterest", displayName: "Pinterest" },
  { provider: "greenhouse", token: "reddit", displayName: "Reddit" },
  { provider: "greenhouse", token: "robinhood", displayName: "Robinhood" },
  { provider: "greenhouse", token: "roblox", displayName: "Roblox" },
  { provider: "greenhouse", token: "samsara", displayName: "Samsara" },
  { provider: "greenhouse", token: "scaleai", displayName: "Scale AI" },
  { provider: "greenhouse", token: "squarespace", displayName: "Squarespace" },
  { provider: "greenhouse", token: "stripe", displayName: "Stripe" },
  { provider: "greenhouse", token: "twitch", displayName: "Twitch" },
  // Lever
  { provider: "lever", token: "palantir", displayName: "Palantir" },
  { provider: "lever", token: "spotify", displayName: "Spotify" },
  { provider: "lever", token: "zoox", displayName: "Zoox" },
];
