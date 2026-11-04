# Kalify

AI job-finder web app for students. A student uploads a resume and gets a detailed critique, a comparison against real job-market demand, the roles they're best qualified for with matching open jobs, and fit checks against their own custom listings. v2 design: `docs/ARCHITECTURE.md` §13; work sequencing: `docs/ROADMAP.md`.

## Privacy model
- Resumes, and everything derived from them (structured profiles, critiques,
  embeddings, reports, match results), are private to the submitting user — never
  visible to other users, never used to train/improve matching for anyone else, and
  never included in aggregate statistics.
- Job listings are either **shared** or **private**. Listings ingested from external
  sources are always shared. A user-submitted listing is shared (stored centrally,
  visible to and matchable by all signed-in users) or private (visible and matchable
  only by its submitter, never shown to others, never used in market statistics,
  deleted with the account) — the user chooses explicitly. Private → shared is
  allowed; shared → private is not.
- Market statistics are computed only from shared, externally ingested listings.
- Resume-derived data is sent only to Anthropic (Claude API); the embeddings provider
  receives a profile summary with contact details removed.

## Stack
- **Framework:** Next.js (TypeScript), App Router
- **Data/Auth/Storage:** Supabase (Postgres, Auth, private Storage bucket for resumes, Row-Level Security enforcing per-user resume access)
- **AI:** Claude API (Anthropic) — `claude-opus-5-5` by default, configured per task
  in `lib/claude/config.ts`; structured outputs for every call; Message Batches for
  bulk job-requirement extraction. **Embeddings:** provider pending user decision
  (§13.19 Q1), stored in Supabase `pgvector` for first-stage candidate retrieval;
  Claude re-ranks and explains the top candidates.
- **Background work:** Postgres task queue (`background_tasks`) drained by a Vercel
  worker route, triggered by `pg_cron` + `pg_net` and by on-demand kicks.
- **Deployment:** Vercel

## Design direction
Simple, professional. Prioritize clarity and trust (this handles people's resumes and job search) over visual flourish.

## Dev team & workflow
This project is built by a team of Claude Code subagents, each defined in `.claude/agents/`:
- **architect** — system structure, data model, API contracts, folder layout
- **frontend-dev** — Next.js UI
- **backend-dev** — API routes, Supabase schema/queries, Claude API integration
- **qa-tester** — writes and runs tests, hunts for bugs
- **reviewer** — checks every non-trivial change against `docs/ARCHITECTURE.md` and this file before it's considered done

The **orchestrator** role (setting milestones, sequencing work across the above) is played by the main Claude Code session directly, not a subagent — it delegates to the others via the Agent tool.

Architecture decisions and the data model live in `docs/ARCHITECTURE.md` (written by the architect agent) — read it before making structural changes.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
