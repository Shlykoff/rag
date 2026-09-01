import { redirect } from "next/navigation";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { TopBar } from "@/components/layout/TopBar";

export const dynamic = "force-dynamic";

// Protects every page under app/(app)/** (projects list, a project's
// chat/documents/model/channels, profile) -- belt-and-suspenders alongside
// proxy.ts's redirect. Just the auth gate plus the thin account-level top
// bar (Мои проекты / Профиль / signed-in user); conversation history and
// the active-provider badge are per-project concerns, rendered inside a
// project's own chat section and layout instead (see
// components/chat/ChatHistoryPanel.tsx and
// app/(app)/projects/[projectId]/layout.tsx).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    redirect("/login");
  }

  return (
    <div className="app-shell-flat">
      <TopBar userEmail={user.email} />
      <main className="app-main">{children}</main>
    </div>
  );
}
