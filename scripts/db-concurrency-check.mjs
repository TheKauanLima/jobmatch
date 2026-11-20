#!/usr/bin/env node
/**
 * Multi-connection concurrency checks for migration 0007 (M1.3, §13.16).
 * pgTAP runs in a single session, so these properties need real concurrent
 * connections:
 *
 *   1. claim_tasks: concurrent claimers never exceed the class cap
 *      (advisory xact lock + live-lease count), with and without overlapping
 *      transactions.
 *   2. claim_tasks: FOR UPDATE SKIP LOCKED -- a row locked by another
 *      transaction is skipped without blocking.
 *   3. private.consume_rate_limit: N concurrent consumes at limit-1 -> exactly
 *      one succeeds.
 *   4. public.consume_account_reauth_attempt (authenticated user RPC): N
 *      concurrent calls at 9/10 -> exactly one succeeds.
 *
 * LOCAL ONLY. Usage (see supabase/tests/README.md):
 *   npx supabase start
 *   node scripts/db-concurrency-check.mjs            # default local URL
 *   SUPABASE_DB_URL=postgresql://... node scripts/db-concurrency-check.mjs
 *
 * The default URL is the local stack's (`npx supabase status` -> DB URL).
 * The URL is parsed with pg-connection-string (the parser pg itself uses) and
 * the parsed config is what the client connects with, so the guard checks the
 * host pg will actually dial: it must be exactly 127.0.0.1 or localhost (a
 * `?host=` query parameter is rejected outright) and the port must be the
 * local DB port from supabase/config.toml. So it can never be pointed at the
 * live project. It commits fixture rows (that is
 * the point: other connections must see them) under unique kinds and a
 * throwaway auth user, and deletes them in a finally block.
 * Exit code 0 = all checks passed, 1 = a check failed, 2 = setup error.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { parse as parseConnectionString, toClientConfig } from "pg-connection-string";

/** The local DB port from supabase/config.toml's [db] section (54322 if unreadable). */
function localDbPort() {
  try {
    const toml = readFileSync(new URL("../supabase/config.toml", import.meta.url), "utf8");
    const section = toml.split(/^\[db\]\s*$/m)[1]?.split(/^\[/m)[0] ?? "";
    const m = section.match(/^port\s*=\s*(\d+)\s*$/m);
    if (m) return Number(m[1]);
  } catch {
    // fall through to the CLI default
  }
  return 54322;
}

const LOCAL_DB_PORT = localDbPort();
const DB_URL = process.env.SUPABASE_DB_URL ?? `postgresql://postgres:postgres@127.0.0.1:${LOCAL_DB_PORT}/postgres`;

function refuse(reason) {
  console.error(`Refusing to run: ${reason}. This script is for the local Supabase stack only.`);
  process.exit(2);
}

// Validate exactly what pg will use. pg parses connectionString with
// pg-connection-string, where a `?host=` query parameter overrides the URL's
// hostname, and an empty host/port falls back to PGHOST/PGPORT or defaults.
// So: parse once here, validate the parsed host/port, and hand the parsed
// config (not the raw string) to pg.Client.
let url;
let parsed;
try {
  url = new URL(DB_URL); // absolute URLs only (no bare unix-socket paths)
  parsed = parseConnectionString(DB_URL);
} catch {
  refuse("SUPABASE_DB_URL is not a valid postgres:// URL");
}
if (!/^postgres(ql)?:$/i.test(url.protocol)) {
  refuse("only postgres:// or postgresql:// URLs are accepted");
}
if (url.searchParams.has("host") || url.searchParams.has("hostaddr")) {
  refuse("a host/hostaddr query parameter is not allowed");
}
// The authoritative check: the host and port pg-connection-string resolved.
if (!["127.0.0.1", "localhost"].includes(parsed.host ?? "")) {
  refuse(`host "${parsed.host ?? ""}" is not 127.0.0.1 or localhost`);
}
if (String(parsed.port ?? "") !== String(LOCAL_DB_PORT)) {
  refuse(`port "${parsed.port ?? ""}" is not the local DB port ${LOCAL_DB_PORT} (supabase/config.toml)`);
}
const CLIENT_CONFIG = toClientConfig(parsed);

const RUN = randomUUID().slice(0, 8);
const KIND_CAP = `m13cc.cap_${RUN}`;
const KIND_SKIP = `m13cc.skip_${RUN}`;
const USER_ID = randomUUID();
const CAP = 4;
const CLAIMERS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}

