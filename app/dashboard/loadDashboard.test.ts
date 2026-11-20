import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDashboard, type DashboardQueries } from "@/app/dashboard/loadDashboard";
import { TOP_MATCHES_SCAN_LIMIT } from "@/lib/client/dashboard";

/**
 * app/dashboard/loadDashboard.ts: wires the existing session-client queries
 * into the dashboard model, scoped to the session user, with each section
 * failing independently. Synthetic data only.
 */

const SESSION = { tag: "session-client" } as never;
const USER = "user-1";

function resumeRow(id: string, created_at: string) {
  return {
    id,
    user_id: USER,
    storage_path: `${USER}/${id}.pdf`,
    file_name: `${id}.pdf`,
    file_type: "application/pdf",
    file_size_bytes: 1000,
    extracted_text: "private resume text",
    status: "uploaded",
    created_at,
    updated_at: created_at,
  };
}

function matchRow(id: string, score: number, created_at: string) {
  return {
    id,
    user_id: USER,
    resume_id: "r1",
    job_description_id: `job-${id}`,
    score,
    rationale: "r",
    matched_strengths: [],
    gaps: [],
    model: "m",
    created_at,
    job_description: { id: `job-${id}`, title: `Role ${id}`, company: null, deleted_at: null },
    resume: { id: "r1", file_name: "r1.pdf" },
  };
}

function fakes(overrides: Partial<Record<keyof DashboardQueries, unknown>> = {}) {
  const queries = {
    listResumesForUser: vi.fn(async () => [
      resumeRow("r2", "2026-11-12T00:00:00Z"),
      resumeRow("r1", "2026-11-01T00:00:00Z"),
    ]),
    listLatestCritiqueSummaries: vi.fn(async () => [
      {
        id: "c1",
        resume_id: "r1",
        overall_score: 71,
        prompt_version: "critique-v1",
        created_at: "2026-11-02T00:00:00Z",
        dimension_scores: [{ dimension: "impact", score: 58, rationale: "r", top_fix: "Add numbers." }],
      },
    ]),
    listRecentMatchesForUser: vi.fn(async () => ({
      items: [
        matchRow("a", 55, "2026-11-05T00:00:00Z"),
        matchRow("b", 91, "2026-11-04T00:00:00Z"),
        matchRow("c", 70, "2026-11-03T00:00:00Z"),
        matchRow("d", 30, "2026-11-02T00:00:00Z"),
      ],
      hasMore: false,
    })),
    getMyRateLimits: vi.fn(async () => [
      { kind: "resume_report", daily_limit: 5, used_today: 1, resets_at: "2026-11-19T00:00:00.000Z" },
    ]),
    ...overrides,
  };
  return queries as unknown as DashboardQueries & typeof queries;
}

describe("loadDashboard", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("loads every section through the session client, scoped to the session user", async () => {
    const queries = fakes();
    const data = await loadDashboard(SESSION, USER, queries);

    expect(queries.listResumesForUser).toHaveBeenCalledWith(SESSION, USER);
    expect(queries.listLatestCritiqueSummaries).toHaveBeenCalledWith(SESSION, USER, ["r2", "r1"]);
    expect(queries.listRecentMatchesForUser).toHaveBeenCalledWith(SESSION, USER, {
      limit: TOP_MATCHES_SCAN_LIMIT,
    });
    expect(queries.getMyRateLimits).toHaveBeenCalledWith(SESSION);

    expect(data.resumes).toEqual({
      status: "ok",
      data: {
        critiquesFailed: false,
        items: [
          { id: "r2", file_name: "r2.pdf", file_type: "application/pdf", created_at: "2026-11-12T00:00:00Z", critique: null },
          {
            id: "r1",
            file_name: "r1.pdf",
            file_type: "application/pdf",
            created_at: "2026-11-01T00:00:00Z",
            critique: {
              id: "c1",
              overall_score: 71,
              created_at: "2026-11-02T00:00:00Z",
              top_priority: { dimension: "impact", score: 58, top_fix: "Add numbers." },
            },
          },
        ],
      },
    });
    expect(data.matches.status === "ok" && data.matches.data.map((m) => m.id)).toEqual(["b", "c", "a"]);
    expect(data.quota).toEqual({
      status: "ok",
      data: { limit: 5, used: 1, remaining: 4, resetsAt: "2026-11-19T00:00:00.000Z" },
    });
  });

  it("never passes resume text or storage paths into the model", async () => {
    const data = await loadDashboard(SESSION, USER, fakes());
    const json = JSON.stringify(data);
    expect(json).not.toContain("private resume text");
    expect(json).not.toContain("storage_path");
    expect(json).not.toContain(USER);
  });

  it("a resume failure marks only that section, and skips the critique query", async () => {
    const queries = fakes({ listResumesForUser: vi.fn(async () => Promise.reject(new Error("boom"))) });
    const data = await loadDashboard(SESSION, USER, queries);
    expect(data.resumes).toEqual({ status: "error" });
    expect(data.matches.status).toBe("ok");
    expect(data.quota.status).toBe("ok");
    expect(queries.listLatestCritiqueSummaries).not.toHaveBeenCalled();
  });

  it("a critique failure keeps the resumes and flags critiquesFailed", async () => {
    const data = await loadDashboard(
      SESSION,
      USER,
      fakes({ listLatestCritiqueSummaries: vi.fn(async () => Promise.reject(new Error("x"))) }),
    );
    expect(data.resumes.status === "ok" && data.resumes.data.critiquesFailed).toBe(true);
    expect(data.resumes.status === "ok" && data.resumes.data.items.every((r) => r.critique === null)).toBe(true);
  });

  it("matches and limits fail independently, logging only the error class", async () => {
    const data = await loadDashboard(
      SESSION,
      USER,
      fakes({
        listRecentMatchesForUser: vi.fn(async () => Promise.reject(new Error("secret detail"))),
        getMyRateLimits: vi.fn(async () => Promise.reject(new TypeError("other secret"))),
      }),
    );
    expect(data.matches).toEqual({ status: "error" });
    expect(data.quota).toEqual({ status: "error" });
    expect(data.resumes.status).toBe("ok");
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain("secret");
    expect(logged).toContain("TypeError");
  });

  it("no resume_report row → quota data null", async () => {
    const data = await loadDashboard(SESSION, USER, fakes({ getMyRateLimits: vi.fn(async () => []) }));
    expect(data.quota).toEqual({ status: "ok", data: null });
  });
});
