# JobMatch

An AI job-finder for students. Upload a resume and get an AI-generated
strengths/weaknesses breakdown, then match it against a shared board of job
descriptions — a mix of postings the community submits and internship/entry-level
listings pulled in automatically from [The Muse](https://www.themuse.com) — to see
a fit score, rationale, and gaps for each one.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data model, API
contracts, and the design rationale behind every non-trivial decision (including
§7, the external job-listing pipeline). See [`CLAUDE.md`](CLAUDE.md) for how this
project is built (a team of Claude Code subagents) and its design direction.

## Stack

Next.js (App Router, TypeScript) · Supabase (Postgres, Auth, Storage, RLS) ·
Claude API (resume analysis, job matching) · Tailwind v4 · Vercel.

## Getting started

1. **Install dependencies:**
   ```
   npm install
   ```
2. **Set up environment variables:** copy `.env.local.example` to `.env.local` and
   fill in real values —
   - `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
     `SUPABASE_SERVICE_ROLE_KEY` from your Supabase project's API settings.
   - `ANTHROPIC_API_KEY` from the Anthropic console.
   - `CRON_SECRET` — any long random string (e.g. `openssl rand -hex 32`); only
     needed for the external job-listing sync (see below).
3. **Apply the database schema:** run the SQL files in `supabase/migrations/` (in
   order) against your Supabase project — via the SQL editor in the Supabase
   dashboard, or the Supabase CLI's `db push` if the project is linked. There are
   currently four migrations: initial schema, resume storage, an RLS function-search-
   path security fix, and external job-listing columns.
4. **Run the dev server:**
   ```
   npm run dev
   ```
   Then open [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` — start the Next.js dev server.
- `npm run build` / `npm run start` — production build and serve.
- `npm test` / `npm run test:watch` — run the Vitest suite once / in watch mode.
- `npm run lint` — run ESLint.

## Keeping the job board populated

`GET /api/cron/sync-jobs` pulls the newest Internship/Entry Level listings from
The Muse's public Jobs API and upserts them into the shared job board — see
docs/ARCHITECTURE.md §7 for the full design. In production, `vercel.json` schedules
this once daily via Vercel Cron once `CRON_SECRET` is set as a project env var; no
further setup is needed beyond that. To trigger it by hand (e.g. right after first
deploying, so the board isn't empty on day one, or when developing locally):

```
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-deployment>/api/cron/sync-jobs
```

## Project structure

See [`docs/ARCHITECTURE.md` §3](docs/ARCHITECTURE.md#3-folder--module-structure)
for the full folder-by-folder breakdown and the rules for where new code goes.
