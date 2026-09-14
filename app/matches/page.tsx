import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import { serverFetch } from "@/lib/api/serverFetch";
import { MatchHistoryList } from "@/components/matches/MatchHistoryList";
import type { RecentMatch } from "@/types/domain";

/**
 * Page-sized default for the initial SSR fetch — deliberately not the
 * dashboard's `RECENT_MATCHES_DEFAULT_LIMIT` (5), per docs/ARCHITECTURE.md
 * §11.2: "this route calls the endpoint with its own explicit `limit`, it
 * does not rely on the endpoint's default."
 */
const MATCH_HISTORY_PAGE_LIMIT = 20;

async function getMatchHistory(): Promise<{
  matches: RecentMatch[];
  nextCursor: string | null;
  error: string | null;
}> {
  try {
    const response = await serverFetch(
      `/api/matches?limit=${MATCH_HISTORY_PAGE_LIMIT}`,
    );

    if (!response.ok) {
      return {
        matches: [],
        nextCursor: null,
        error: "Couldn't load your match history. Please try refreshing the page.",
      };
    }

    const body = await response.json();
    return {
      matches: body.matches ?? [],
      nextCursor: body.next_cursor ?? null,
      error: null,
    };
  } catch {
    return {
      matches: [],
      nextCursor: null,
      error: "Couldn't load your match history. Please try refreshing the page.",
    };
  }
}

/**
 * Standalone match history page — every match the caller has run, across all
 * their resumes, most-recent-first, per docs/ARCHITECTURE.md §11. Same
 * auth-gating pattern as `/resumes`/`/jobs` (no session -> redirect to
 * `/login`). There is deliberately no `/matches/:id` detail route (§11.3).
 */
export default async function MatchesPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { matches, nextCursor, error } = await getMatchHistory();

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight text-fg">
        Match history
      </h1>
      <p className="mt-2 text-sm text-fg-muted">
        Every match you&apos;ve run, across all your resumes, most recent
        first.
      </p>

      <div className="mt-8">
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger-border bg-danger-bg px-3 py-2 text-sm text-danger-fg"
          >
            {error}
          </p>
        ) : (
          <MatchHistoryList
            initialMatches={matches}
            initialNextCursor={nextCursor}
          />
        )}
      </div>
    </div>
  );
}
