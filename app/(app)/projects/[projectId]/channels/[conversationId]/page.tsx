import Link from "next/link";
import { notFound } from "next/navigation";
import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { channelLabel, formatDateTime } from "@/lib/ui/format";
import { MessageBubble } from "@/components/chat/MessageBubble";
import type { ChatMessageVM, ContextSource } from "@/components/chat/types";

export const dynamic = "force-dynamic";

// DELIBERATELY NO loading.tsx anywhere above this page (this segment or
// ../../[projectId]/) -- same reasoning as
// ../../chat/[conversationId]/page.tsx's identical comment: an ancestor
// `loading.tsx`'s Suspense boundary can flush a 200 status before this
// page's own notFound() below ever runs. channels/'s own loading.tsx moved
// into the sibling `(list)` route group (see ../(list)/page.tsx) for
// exactly this reason -- see app/(app)/projects/not-found.tsx's header
// comment (bug 3) for the full story, verified live.
interface ConversationRow {
  id: string;
  channel: string;
  external_participant_id: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: ContextSource[] | null;
  created_at: string;
}

// Read-only transcript of ONE external-channel session -- no reply
// capability by design (owners don't send messages into external sessions,
// only service_role does, via lib/gateway/answer.ts -- see the
// conversations migration's RLS comment). Reuses MessageBubble/SourceList
// from the owner test-chat UI so citations render identically here, just
// without ChatView's input bar/streaming/retry machinery, none of which
// apply to a static history view.
export default async function ChannelSessionTranscriptPage({
  params,
}: {
  params: Promise<{ projectId: string; conversationId: string }>;
}) {
  const { projectId, conversationId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();

  // `.not("channel", "is", null)` -- this route is specifically for
  // EXTERNAL-channel sessions; an owner test-chat conversationId (channel
  // is null) belongs on /projects/[projectId]/chat/[conversationId]
  // instead, not this read-only view.
  const { data: conversation, error: conversationError } = await supabase
    .from("conversations")
    .select("id, channel, external_participant_id, updated_at")
    .eq("id", conversationId)
    .eq("project_id", projectId)
    .not("channel", "is", null)
    .maybeSingle<ConversationRow>();
  if (conversationError) {
    console.error(`channels/[conversationId]: failed to load conversation ${conversationId}:`, conversationError.message);
  }
  if (!conversation) {
    notFound();
  }

  const { data: messageRows, error: messagesError } = await supabase
    .from("messages")
    .select("id, role, content, sources, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  if (messagesError) {
    console.error(`channels/[conversationId]: failed to load messages for ${conversationId}:`, messagesError.message);
  }

  const messages: ChatMessageVM[] = ((messageRows ?? []) as MessageRow[]).map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    sources: row.sources ?? [],
  }));

  return (
    <div className="transcript-page">
      <div>
        <Link href={`/projects/${projectId}/channels`} className="project-header-back">
          ← Каналы
        </Link>
      </div>
      <header>
        <h1 style={{ fontSize: "1.2rem" }}>
          {channelLabel(conversation.channel)}: {conversation.external_participant_id}
        </h1>
        <p className="field-hint" style={{ marginTop: "0.3rem" }}>
          Только чтение — обновлено {formatDateTime(conversation.updated_at)}. Отвечает пользователю только сам
          ассистент, отправить сообщение отсюда нельзя.
        </p>
      </header>

      {messages.length === 0 ? (
        <div className="card empty-state">
          <p>В этом диалоге пока нет сообщений.</p>
        </div>
      ) : (
        <div className="chat-messages" style={{ padding: 0, overflow: "visible" }}>
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      )}
    </div>
  );
}
