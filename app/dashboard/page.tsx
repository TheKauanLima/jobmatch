import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { DashboardView } from "@/components/dashboard/DashboardView";
import { getSession } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { loadDashboard } from "./loadDashboard";

export const metadata: Metadata = {
  title: "Dashboard · Kalify",
};

/**
 * The signed-in home: resumes with their latest critique scores, the next
 * best step, top matches and today's critique allowance. All data is read
 * server-side through the caller's RLS-scoped session client
 * (`loadDashboard`); the user id comes from the verified session only.
 */
export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const supabase = await createClient();
  const data = await loadDashboard(supabase, session.user.id);

  return <DashboardView data={data} />;
}
