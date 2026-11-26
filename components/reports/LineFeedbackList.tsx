"use client";

import { useId, useState } from "react";
import { LineFeedbackItem } from "@/components/reports/LineFeedbackItem";
import { groupLineFeedback, LINE_FEEDBACK_INITIAL_COUNT } from "@/lib/client/critique";
import type { LineFeedback } from "@/types/domain";

interface LineFeedbackListProps {
  items: LineFeedback[];
}

/**
 * Line-by-line feedback grouped by section (§13.20.6 content item 4). The
 * first `LINE_FEEDBACK_INITIAL_COUNT` items (most impactful first) show,
 * then a "Show all N" toggle. Client component only for that toggle.
 */
export function LineFeedbackList({ items }: LineFeedbackListProps) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();

  if (items.length === 0) {
    return (
      <p className="text-sm text-fg-subtle">
        No line-level changes suggested. Your bullets already read well.
      </p>
    );
  }

  const hasMore = items.length > LINE_FEEDBACK_INITIAL_COUNT;
  const visible = expanded || !hasMore ? items : items.slice(0, LINE_FEEDBACK_INITIAL_COUNT);
  const groups = groupLineFeedback(visible);

  return (
    <div className="flex flex-col gap-6">
      <div id={listId} className="flex flex-col gap-6">
        {groups.map((group) => (
          <div key={group.section}>
            <h4 className="text-sm font-semibold text-fg">
              {group.label}{" "}
              <span className="font-normal text-fg-subtle">({group.items.length})</span>
            </h4>
            <ul className="mt-2 flex flex-col gap-3">
              {group.items.map((item) => (
                <LineFeedbackItem key={item.id} item={item} />
              ))}
            </ul>
          </div>
        ))}
      </div>
      {hasMore && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex min-h-11 items-center self-start rounded-md text-sm font-medium sm:min-h-0 text-fg underline underline-offset-4 hover:text-fg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {expanded ? "Show fewer" : `Show all ${items.length} suggestions`}
        </button>
      )}
    </div>
  );
}
