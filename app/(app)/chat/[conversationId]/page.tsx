import { notFound } from "next/navigation";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ChatView } from "@/components/chat/ChatView";
import type { ChatMessageVM, ContextSource } from "@/components/chat/types";

export const dynamic = "force-dynamic";

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: ContextSource[] | null;
}

export default async function ExistingChatPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(supabase);
  if (!user) return null;

  // RLS (conversations_select_own) already scopes this to the caller's
  // own conversations -- a conversationId belonging to another user (or
  // that doesn't exist) simply returns no row, not a leak of its
  // existence, which is exactly what notFound() below surfaces.
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();
  if (conversationError) {
    console.error("chat/[conversationId]: failed to load conversation:", conversationError.message);
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
    console.error("chat/[conversationId]: failed to load messages:", messagesError.message);
  }

  const initialMessages: ChatMessageVM[] = ((messageRows ?? []) as MessageRow[]).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    sources: row.sources ?? [],
  }));

  // Same "any ready document" check as app/(app)/page.tsx -- kept in sync
  // rather than hardcoded, even though this prop only affects the empty
  // state rendered at messages.length === 0, which an existing thread with
  // messages already loaded practically never hits.
  const { count: readyDocumentCount, error: documentsError } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("processing_status", "ready");
  if (documentsError) {
    console.error(
      "chat/[conversationId]: failed to check for ready documents:",
      documentsError.message,
    );
  }

  return (
    <ChatView
      conversationId={conversationId}
      initialMessages={initialMessages}
      hasDocuments={(readyDocumentCount ?? 0) > 0}
    />
  );
}
