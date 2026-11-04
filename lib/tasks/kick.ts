/**
 * `kickWorker()` (docs/ARCHITECTURE.md §13.4.2): a low-latency nudge that
 * POSTs to the production worker tick route so user-facing work starts
 * within seconds instead of waiting for the every-minute pg_cron tick.
 *
 * - Called inside `after()` by every route that enqueues user-facing work,
 *   and once by the worker itself when it should self-chain.
 * - Awaits only the route's immediate `202`, with a 3 s timeout.
 * - Never throws. Failures are logged without PII and the cron tick is the
 *   backstop.
 * - Requires `WORKER_SECRET`. That variable is set on **production only**
 *   (§13.4.2, §13.18), so preview/local deployments never kick, and never
 *   reach the production worker.
 */

export const KICK_TIMEOUT_MS = 3_000;
export const WORKER_TICK_PATH = "/api/worker/tick";

type Env = Record<string, string | undefined>;

/**
 * `${APP_BASE_URL}/api/worker/tick`, falling back to
 * `https://${VERCEL_PROJECT_PRODUCTION_URL}`. Returns null when neither is
 * set or the base isn't a valid http(s) URL.
 */
export function resolveWorkerTickUrl(env: Env = process.env): string | null {
  const explicit = env.APP_BASE_URL?.trim();
  const vercelHost = env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  const base = explicit || (vercelHost ? `https://${vercelHost}` : "");
  if (!base) return null;

  try {
    const url = new URL(base);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.pathname = `${url.pathname.replace(/\/+$/, "")}${WORKER_TICK_PATH}`;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export interface KickOptions {
  env?: Env;
  fetchImpl?: typeof fetch;
}

/** Returns true when the tick route answered 202. */
export async function kickWorker(options: KickOptions = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  const secret = env.WORKER_SECRET?.trim();
  if (!secret) {
    // Expected everywhere except production.
    return false;
  }

  const url = resolveWorkerTickUrl(env);
  if (!url) {
    console.warn("[kickWorker] APP_BASE_URL / VERCEL_PROJECT_PRODUCTION_URL not set; skipping kick.");
    return false;
  }

  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ trigger: "kick" }),
      signal: AbortSignal.timeout(KICK_TIMEOUT_MS),
      cache: "no-store",
    });
    if (res.status !== 202) {
      console.warn(`[kickWorker] tick route answered ${res.status}; the cron tick will pick the work up.`);
      return false;
    }
    return true;
  } catch (err) {
    const name =
      err && typeof err === "object" && "name" in err && typeof err.name === "string"
        ? err.name
        : "Error";
    console.warn(`[kickWorker] kick failed (${name}); the cron tick will pick the work up.`);
    return false;
  }
}
