# JobMatch

AI job-finder web app. A user submits a resume; the app extracts strengths/weaknesses, and matches it against stored job descriptions. Users can also submit job descriptions for matching.

## Privacy model
- Resumes are private to the submitting user (never visible to other users, never used to train/improve matching for anyone else).
- Job descriptions are shared data — stored centrally and usable for matching across all users.

## Stack
- **Framework:** Next.js (TypeScript), App Router
- **Data/Auth/Storage:** Supabase (Postgres, Auth, private Storage bucket for resumes, Row-Level Security enforcing per-user resume access)
- **AI:** Claude API (Anthropic) — resume strengths/weaknesses extraction and resume-to-job match assessment, called directly (no embeddings layer for v1)
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
