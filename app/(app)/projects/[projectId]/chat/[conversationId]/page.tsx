import { notFound } from "next/navigation";
import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ChatView } from "@/components/chat/ChatView";
import type { ChatMessageVM, ContextSource } from "@/components/chat/types";

export const dynamic = "force-dynamic";

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: ContextSource[] | null;
}

export default async function ProjectExistingChatPage({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) {
  const { projectId, conversationId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();

  // RLS (conversations_select_own) already scopes this to conversations
  // under a project the caller owns -- a conversationId belonging to
  // another project (even one of this same user's OTHER projects) or that
  // doesn't exist simply returns no row, not a leak of its existence,
  // which is exactly what notFound() below surfaces. `.eq("project_id",
  // projectId)` is an explicit belt-and-suspenders scope on top of that
  // (this URL's own projectId must match, not just "some project this user
  // owns"). `.is("channel", null)` excludes external-channel sessions --
  // opening one of THOSE is what
  // /projects/[projectId]/channels/[conversationId]'s read-only transcript
  // view is for, not this owner test-chat page (which would otherwise let
  // the owner "continue" an external session from here; the chat API
  // itself would reject that -- see lib/chat/handle-chat-request.ts's
  // resolveConversationId, `.eq("user_id", ownerUserId)` can never match an
  // external-shaped row -- but there's no reason to let the UI dead-end
  // into that in the first place).
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .eq("project_id", projectId)
    .is("channel", null)
    .maybeSingle();
  if (conversationError) {
    console.error(`chat/[conversationId]: failed to load conversation ${conversationId}:`, conversationError.message);
  }
  if (!conversation) {
    notFound();
  }

  const { data: messageRows, error: messagesError } = await supabase
    .from("messages")
    .select("id, role, content, sources")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (messagesError) {
    console.error(`chat/[conversationId]: failed to load messages for ${conversationId}:`, messagesError.message);
  }

  const initialMessages: ChatMessageVM[] = ((messageRows ?? []) as MessageRow[]).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    sources: row.sources ?? [],
  }));

  // Same "any ready document" check as .../chat/page.tsx -- kept in sync
  // rather than hardcoded, even though this prop only affects the empty
  // state rendered at messages.length === 0, which an existing thread with
  // messages already loaded practically never hits.
  const { count: readyDocumentCount, error: documentsError } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .eq("processing_status", "ready");
  if (documentsError) {
    console.error(`chat/[conversationId]: failed to check for ready documents (${projectId}):`, documentsError.message);
  }

  return (
    <ChatView
      projectId={projectId}
      conversationId={conversationId}
      initialMessages={initialMessages}
      hasDocuments={(readyDocumentCount ?? 0) > 0}
    />
  );
}
