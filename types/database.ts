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
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type ResumeStatus = "uploaded" | "processing" | "analyzed" | "failed";

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
    Functions: Record<string, never>;
    Enums: Record<string, never>;
  };
}
