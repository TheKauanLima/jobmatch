/**
 * Hand-authored stand-in for the Supabase-generated database types.
 *
 * Per docs/ARCHITECTURE.md §3 this file is meant to be produced by
 * `supabase gen types typescript` against a live project and regenerated
 * whenever the schema changes. No live Supabase project was available at
 * the time this was written (M2, resumes), so this was written by hand to
 * match `supabase/migrations/0001_init.sql` and
 * `supabase/migrations/0002_resumes_storage.sql` exactly.
 *
 * TODO: replace with `supabase gen types typescript --project-id <id> >
 * types/database.ts` once a live project exists, and diff against this file
 * to make sure nothing drifted.
 *
 * Updated by hand for supabase/migrations/0004_external_job_listings.sql
 * (adds source/external_id/level/location/posted_at to job_descriptions).
 *
 * Updated by hand for supabase/migrations/0005_job_description_search.sql
 * (adds generated column job_descriptions.search_vector and the
 * search_job_descriptions() RPC function).
 *
 * Updated by hand for supabase/migrations/0006_job_description_mutability.sql
 * (adds job_descriptions.deleted_at).
 *
 * Updated by hand for supabase/migrations/0007_background_infra.sql (adds
 * background_tasks, ai_usage_events, rate_limit_events and the task /
 * rate-limit / worker-helper functions) and 0008_worker_schedule.sql (adds
 * nothing to the `public` API surface: its one function lives in the
 * unexposed `private` schema). docs/ARCHITECTURE.md §13.3.0 says this file
 * must be regenerated with `supabase gen types typescript --project-id
 * xpubgotqrsosvpiwlpyh` after each migration; these two were hand-authored
 * only because they were written before being applied (M1.2).
 *
 * Verified 2026-11-09 after applying 0007/0008 to the live project: the
 * generated types were compared against this file entry by entry (same
 * tables, columns, functions and argument optionality; every hand type is
 * assignable to the generated one). The only differences are deliberate
 * narrowings kept here: string-literal unions for status/kind/provider
 * columns, `search_vector` omitted from job_descriptions Insert/Update (a
 * generated column), `fail_task` returning `... | null` (NULL when fenced
 * out, which the generator cannot express), and `Record<string, never>` for
 * no-argument RPCs. Keep narrowing on regeneration.
 *
 * Updated by hand for supabase/migrations/0009_job_ingestion_v2.sql (M1.5),
 * written before it was applied, the same way as 0007/0008: job_descriptions
 * v2 columns, job_sources / job_source_boards / job_source_runs, the listing
 * RPCs, search_job_descriptions v2 (adds `scope`), and the ingest functions.
 * Regenerate and diff once 0009 is applied. Deliberate narrowings added for
 * 0009 (keep them on regeneration): string-literal unions for visibility /
 * closed_reason / remote_type / salary_period / source / sync_mode / run
 * status, `content_hash` omitted from job_descriptions Insert/Update (it is
 * maintained by a trigger and never written by app code, same treatment as
 * `search_vector`), `source_metadata` / `config` typed as JSON objects,
 * `search_job_descriptions.scope` as `'shared' | 'mine'`, and
 * `delete_job_listing` returning `'deleted' | 'soft_deleted'`.
 *
 * Updated by hand for supabase/migrations/0010_resume_critiques.sql (V1,
 * §13.20.2), written before it was applied: resume_critiques and the
 * request_resume_critique RPC. 0010 is applied to the live DB ahead of the
 * parked 0009 (§13.3.0); after it is applied this file is regenerated from
 * the live project (which then has 0010 but not 0009) and the 0009 entries
 * above are re-added by the M1.5 branch when 0009 lands. No new narrowings
 * for 0010: its jsonb columns stay `Json` (shaped by types/domain.ts#toCritique).
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ResumeStatus = "uploaded" | "processing" | "analyzed" | "failed";
/** `job_sources.slug` check constraint (0009). */
export type JobSourceSlug =
  | "themuse"
  | "usajobs"
  | "greenhouse"
  | "lever"
  | "adzuna";
