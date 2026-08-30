import { redirect } from "next/navigation";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { TopBar } from "@/components/layout/TopBar";

export const dynamic = "force-dynamic";

// Protects every page under app/(app)/** (projects list, a project's
// chat/documents/model/channels, profile) -- belt-and-suspenders alongside
// proxy.ts's redirect. Projects architecture pivot: this used to also
// fetch the caller's full conversation list + an account-level "работает
// на: X" badge for a single global sidebar (components/layout/Sidebar.tsx,
// now removed) -- both of those are per-PROJECT concepts now (conversation
// history: components/chat/ChatHistoryPanel.tsx, scoped inside one
// project's chat section; active-provider badge:
// app/(app)/projects/[projectId]/layout.tsx's header), so this shell no
// longer has (or needs) either. It's just the auth gate + the thin
// account-level top bar (Мои проекты / Профиль / signed-in user).
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
