/**
 * In-memory stand-in for the slice of Supabase the V1 critique flow touches
 * (docs/ARCHITECTURE.md §13.20.4): `resumes`, `resume_critiques`,
 * `rate_limit_events`, the `request_resume_critique` and `ai_spend_summary`
 * RPCs. Shared by lib/critique/service.test.ts and the critique route test.
 * Import it only from `*.test.ts` files (eslint enforces this for lib/app).
 *
 * Two clients over one store, modeling the database rules that matter:
 * - `session(userId)`: RLS on all three tables (rows of `userId` only), and
 *   no insert on `resume_critiques` (users have only a select policy). The
 *   RPC charges `userId` only, enforces resume ownership (`not_found`) and
 *   the `resume_report` daily limit (5), and returns the critique id that
 *   becomes the ledger `ref_id`, like 0010.
 * - `admin()`: no RLS. Its `resume_critiques` insert enforces the partial
 *   unique index `resume_critiques_standalone_key` (23505) and the
 *   same-owner trigger (`validation_owner_mismatch`).
 *
 * Only the query-builder calls the critique code uses are implemented:
 * select/insert/update, eq/is filters, order/limit, single/maybeSingle, and
 * awaiting the builder. Failure injection: `failNext(key, error)` makes the
 * next operation with that key return `error`; keys are
 * `"<session|admin>:<table>:<select|insert|update>"` or `"<session|admin>:rpc:<name>"`.
 *
 * Test-only; all data is synthetic.
 */

type Row = Record<string, unknown>;
type PgError = { code?: string; message: string; details?: string | null };
type Result = { data: unknown; error: PgError | null };

export const FAKE_RESUME_REPORT_LIMIT = 5;

export type FakeCritiqueDb = ReturnType<typeof createFakeCritiqueDb>;