/** `job_descriptions.source` check constraint (0009; 0004 had user/themuse). */
export type JobDescriptionSource = "user" | JobSourceSlug;
/** `job_descriptions.visibility` check constraint (0009). */
export type JobListingVisibility = "shared" | "private";
/** `job_descriptions.closed_reason` check constraint (0009). */
export type JobClosedReason = "expired" | "removed_at_source" | "manual";
/** `job_descriptions.remote_type` check constraint (0009). */
export type JobRemoteType = "onsite" | "hybrid" | "remote";
/** `job_descriptions.salary_period` check constraint (0009). */
export type JobSalaryPeriod = "hour" | "year" | "month";
/** `job_sources.sync_mode` check constraint (0009). */
export type JobSourceSyncMode = "snapshot" | "incremental";
/** `job_source_runs.status` check constraint (0009). */
export type JobSourceRunStatus = "running" | "succeeded" | "partial" | "failed";
/** A jsonb column constrained to `jsonb_typeof(...) = 'object'`. */
export type JsonObject = { [key: string]: Json | undefined };

/** `background_tasks.status` check constraint (0007). */
export type BackgroundTaskStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "dead"
  | "cancelled";
/** `background_tasks.task_class` check constraint (0007). */
export type BackgroundTaskClass = "user" | "background";
/** `ai_usage_events.provider` check constraint (0007). */
export type AiUsageProvider = "anthropic" | "voyage";
/** `rate_limit_events.kind` check constraint (0007). */
export type RateLimitKind =
  | "resume_report"
  | "refresh_matches"
  | "fit_check"
  | "url_import"
  | "job_listing_create"
  | "job_listing_update"
  | "account_reauth";

