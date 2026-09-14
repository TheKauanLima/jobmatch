import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAdminClient } from "@/lib/supabase/admin";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("createAdminClient", () => {
  it("creates a client when both required env vars are set", () => {
    expect(() => createAdminClient()).not.toThrow();
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    expect(() => createAdminClient()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
    );
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => createAdminClient()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY/,
    );
  });
});
