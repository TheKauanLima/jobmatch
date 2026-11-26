import Link from "next/link";

import { ScoreRing } from "@/components/dashboard/ScoreRing";
import { ALERT, CARD, HEADER_LINK, SECONDARY_LINK_BUTTON } from "@/components/dashboard/styles";
import { ScoreBandBadge } from "@/components/reports/ScoreBandBadge";
import { formatCritiqueDate } from "@/lib/client/critique";
import { resumeCritiqueHref, type DashboardResumes, type Section } from "@/lib/client/dashboard";

/** How many resumes the dashboard lists before "View all". */
export const DASHBOARD_RESUMES_LIMIT = 5;

const FILE_TYPE_LABELS: Record<string, string> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
};

function fileTypeLabel(mime: string): string {
  return FILE_TYPE_LABELS[mime] ?? (mime.split("/").pop() ?? mime).toUpperCase();
}

interface ResumeOverviewProps {
  resumes: Section<DashboardResumes>;
}

/**
 * "Your resumes": each resume with its latest critique score (ring + band)
 * or a "Get a critique" prompt, linking to the resume page. Only the
 * caller's own resumes ever reach this component (session-scoped queries).
 */
export function ResumeOverview({ resumes }: ResumeOverviewProps) {
  const items = resumes.status === "ok" ? resumes.data.items : [];
  const visible = items.slice(0, DASHBOARD_RESUMES_LIMIT);

  return (
    <section aria-labelledby="dashboard-resumes-heading" className={CARD}>
      <div className="flex items-center justify-between gap-4">
        <h2 id="dashboard-resumes-heading" className="text-base font-semibold text-fg">
          Your resumes
        </h2>
        {items.length > 0 && (
          <Link href="/resumes" className={HEADER_LINK}>
            {items.length > DASHBOARD_RESUMES_LIMIT ? `View all ${items.length}` : "Manage"}
          </Link>
        )}
      </div>

      {resumes.status === "error" ? (
        <p role="alert" className={`mt-4 ${ALERT}`}>
          Couldn&apos;t load your resumes. Please refresh the page.
        </p>
      ) : items.length === 0 ? (
        <div className="mt-4 rounded-lg border border-dashed border-border-strong bg-bg p-6 text-center">
          <p className="text-sm text-fg-muted">No resumes yet.</p>
          <Link href="/resumes" className={`mt-3 ${SECONDARY_LINK_BUTTON}`}>
            Upload a resume
          </Link>
        </div>
      ) : (
        <>
          {resumes.data.critiquesFailed && (
            <p role="alert" className={`mt-4 ${ALERT}`}>
              Couldn&apos;t load your critique scores. Open a resume to see its critique.
            </p>
          )}
          <ul className="mt-4 flex flex-col divide-y divide-border">
            {visible.map((resume) => {
              const uploaded = formatCritiqueDate(resume.created_at);
              const critique = resume.critique;
              return (
                <li
                  key={resume.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
                >
                  <ScoreRing score={critique?.overall_score ?? null} />
                  <div className="min-w-0">
                    <Link
                      href={`/resumes/${encodeURIComponent(resume.id)}`}
                      className="block truncate rounded-sm text-sm font-medium text-fg hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    >
                      {resume.file_name}
                    </Link>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
                      <span>{fileTypeLabel(resume.file_type)}</span>
                      {uploaded && (
                        <>
                          <span aria-hidden="true">&middot;</span>
                          <span className="whitespace-nowrap">
                            Uploaded <time dateTime={resume.created_at}>{uploaded}</time>
                          </span>
                        </>
                      )}
                      {critique && <ScoreBandBadge score={critique.overall_score} />}
                    </p>
                  </div>
                  {!resumes.data.critiquesFailed && (
                    <Link
                      href={resumeCritiqueHref(resume.id)}
                      className={
                        critique
                          ? "col-start-2 inline-flex min-h-11 items-center justify-self-start rounded-sm sm:col-start-auto sm:min-h-0 sm:justify-self-end text-sm font-medium text-fg-muted hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          : `${SECONDARY_LINK_BUTTON} col-start-2 justify-self-start px-3 py-1.5 sm:col-start-auto sm:justify-self-end`
                      }
                    >
                      {critique ? "View critique" : "Get a critique"}
                      <span className="sr-only"> for {resume.file_name}</span>
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