export interface Database {
  public: {
    Tables: {
      resumes: {
        Row: {
          id: string;
          user_id: string;
          storage_path: string;
          file_name: string;
          file_type: string;
          file_size_bytes: number;
          extracted_text: string | null;
          status: ResumeStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          storage_path: string;
          file_name: string;
          file_type: string;
          file_size_bytes: number;
          extracted_text?: string | null;
          status?: ResumeStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["resumes"]["Insert"]>;
        Relationships: [];
      };
      resume_analyses: {
        Row: {
          id: string;
          resume_id: string;
          user_id: string;
          strengths: Json;
          weaknesses: Json;
          summary: string | null;
          suggested_roles: Json | null;
          model: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          resume_id: string;
          user_id: string;
          strengths?: Json;
          weaknesses?: Json;
          summary?: string | null;
          suggested_roles?: Json | null;
          model: string;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["resume_analyses"]["Insert"]
        >;
        Relationships: [];
      };
      job_descriptions: {
        Row: {
          id: string;
          submitted_by: string | null;
          title: string;
          company: string | null;
          description: string;
          source_url: string | null;
          created_at: string;
          updated_at: string;
          source: JobDescriptionSource;
          external_id: string | null;
          level: string | null;
          location: string | null;
          posted_at: string | null;
          /**
           * Generated (`tsvector`) column added by
           * supabase/migrations/0005_job_description_search.sql — Postgres
           * maintains it from title/company/description/location, so it's
           * never written by application code. Omitted from `Insert`/
           * `Update` below for exactly that reason (a generated column would
           * reject an explicit write anyway). Internal-only: omitted from
           * the client-facing `JobDescription` type in types/domain.ts, same
           * treatment as `external_id`.
           */
          search_vector: string;
          /**
           * Added by supabase/migrations/0006_job_description_mutability.sql.
           * Null = visible/active; non-null = soft-deleted by its submitter.
           * See docs/ARCHITECTURE.md §10.
           */
          deleted_at: string | null;
          // --- 0009 (job ingestion v2, docs/ARCHITECTURE.md §13.3.3) ------
          visibility: JobListingVisibility;
          /** Non-null iff `visibility = 'private'`; on delete cascade. */
          owner_user_id: string | null;
          source_board: string | null;
          apply_url: string | null;
          employment_type: string | null;
          remote_type: JobRemoteType | null;
          /** ISO-3166 alpha-2. */
          location_country: string | null;
          /** `numeric`; PostgREST serializes it as a JSON number. */
          salary_min: number | null;
          salary_max: number | null;
          /** ISO-4217. */
          salary_currency: string | null;
          salary_period: JobSalaryPeriod | null;
          last_seen_at: string | null;
          expires_at: string | null;
          closed_at: string | null;
          closed_reason: JobClosedReason | null;
          /**
           * sha256 hex of title/company/description, maintained by the
           * `job_descriptions_content_hash` trigger. Omitted from `Insert`/
           * `Update`: app code never writes it (a written value is
           * overwritten anyway).
           */
          content_hash: string;
          dedupe_key: string | null;
          duplicate_of: string | null;
          source_metadata: JsonObject;
        };
        Insert: {
          id?: string;
          submitted_by?: string | null;
          title: string;
          company?: string | null;
          description: string;
          source_url?: string | null;
          created_at?: string;
          updated_at?: string;
          source?: JobDescriptionSource;
          external_id?: string | null;
          level?: string | null;
          location?: string | null;
          posted_at?: string | null;
          deleted_at?: string | null;
          visibility?: JobListingVisibility;
          owner_user_id?: string | null;
          source_board?: string | null;
          apply_url?: string | null;
          employment_type?: string | null;
          remote_type?: JobRemoteType | null;
          location_country?: string | null;
          salary_min?: number | null;
          salary_max?: number | null;
          salary_currency?: string | null;
          salary_period?: JobSalaryPeriod | null;
          last_seen_at?: string | null;
          expires_at?: string | null;
          closed_at?: string | null;
          closed_reason?: JobClosedReason | null;
          dedupe_key?: string | null;
          duplicate_of?: string | null;
          source_metadata?: JsonObject;
        };
        Update: Partial<
          Database["public"]["Tables"]["job_descriptions"]["Insert"]
        >;
        Relationships: [];
      };
      matches: {
        Row: {
          id: string;
          resume_id: string;
          job_description_id: string;
          user_id: string;
          score: number;
          rationale: string;
          matched_strengths: Json | null;
          gaps: Json | null;
          model: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          resume_id: string;
          job_description_id: string;
          user_id: string;
          score: number;
          rationale: string;
          matched_strengths?: Json | null;
          gaps?: Json | null;
          model: string;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["matches"]["Insert"]>;
        Relationships: [];
      };
      /**
       * Server-only task queue (0007, docs/ARCHITECTURE.md §13.3.1). RLS on,
       * no policies: only service_role can read or write it. `payload` holds
       * ids/small enums only, never resume/job text or PII.
       */
      background_tasks: {
        Row: {
          id: string;
          kind: string;
          status: BackgroundTaskStatus;
          priority: number;
          task_class: BackgroundTaskClass;
          user_id: string | null;
          correlation_id: string | null;
          parent_task_id: string | null;
          payload: Json;
          dedupe_key: string | null;
          attempts: number;
          max_attempts: number;
          run_after: string;
          lease_seconds: number;
          locked_by: string | null;
          locked_until: string | null;
          started_at: string | null;
          finished_at: string | null;
          last_error_code: string | null;
          last_error_message: string | null;
          result: Json | null;
          /** Dead-task hook outbox (§13.4.5). */
          on_dead_handled_at: string | null;
          on_dead_attempts: number;
          on_dead_locked_by: string | null;
          on_dead_locked_until: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          kind: string;
          status?: BackgroundTaskStatus;
          priority?: number;
          task_class: BackgroundTaskClass;
          user_id?: string | null;
          correlation_id?: string | null;
          parent_task_id?: string | null;
          payload?: Json;
          dedupe_key?: string | null;
          attempts?: number;
          max_attempts: number;
          run_after?: string;
          lease_seconds: number;
          locked_by?: string | null;
          locked_until?: string | null;
          started_at?: string | null;
          finished_at?: string | null;
          last_error_code?: string | null;
          last_error_message?: string | null;
          result?: Json | null;
          on_dead_handled_at?: string | null;
          on_dead_attempts?: number;
          on_dead_locked_by?: string | null;
          on_dead_locked_until?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["background_tasks"]["Insert"]
        >;
        Relationships: [];
      };
      /**
       * Server-only AI spend ledger (0007, §13.3.1/§13.9.4). One row per
       * external AI call actually made. Never holds prompt/response content.
       */
      ai_usage_events: {
        Row: {
          id: string;
          user_id: string | null;
          task_id: string | null;
          task_attempt: number | null;
          provider: AiUsageProvider;
          operation: string;
          model: string;
          is_batch: boolean;
          input_tokens: number;
          output_tokens: number;
          cache_read_tokens: number;
          cache_write_tokens: number;
          /** `numeric(12,6)`; PostgREST serializes it as a JSON number. */
          cost_usd: number;
          stop_reason: string | null;
          request_id: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          task_id?: string | null;
          task_attempt?: number | null;
          provider: AiUsageProvider;
          operation: string;
          model: string;
          is_batch?: boolean;
          input_tokens?: number;
          output_tokens?: number;
          cache_read_tokens?: number;
          cache_write_tokens?: number;
          cost_usd: number;
          stop_reason?: string | null;
          request_id?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["ai_usage_events"]["Insert"]
        >;
        Relationships: [];
      };
      /**
       * Per-user daily rate-limit ledger (0007, §13.3.1/§13.9.3).
       * Owner-select only for `authenticated`; inserted only through
       * `private.consume_rate_limit` (via security-definer RPCs), refunded
       * by the worker (service_role).
       */
      rate_limit_events: {
        Row: {
          id: string;
          user_id: string;
          kind: RateLimitKind;
          ref_id: string | null;
          refunded_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: RateLimitKind;
          ref_id?: string | null;
          refunded_at?: string | null;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["rate_limit_events"]["Insert"]
        >;
        Relationships: [];
      };
      /**
       * Resume critiques (0010, §13.3.8, §13.20.2). Owner-select only for
       * `authenticated`; inserted only by the service role
       * (lib/supabase/queries/critiques.ts#insertResumeCritique). A
       * BEFORE INSERT OR UPDATE OF resume_id, user_id trigger raises `validation_owner_mismatch`
       * unless the resume belongs to `user_id`. `report_id` / `profile_id`
       * get their FKs in 0016.
       */
      resume_critiques: {
        Row: {
          id: string;
          report_id: string | null;
          resume_id: string;
          user_id: string;
          profile_id: string | null;
          prompt_version: string;
          model: string;
          overall_score: number;
          summary: string;
          student_context: Json;
          dimension_scores: Json;
          line_feedback: Json;
          section_feedback: Json;
          ats_issues: Json;
          missing_sections: Json;
          dropped_items: number;
          created_at: string;
        };
        Insert: {
          id?: string;
          report_id?: string | null;
          resume_id: string;
          user_id: string;
          profile_id?: string | null;
          prompt_version: string;
          model: string;
          overall_score: number;
          summary: string;
          student_context: Json;
          dimension_scores: Json;
          line_feedback?: Json;
          section_feedback?: Json;
          ats_issues?: Json;
          missing_sections?: Json;
          dropped_items?: number;
          created_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["resume_critiques"]["Insert"]
        >;
        Relationships: [];
      };
      /**
       * External job sources and sync settings (0009, §13.3.3). Server-only:
       * RLS on, no policies; only service_role reads or writes it.
       */
      job_sources: {
        Row: {
          slug: JobSourceSlug;
          display_name: string;
          enabled: boolean;
          sync_mode: JobSourceSyncMode;
          dedupe_priority: number;
          default_ttl_days: number;
          config: JsonObject;
          last_run_at: string | null;
          last_success_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          slug: JobSourceSlug;
          display_name: string;
          enabled?: boolean;
          sync_mode: JobSourceSyncMode;
          dedupe_priority: number;
          default_ttl_days: number;
          config?: JsonObject;
          last_run_at?: string | null;
          last_success_at?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["job_sources"]["Insert"]>;
        Relationships: [];
      };
      /** Per-company boards for snapshot sources (0009). Server-only. */
      job_source_boards: {
        Row: {
          id: string;
          source_slug: JobSourceSlug;
          board_token: string;
          company_name: string | null;
          enabled: boolean;
          include_unlabeled_titles: boolean;
          last_synced_at: string | null;
          last_error_code: string | null;
          consecutive_failures: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          source_slug: JobSourceSlug;
          board_token: string;
          company_name?: string | null;
          enabled?: boolean;
          include_unlabeled_titles?: boolean;
          last_synced_at?: string | null;
          last_error_code?: string | null;
          consecutive_failures?: number;
          created_at?: string;
          updated_at?: string;
        };
        Update: Partial<
          Database["public"]["Tables"]["job_source_boards"]["Insert"]
        >;
        Relationships: [];
      };
      /** One row per source/board sync run (0009). Server-only. */
      job_source_runs: {
        Row: {
          id: string;
          source_slug: JobSourceSlug;
          board_id: string | null;
          task_id: string | null;
          started_at: string;
          finished_at: string | null;
          status: JobSourceRunStatus;
          fetched: number;
          inserted: number;
          updated: number;
          unchanged: number;
          closed: number;
          skipped_filtered: number;
          skipped_invalid: number;
          /** No PII; never listing text. */
          error_summary: string | null;
        };
        Insert: {
          id?: string;
          source_slug: JobSourceSlug;
          board_id?: string | null;
          task_id?: string | null;
          started_at?: string;
          finished_at?: string | null;
          status?: JobSourceRunStatus;
          fetched?: number;
          inserted?: number;
          updated?: number;
          unchanged?: number;
          closed?: number;
          skipped_filtered?: number;
          skipped_invalid?: number;
          error_summary?: string | null;
        };
        Update: Partial<
          Database["public"]["Tables"]["job_source_runs"]["Insert"]
        >;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      /**
       * Ranked full-text search over `job_descriptions` (0005; v2 in 0009
       * adds `scope`: 'shared' = active shared listings, 'mine' = everything
       * the caller submitted except duplicates; any other value raises
       * `validation_scope`). SECURITY INVOKER, authenticated only. See
       * `lib/supabase/queries/jobDescriptions.ts#searchJobDescriptions` and
       * docs/ARCHITECTURE.md §9, §13.3.3.
       */
      search_job_descriptions: {
        Args: {
          search_query: string;
          level_filter?: string | null;
          scope?: "shared" | "mine";
          limit_count?: number;
          offset_count?: number;
        };
        Returns: Database["public"]["Tables"]["job_descriptions"]["Row"][];
      };
      // --- 0009: listing RPCs (authenticated, security definer) ---------
      /**
       * Submit a listing as `auth.uid()`; consumes `job_listing_create`.
       * Raises `unauthenticated` (42501), `validation_*`,
       * `rate_limited:job_listing_create` (P0001).
       */
      create_job_listing: {
        Args: {
          p_title: string;
          p_company: string | null;
          p_description: string;
          p_source_url: string | null;
          p_location: string | null;
          p_level: string | null;
          p_visibility: JobListingVisibility;
        };
        Returns: Database["public"]["Tables"]["job_descriptions"]["Row"];
      };
      /**
       * Edit the caller's own user listing. Patch keys: title, company,
       * description, source_url, location, level, visibility. Raises
       * `not_found_or_not_owner`, `visibility_downgrade`, `validation_*`,
       * `rate_limited:job_listing_update`.
       */
      update_job_listing: {
        Args: { p_id: string; p_patch: Json };
        Returns: Database["public"]["Tables"]["job_descriptions"]["Row"];
      };
      /** Private → hard delete ('deleted'); shared → soft delete ('soft_deleted'). */
      delete_job_listing: {
        Args: { p_id: string };
        Returns: "deleted" | "soft_deleted";
      };
      // --- 0009: ingest functions (service_role only) -------------------
      /** Enqueue today's ingest.sync_source tasks; returns syncs requested. */
      enqueue_source_syncs: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** Close shared listings past expires_at; returns the number closed. */
      expire_stale_job_descriptions: {
        Args: Record<string, never>;
        Returns: number;
      };
      /** Recompute canonical/duplicate_of for the given keys; returns rows changed. */
      resolve_job_duplicates: {
        Args: { p_dedupe_keys: string[] };
        Returns: number;
      };
      // --- 0007: task queue functions (service_role only) ---------------
      enqueue_task: {
        Args: {
          p_kind: string;
          p_task_class: BackgroundTaskClass;
          p_payload?: Json;
          p_user_id?: string | null;
          p_dedupe_key?: string | null;
          p_priority?: number;
          p_max_attempts?: number;
          p_lease_seconds?: number;
          p_run_after?: string | null;
          p_correlation_id?: string | null;
          p_parent_task_id?: string | null;
        };
        /** The new task id, or the existing live task's id on dedupe. */
        Returns: string;
      };
      claim_tasks: {
        Args: {
          p_worker_id: string;
          p_task_class: BackgroundTaskClass;
          p_kinds: string[];
          p_max_running: number;
          p_limit: number;
        };
        Returns: Database["public"]["Tables"]["background_tasks"]["Row"][];
      };
      complete_task: {
        Args: { p_id: string; p_worker_id: string; p_result?: Json | null };
        /** false = fenced out (this worker no longer holds the task). */
        Returns: boolean;
      };
      fail_task: {
        Args: {
          p_id: string;
          p_worker_id: string;
          p_error_code: string;
          p_error_message: string | null;
          p_retryable: boolean;
          p_retry_delay_seconds: number;
        };
        /** New status ('queued' | 'dead'), or null when fenced out. */
        Returns: "queued" | "dead" | null;
      };
      snooze_task: {
        Args: {
          p_id: string;
          p_worker_id: string;
          p_seconds: number;
          p_reason: string;
        };
        /** false = fenced out. */
        Returns: boolean;
      };
      extend_task_lease: {
        Args: { p_id: string; p_worker_id: string; p_seconds: number };
        /** false = fenced out. */
        Returns: boolean;
      };
      cancel_tasks_for_user: {
        Args: { p_user_id: string };
        /** Number of queued tasks cancelled. */
        Returns: number;
      };
      purge_finished_tasks: {
        Args: Record<string, never>;
        /** Rows deleted (dead rows only once their onDead hook is handled). */
        Returns: number;
      };
      /**
       * Stale-lease sweep: dead-letters running tasks of any kind whose
       * lease expired more than `p_older_than` ago (Postgres interval text,
       * default '6 hours'), code `lease_expired`. Returns the count.
       */
      dead_letter_stale_tasks: {
        Args: { p_older_than?: string };
        Returns: number;
      };
      /** Dead-task hook outbox: lock pending hooks of known kinds (§13.4.5). */
      claim_dead_task_hooks: {
        Args: {
          p_worker_id: string;
          p_kinds: string[];
          p_limit: number;
          p_task_id?: string | null;
        };
        Returns: Database["public"]["Tables"]["background_tasks"]["Row"][];
      };
      /** Mark a hook handled (fenced). false = fenced out / already handled. */
      complete_dead_task_hook: {
        Args: { p_id: string; p_worker_id: string; p_gave_up?: boolean };
        Returns: boolean;
      };
      /**
       * Release a claimed-but-unrun hook: clears the lock and refunds the
       * attempt (fenced). false = fenced out / already handled.
       */
      release_dead_task_hook: {
        Args: { p_id: string; p_worker_id: string };
        Returns: boolean;
      };
      /**
       * Global-budget deferral: moves claimable queued tasks of `p_kinds`
       * to `p_until` + jitter without claiming them. Returns deferred rows.
       */
      defer_queued_tasks: {
        Args: {
          p_task_class: BackgroundTaskClass;
          p_kinds: string[];
          p_until: string;
          p_max_jitter_seconds?: number;
          p_limit?: number;
        };
        Returns: Database["public"]["Tables"]["background_tasks"]["Row"][];
      };
      // --- 0007: worker read helpers (service_role only) ----------------
      ai_spend_summary: {
        Args: { p_since: string };
        Returns: {
          provider: AiUsageProvider;
          operation: string;
          cost_usd: number;
          calls: number;
        }[];
      };
      background_task_counts: {
        Args: Record<string, never>;
        Returns: {
          kind: string;
          status: BackgroundTaskStatus;
          n: number;
        }[];
      };
      // --- 0007: user RPC (authenticated) -------------------------------
      get_my_rate_limits: {
        Args: Record<string, never>;
        Returns: {
          kind: RateLimitKind;
          daily_limit: number;
          used_today: number;
          resets_at: string;
        }[];
      };
      /**
       * Charges one `account_reauth` attempt to the caller (§13.3.1,
       * §13.13.7). true = recorded; false = at the daily limit (does not
       * raise). Raises `unauthenticated` without a session.
       */
      consume_account_reauth_attempt: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      // --- 0010: user RPC (authenticated) -------------------------------
      /**
       * Charges one `resume_report` unit to the caller for a critique of
       * the caller's own resume and returns the future critique id (also
       * the ledger `ref_id`). Raises `unauthenticated` (42501),
       * `not_found`, or `rate_limited:resume_report` (P0001). §13.20.2.
       */
      request_resume_critique: {
        Args: { p_resume_id: string };
        Returns: string;
      };
    };
    Enums: Record<string, never>;
  };
}
