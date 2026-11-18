import { dimensionLabel } from "@/lib/client/critique";
import type { CritiquePriority } from "@/types/domain";

interface CritiquePrioritiesProps {
  priorities: CritiquePriority[];
}

/**
 * "Top 3 priorities" (§13.20.6 content item 2): the `top_fix` of the three
 * lowest-scoring dimensions, numbered, lowest score first (derived by
 * `deriveCritiquePriorities`). Presentational; reused by M3.6.
 */
export function CritiquePriorities({ priorities }: CritiquePrioritiesProps) {
  if (priorities.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3">
      {priorities.map((priority, index) => (
        <li
          key={priority.dimension}
          className="flex gap-3 rounded-lg border border-border bg-bg p-3 sm:p-4"
        >
          <span
            aria-hidden="true"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-fg"
          >
            {index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-relaxed text-fg">
              <span className="sr-only">Priority {index + 1}: </span>
              {priority.top_fix}
            </p>
            <p className="mt-1 text-xs text-fg-subtle">
              {dimensionLabel(priority.dimension)} · {priority.score}/100
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
