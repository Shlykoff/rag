import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ChatHistoryPanel } from "@/components/chat/ChatHistoryPanel";

export const dynamic = "force-dynamic";

interface ConversationRow {
  id: string;
  title: string | null;
}

// Wraps both chat/(list)/page.tsx (new conversation) and
// chat/[conversationId]/page.tsx (existing one) with the project's own
// conversation history panel. Project ownership was already verified by
// the parent app/(app)/projects/[projectId]/layout.tsx (notFound() there
// short-circuits rendering before this ever runs), so this only needs the
// RLS-scoped session client for its own conversations read -- RLS
// (conversations_select_own) still independently scopes this to the
// caller's own projects regardless.
//
// `(list)` IS A ROUTE GROUP (parentheses -- adds no URL segment; "/chat"
// still resolves to chat/(list)/page.tsx), not a naming accident. It
// exists specifically to give chat/(list)/loading.tsx a Suspense boundary
// that wraps ONLY the new-conversation page, never the sibling
// chat/[conversationId]/page.tsx -- see
// app/(app)/projects/not-found.tsx's header comment (bug 3) for why a
// `loading.tsx` directly in this chat/ folder used to wrap BOTH siblings
// and broke chat/[conversationId]/page.tsx's own notFound()'s HTTP status
// (branded 404 UI rendered, but the response was a bare 200) -- verified
// live, not by inspection, in both `next dev` and a production build.
//
// `.is("channel", null)` is load-bearing, not decoration: the owner can
// SELECT every conversation under a project they own, including external
// channel sessions (see the conversations migration's RLS comment) -- this
// history panel is specifically the owner's OWN test-chat threads; external
// sessions get their own read-only view under
// /projects/[projectId]/channels (see CLAUDE.md Stage C item 2).
export default async function ProjectChatLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();

  const { data, error } = await supabase
    .from("conversations")
    .select("id, title")
    .eq("project_id", projectId)
    .is("channel", null)
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error(`projects/[projectId]/chat/layout.tsx: failed to load conversations for ${projectId}:`, error.message);
  }

  return (
    <div className="chat-shell">
      <ChatHistoryPanel projectId={projectId} conversations={(data ?? []) as ConversationRow[]} />
      <div className="chat-main">{children}</div>
    </div>
  );
}
