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
 * only because they were written before being applied (M1.2). Regenerate
 * and diff once 0007/0008 are applied to the live project.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ResumeStatus = "uploaded" | "processing" | "analyzed" | "failed";
export type JobDescriptionSource = "user" | "themuse";

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
    };
    Views: Record<string, never>;
    Functions: {
      /**
       * Ranked full-text search over `job_descriptions`, added by
       * supabase/migrations/0005_job_description_search.sql — see
       * `lib/supabase/queries/jobDescriptions.ts#searchJobDescriptions` and
       * docs/ARCHITECTURE.md §9.
       */
      search_job_descriptions: {
        Args: {
          search_query: string;
          level_filter?: string | null;
          limit_count?: number;
          offset_count?: number;
        };
        Returns: Database["public"]["Tables"]["job_descriptions"]["Row"][];
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
        /** Number of rows deleted. */
        Returns: number;
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
    };
    Enums: Record<string, never>;
  };
}
