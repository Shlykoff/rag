import { redirect } from "next/navigation";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { getActiveAIProviderInfo } from "@/lib/ui/ai-provider";
import { Sidebar, type ConversationSummary } from "@/components/layout/Sidebar";

export const dynamic = "force-dynamic";

interface ConversationRow {
  id: string;
  title: string | null;
  updated_at: string;
}

// Protects every page under app/(app)/** (chat, chat/[id], sources) --
// belt-and-suspenders alongside proxy.ts's redirect: this also
// guarantees a validated user id is available to fetch conversations
// (RLS-scoped, so this query already only ever returns the caller's own
// rows -- see CLAUDE.md's RLS section).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) {
    redirect("/login");
  }

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) {
    console.error("app/(app)/layout.tsx: failed to load conversations:", error.message);
  }

  const conversations: ConversationSummary[] = ((data ?? []) as ConversationRow[]).map((row) => ({
    id: row.id,
    title: row.title,
  }));

  const aiProvider = getActiveAIProviderInfo();

  return (
    <div className="app-shell">
      <Sidebar conversations={conversations} userEmail={user.email} aiProviderLabel={aiProvider.label} />
      <main className="app-main">{children}</main>
    </div>
  );
}