export function createFakeCritiqueDb(
  options: { spendUsd?: number; newId?: () => string } = {},
) {
  let counter = 0;
  const newId =
    options.newId ??
    (() => {
      counter += 1;
      return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
    });

  const tables: Record<string, Row[]> = {
    resumes: [],
    resume_critiques: [],
    rate_limit_events: [],
  };
  const injected = new Map<string, PgError>();
  const calls: Array<{ key: string; args?: unknown }> = [];
  let spendUsd = options.spendUsd ?? 0;

  function takeInjected(key: string): PgError | null {
    const err = injected.get(key) ?? null;
    if (err) injected.delete(key);
    return err;
  }

  function rls(role: "session" | "admin", userId: string | null, table: string, row: Row): boolean {
    if (role === "admin") return true;
    return row.user_id === userId && table in tables;
  }

  function insertCritique(role: "session" | "admin", row: Row): Result {
    if (role === "session") {
      return { data: null, error: { code: "42501", message: "permission denied for table resume_critiques" } };
    }
    const resume = tables.resumes.find((r) => r.id === row.resume_id);
    if (!resume || resume.user_id !== row.user_id) {
      return { data: null, error: { code: "P0001", message: "validation_owner_mismatch" } };
    }
    const full: Row = {
      id: row.id ?? newId(),
      report_id: null,
      profile_id: null,
      line_feedback: [],
      section_feedback: [],
      ats_issues: [],
      missing_sections: [],
      dropped_items: 0,
      created_at: new Date(Date.now() + tables.resume_critiques.length).toISOString(),
      ...row,
    };
    if (tables.resume_critiques.some((r) => r.id === full.id)) {
      return { data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "resume_critiques_pkey"' } };
    }
    if (
      full.report_id === null &&
      tables.resume_critiques.some(
        (r) => r.report_id === null && r.resume_id === full.resume_id && r.prompt_version === full.prompt_version,
      )
    ) {
      return {
        data: null,
        error: {
          code: "23505",
          message: 'duplicate key value violates unique constraint "resume_critiques_standalone_key"',
          details: "Key (resume_id, prompt_version)=(...) already exists.",
        },
      };
    }
    tables.resume_critiques.push(full);
    return { data: [full], error: null };
  }

  function builder(role: "session" | "admin", userId: string | null, table: string) {
    let op: "select" | "insert" | "update" = "select";
    let payload: Row | null = null;
    const filters: Array<(row: Row) => boolean> = [];
    let order: { column: string; ascending: boolean } | null = null;
    let limit: number | null = null;
    let returning = false;

    const execute = (): Result => {
      const key = `${role}:${table}:${op}`;
      calls.push({ key, args: payload ?? undefined });
      const err = takeInjected(key);
      if (err) return { data: null, error: err };
      const store = tables[table];
      if (!store) return { data: null, error: { code: "42P01", message: `relation ${table} does not exist` } };

      if (op === "insert") {
        if (table === "resume_critiques") return insertCritique(role, payload!);
        if (role === "session") return { data: null, error: { code: "42501", message: "permission denied" } };
        const full = { id: newId(), ...payload! };
        store.push(full);
        return { data: [full], error: null };
      }

      let rows = store.filter((r) => rls(role, userId, table, r) && filters.every((f) => f(r)));
      if (op === "update") {
        if (role === "session" && table !== "resumes") {
          return { data: null, error: { code: "42501", message: "permission denied" } };
        }
        for (const r of rows) Object.assign(r, payload);
        rows = rows.map((r) => ({ ...r }));
        return { data: returning ? rows : null, error: null };
      }
      if (order) {
        const { column, ascending } = order;
        rows = [...rows].sort((a, b) =>
          String(a[column]) < String(b[column]) ? (ascending ? -1 : 1) : String(a[column]) > String(b[column]) ? (ascending ? 1 : -1) : 0,
        );
      }
      if (limit !== null) rows = rows.slice(0, limit);
      return { data: rows.map((r) => ({ ...r })), error: null };
    };

    const single = (allowNone: boolean): Result => {
      const result = execute();
      if (result.error) return result;
      const rows = (result.data as Row[] | null) ?? [];
      if (rows.length === 0) {
        return allowNone
          ? { data: null, error: null }
          : { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      if (rows.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
      }
      return { data: rows[0], error: null };
    };

    const api = {
      select() {
        if (op !== "select") returning = true;
        return api;
      },
      insert(row: Row) {
        op = "insert";
        payload = row;
        return api;
      },
      update(patch: Row) {
        op = "update";
        payload = patch;
        return api;
      },
      eq(column: string, value: unknown) {
        filters.push((r) => r[column] === value);
        return api;
      },
      is(column: string, value: null) {
        filters.push((r) => (r[column] ?? null) === value);
        return api;
      },
      order(column: string, opts: { ascending?: boolean } = {}) {
        order = { column, ascending: opts.ascending ?? true };
        return api;
      },
      limit(n: number) {
        limit = n;
        return api;
      },
      single: async () => single(false),
      maybeSingle: async () => single(true),
      then<T>(resolve: (r: Result) => T, reject?: (e: unknown) => T) {
        return Promise.resolve(execute()).then(resolve, reject);
      },
    };
    return api;
  }

  function rpc(role: "session" | "admin", userId: string | null, name: string, args: Record<string, unknown>): Result {
    const key = `${role}:rpc:${name}`;
    calls.push({ key, args });
    const err = takeInjected(key);
    if (err) return { data: null, error: err };

    if (name === "request_resume_critique") {
      if (role !== "session" || !userId) {
        return { data: null, error: { code: "42501", message: "unauthenticated" } };
      }
      const owned = tables.resumes.some((r) => r.id === args.p_resume_id && r.user_id === userId);
      if (!owned) return { data: null, error: { code: "P0001", message: "not_found" } };
      const id = newId();
      const used = tables.rate_limit_events.filter(
        (e) => e.user_id === userId && e.kind === "resume_report" && e.refunded_at == null,
      ).length;
      if (used >= FAKE_RESUME_REPORT_LIMIT) {
        return { data: null, error: { code: "P0001", message: "rate_limited:resume_report" } };
      }
      tables.rate_limit_events.push({
        id: newId(),
        user_id: userId,
        kind: "resume_report",
        ref_id: id,
        refunded_at: null,
        created_at: new Date().toISOString(),
      });
      return { data: id, error: null };
    }
    if (name === "ai_spend_summary") {
      if (role !== "admin") return { data: null, error: { code: "42501", message: "permission denied" } };
      return {
        data: spendUsd > 0 ? [{ provider: "anthropic", operation: "critiqueResume", cost_usd: spendUsd, calls: 1 }] : [],
        error: null,
      };
    }
    return { data: null, error: { code: "PGRST202", message: `function ${name} not found` } };
  }

  function client(role: "session" | "admin", userId: string | null) {
    return {
      from: (table: string) => builder(role, userId, table),
      rpc: (name: string, args: Record<string, unknown> = {}) => {
        const result = rpc(role, userId, name, args);
        // PostgREST builders are thenable and support abortSignal().
        const thenable = {
          abortSignal: () => thenable,
          then<T>(resolve: (r: Result) => T, reject?: (e: unknown) => T) {
            return Promise.resolve(result).then(resolve, reject);
          },
        };
        return thenable;
      },
    };
  }

  return {
    tables,
    calls,
    /** The cookie-bound client of `userId` (RLS applies). Cast at the call site. */
    session: (userId: string) => client("session", userId) as never,
    /** The service-role client (no RLS). Cast at the call site. */
    admin: () => client("admin", null) as never,
    failNext(key: string, error: PgError) {
      injected.set(key, error);
    },
    setSpendUsd(value: number) {
      spendUsd = value;
    },
    addResume(row: { id: string; user_id: string; extracted_text?: string | null } & Row) {
      tables.resumes.push({
        storage_path: `${row.user_id}/${row.id}.pdf`,
        file_name: "resume.pdf",
        file_type: "application/pdf",
        file_size_bytes: 1000,
        status: "uploaded",
        created_at: "2026-11-17T00:00:00.000Z",
        updated_at: "2026-11-17T00:00:00.000Z",
        extracted_text: null,
        ...row,
      });
    },
    /** Calls whose key matches, e.g. `count("session:rpc:request_resume_critique")`. */
    count(key: string): number {
      return calls.filter((c) => c.key === key).length;
    },
    activeCharges(userId: string): number {
      return tables.rate_limit_events.filter(
        (e) => e.user_id === userId && e.kind === "resume_report" && e.refunded_at == null,
      ).length;
    },
  };
}
