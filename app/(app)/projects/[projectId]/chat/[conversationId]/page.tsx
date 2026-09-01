import { notFound } from "next/navigation";
import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { ChatView } from "@/components/chat/ChatView";
import type { ChatMessageVM, ContextSource } from "@/components/chat/types";

export const dynamic = "force-dynamic";

// DELIBERATELY NO loading.tsx anywhere above this page (this segment, its
// ../layout.tsx, or ../../[projectId]/) -- an ancestor loading.tsx's
// Suspense boundary can flush a 200 status before this page's own
// notFound() below ever runs, making a real 404 impossible regardless of
// where not-found.tsx lives. See app/(app)/projects/not-found.tsx for the
// full mechanism.
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

  // RLS already scopes this to conversations under a project the caller
  // owns; a conversationId belonging to another project or that doesn't
  // exist just returns no row, which notFound() below surfaces (not a leak
  // of its existence). `.eq("project_id", projectId)` is an explicit
  // belt-and-suspenders scope on top of that. `.is("channel", null)`
  // excludes external-channel sessions -- those belong on
  // /projects/[projectId]/channels/[conversationId]'s read-only transcript
  // view instead, not this owner test-chat page.
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

  // Same "any ready document" check as .../chat/(list)/page.tsx -- only
  // affects the empty state at messages.length === 0, which an existing
  // thread practically never hits, but kept in sync rather than hardcoded.
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
