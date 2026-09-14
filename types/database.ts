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
    };
    Enums: Record<string, never>;
  };
}
