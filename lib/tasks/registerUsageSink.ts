import { setUsageSink } from "@/lib/claude/usage";
import { recordAiUsageEvent } from "@/lib/tasks/usageSink";

/**
 * Side-effect module: registers the `ai_usage_events` writer as the Claude
 * layer's process-wide usage sink (docs/ARCHITECTURE.md §13.3.1, §13.5.2
 * step 3, §13.9.4; ROADMAP M1.2 step 4).
 *
 * Import it (`import "@/lib/tasks/registerUsageSink";`) from every server
 * entry point that can call Claude:
 *   - app/api/worker/tick/route.ts      (all v2 Claude calls run in the worker)
 *   - app/api/resumes/[id]/analyze/route.ts   (v1, until M3.9)
 *   - app/api/matches/route.ts                (v1, until M3.9)
 * A new entry point that calls Claude must add the same import, or its
 * spend silently escapes the global budget.
 *
 * Safe to import anywhere on the server:
 * - No I/O at import time; the service-role client is created on the first
 *   recorded event.
 * - Idempotent: `setUsageSink` stores the sink on `globalThis` under
 *   `Symbol.for("kalify.claude.usageSink")`, so importing this from several
 *   bundles/chunks registers the same function process-wide.
 * - Can't fail a user request: `recordUsage()` catches sink errors, and the
 *   sink itself never throws and gives up waiting after
 *   `USAGE_SINK_TIMEOUT_MS`.
 */
setUsageSink(recordAiUsageEvent);

export const USAGE_SINK_REGISTERED = true;