async function connect() {
  const c = new pg.Client({ ...CLIENT_CONFIG });
  await c.connect();
  return c;
}

async function withClients(n, fn) {
  const clients = await Promise.all(Array.from({ length: n }, connect));
  try {
    return await fn(clients);
  } finally {
    await Promise.all(clients.map((c) => c.end().catch(() => {})));
  }
}

async function main() {
  const admin = await connect();
  try {
    // Precondition: the cap check is exact only if no other live user-class
    // leases exist (a fresh local stack has none).
    const live = await admin.query(
      "select count(*)::int as n from public.background_tasks where task_class = 'user' and status = 'running' and locked_until > clock_timestamp()",
    );
    if (live.rows[0].n > 0) {
      console.error(`Precondition failed: ${live.rows[0].n} live user-class leases already exist in the local DB.`);
      process.exitCode = 2;
      return;
    }

    // ---- 1a. cap with overlapping transactions --------------------------
    await admin.query(
      `insert into public.background_tasks (kind, task_class, max_attempts, lease_seconds)
       select $1, 'user', 3, 300 from generate_series(1, 20)`,
      [KIND_CAP],
    );

    const claimedOverlapping = await withClients(CLAIMERS, async (clients) => {
      const counts = await Promise.all(
        clients.map(async (c, i) => {
          await c.query("begin");
          const r = await c.query("select id from public.claim_tasks($1, 'user', array[$2], $3, $3)", [
            `cc-overlap-${i}`,
            KIND_CAP,
            CAP,
          ]);
          await sleep(200); // hold the transaction so claimers overlap
          await c.query("commit");
          return r.rowCount;
        }),
      );
      return counts;
    });
    const liveAfter1 = await admin.query(
      "select count(*)::int as n from public.background_tasks where kind = $1 and status = 'running' and locked_until > clock_timestamp()",
      [KIND_CAP],
    );
    const sum1 = claimedOverlapping.reduce((a, b) => a + b, 0);
    check(
      `${CLAIMERS} concurrent claimers (overlapping transactions) never exceed the cap of ${CAP}`,
      sum1 === CAP && liveAfter1.rows[0].n === CAP,
      `claimed per connection ${JSON.stringify(claimedOverlapping)}, live leases ${liveAfter1.rows[0].n}`,
    );

    // ---- 1b. cap with autocommit bursts, after freeing the slots ---------
    await admin.query(
      "update public.background_tasks set status = 'succeeded', locked_until = null, finished_at = now() where kind = $1 and status = 'running'",
      [KIND_CAP],
    );
    const claimedBurst = await withClients(CLAIMERS, (clients) =>
      Promise.all(
        clients.map((c, i) =>
          c
            .query("select id from public.claim_tasks($1, 'user', array[$2], $3, 2)", [`cc-burst-${i}`, KIND_CAP, CAP])
            .then((r) => r.rowCount),
        ),
      ),
    );
    const liveAfter2 = await admin.query(
      "select count(*)::int as n from public.background_tasks where kind = $1 and status = 'running' and locked_until > clock_timestamp()",
      [KIND_CAP],
    );
    const sum2 = claimedBurst.reduce((a, b) => a + b, 0);
    check(
      `${CLAIMERS} concurrent autocommit claimers (limit 2 each) never exceed the cap of ${CAP}`,
      sum2 === CAP && liveAfter2.rows[0].n === CAP,
      `claimed per connection ${JSON.stringify(claimedBurst)}, live leases ${liveAfter2.rows[0].n}`,
    );

    // ---- 2. skip locked ---------------------------------------------------
    const skipIds = await admin.query(
      `insert into public.background_tasks (kind, task_class, max_attempts, lease_seconds, priority)
       values ($1, 'background', 3, 300, 10), ($1, 'background', 3, 300, 0) returning id, priority`,
      [KIND_SKIP],
    );
    const locked = skipIds.rows.find((r) => r.priority === 10).id;
    const free = skipIds.rows.find((r) => r.priority === 0).id;
    await withClients(2, async ([holder, claimer]) => {
      await holder.query("begin");
      await holder.query("select id from public.background_tasks where id = $1 for update", [locked]);
      await claimer.query("set statement_timeout = '5s'");
      let got = null;
      let error = null;
      try {
        const r = await claimer.query("select id from public.claim_tasks('cc-skip', 'background', array[$1], 10, 10)", [KIND_SKIP]);
        got = r.rows.map((x) => x.id);
      } catch (e) {
        error = e.message;
      }
      await holder.query("rollback");
      check(
        "claim_tasks skips a row locked by another transaction without blocking (SKIP LOCKED)",
        error === null && got.length === 1 && got[0] === free,
        error ? `error: ${error}` : `claimed ${JSON.stringify(got)}; locked ${locked}`,
      );
    });

    // ---- 3. consume_rate_limit at limit - 1 ------------------------------
    await admin.query("insert into auth.users (id, email) values ($1, $2)", [USER_ID, `m13cc-${RUN}@example.test`]);
    await admin.query(
      "insert into public.rate_limit_events (user_id, kind) select $1, 'resume_report' from generate_series(1, 4)",
      [USER_ID],
    );

    // 3a: two connections, deterministic overlap: A consumes inside an open
    // transaction (holding the advisory lock), B starts, then A commits.
    const pair = await withClients(2, async ([a, b]) => {
      await a.query("begin");
      const ra = await a.query("select private.consume_rate_limit($1, 'resume_report') as ok", [USER_ID]);
      await b.query("set statement_timeout = '10s'");
      const pb = b.query("select private.consume_rate_limit($1, 'resume_report') as ok", [USER_ID]);
      await sleep(300); // B is now waiting on the advisory lock
      await a.query("commit");
      const rb = await pb;
      return [ra.rows[0].ok, rb.rows[0].ok];
    });
    const used3 = await admin.query(
      "select count(*)::int as n from public.rate_limit_events where user_id = $1 and kind = 'resume_report'",
      [USER_ID],
    );
    check(
      "two concurrent consumes at limit-1 (resume_report 4/5): exactly one succeeds",
      pair.filter(Boolean).length === 1 && used3.rows[0].n === 5,
      `results ${JSON.stringify(pair)}, events ${used3.rows[0].n}`,
    );

    // 3b: a burst of 10 autocommit consumes at limit-1 on another kind.
    await admin.query(
      "insert into public.rate_limit_events (user_id, kind) select $1, 'refresh_matches' from generate_series(1, 4)",
      [USER_ID],
    );
    const burst = await withClients(10, (clients) =>
      Promise.all(
        clients.map((c) =>
          c.query("select private.consume_rate_limit($1, 'refresh_matches') as ok", [USER_ID]).then((r) => r.rows[0].ok),
        ),
      ),
    );
    const used3b = await admin.query(
      "select count(*)::int as n from public.rate_limit_events where user_id = $1 and kind = 'refresh_matches'",
      [USER_ID],
    );
    check(
      "10 concurrent consumes at limit-1 (refresh_matches 4/5): exactly one succeeds",
      burst.filter(Boolean).length === 1 && used3b.rows[0].n === 5,
      `successes ${burst.filter(Boolean).length}, events ${used3b.rows[0].n}`,
    );

    // ---- 4. consume_account_reauth_attempt as the authenticated user ----
    await admin.query(
      "insert into public.rate_limit_events (user_id, kind) select $1, 'account_reauth' from generate_series(1, 9)",
      [USER_ID],
    );
    const claims = JSON.stringify({ sub: USER_ID, role: "authenticated" });
    const reauth = await withClients(10, (clients) =>
      Promise.all(
        clients.map(async (c) => {
          await c.query("begin");
          await c.query("set local role authenticated");
          await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [
            claims,
            USER_ID,
          ]);
          const r = await c.query("select public.consume_account_reauth_attempt() as ok");
          await c.query("commit");
          return r.rows[0].ok;
        }),
      ),
    );
    const used4 = await admin.query(
      "select count(*)::int as n from public.rate_limit_events where user_id = $1 and kind = 'account_reauth'",
      [USER_ID],
    );
    check(
      "10 concurrent consume_account_reauth_attempt() calls at 9/10: exactly one succeeds",
      reauth.filter(Boolean).length === 1 && used4.rows[0].n === 10,
      `successes ${reauth.filter(Boolean).length}, events ${used4.rows[0].n}`,
    );
  } finally {
    await admin.query("delete from public.background_tasks where kind in ($1, $2)", [KIND_CAP, KIND_SKIP]).catch((e) => {
      console.error("cleanup (tasks) failed:", e.message);
    });
    // Cascades the user's rate_limit_events.
    await admin.query("delete from auth.users where id = $1", [USER_ID]).catch((e) => {
      console.error("cleanup (user) failed:", e.message);
    });
    await admin.end();
  }

  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} concurrency checks passed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Setup error:", err.message);
  process.exitCode = 2;
});
