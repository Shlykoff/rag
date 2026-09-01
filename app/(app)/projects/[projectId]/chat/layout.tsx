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
// the parent app/(app)/projects/[projectId]/layout.tsx.
//
// `(list)` is a route group (parentheses -- adds no URL segment; "/chat"
// still resolves to chat/(list)/page.tsx). It exists so
// chat/(list)/loading.tsx's Suspense boundary wraps only the
// new-conversation page, never the sibling chat/[conversationId]/page.tsx
// -- see app/(app)/projects/not-found.tsx for why that matters.
//
// `.is("channel", null)` is load-bearing: the owner can SELECT every
// conversation under a project they own, including external-channel
// sessions, but this history panel is specifically the owner's own
// test-chat threads -- external sessions get their own read-only view
// under /projects/[projectId]/channels.
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
