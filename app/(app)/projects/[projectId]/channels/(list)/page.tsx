import Link from "next/link";
import { getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { channelLabel, formatRelativeTime } from "@/lib/ui/format";
import { TelegramChannelPanel } from "@/components/projects/TelegramChannelPanel";

export const dynamic = "force-dynamic";

interface ConversationRow {
  id: string;
  channel: string;
  external_participant_id: string;
  title: string | null;
  updated_at: string;
}

interface LastMessageRow {
  content: string;
  role: "user" | "assistant";
}

const MAX_SESSIONS = 50;
const PREVIEW_LENGTH = 80;

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 1)}…` : singleLine;
}

// Read-only view into this project's external-channel sessions -- "see
// what the bot told people" (see CLAUDE.md Stage C item 5 / the projects
// pivot plan's conversations RLS comment: the owner can SELECT every
// conversation under a project they own, including external-channel ones,
// but can never write one -- only service_role does, via
// lib/gateway/answer.ts). A direct Server Component Supabase query (RLS
// already allows it), not a new API route -- same "Server Components MAY
// query Supabase directly" convention as every other page in this stage.
//
// Lives under the `(list)` route group purely so its sibling loading.tsx
// doesn't also wrap ../[conversationId]/page.tsx's own notFound() call --
// see app/(app)/projects/not-found.tsx's header comment (bug 3) and
// ../../chat/layout.tsx's identical rationale. This file's URL is
// unaffected ("/channels"), route groups add no path segment.
export default async function ProjectChannelsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const supabase = await getRouteHandlerSupabaseClient();

  const { data: sessionRows, error: sessionsError } = await supabase
    .from("conversations")
    .select("id, channel, external_participant_id, title, updated_at")
    .eq("project_id", projectId)
    .not("channel", "is", null)
    .order("updated_at", { ascending: false })
    .limit(MAX_SESSIONS);
  if (sessionsError) {
    console.error(`projects/[projectId]/channels: failed to load external sessions (${projectId}):`, sessionsError.message);
  }
  const sessions = (sessionRows ?? []) as ConversationRow[];

  // Single query for every session's most recent message, instead of one
  // round-trip per session (previously up to MAX_SESSIONS separate
  // queries). `.in("conversation_id", sessionIds)` ordered by created_at
  // desc pulls every message for these sessions in one go; grouping by
  // conversation_id here (in the Server Component, before rendering) and
  // keeping only the first (= most recent, since we're already sorted
  // desc) row per conversation reproduces the exact same "one preview per
  // session" result the N+1 version produced, at a fixed query count
  // regardless of MAX_SESSIONS.
  const sessionIds = sessions.map((session) => session.id);
  const previewByConversationId = new Map<string, LastMessageRow>();
  if (sessionIds.length > 0) {
    const { data: messageRows, error: messagesError } = await supabase
      .from("messages")
      .select("conversation_id, content, role")
      .in("conversation_id", sessionIds)
      .order("created_at", { ascending: false });
    if (messagesError) {
      console.error(`projects/[projectId]/channels: failed to load last messages (${projectId}):`, messagesError.message);
    } else {
      for (const row of (messageRows ?? []) as (LastMessageRow & { conversation_id: string })[]) {
        if (!previewByConversationId.has(row.conversation_id)) {
          previewByConversationId.set(row.conversation_id, row);
        }
      }
    }
  }

  return (
    <div className="sources-page">
      <header className="sources-page-header">
        <h1>Каналы</h1>
        <p className="field-hint">
          Подключите Telegram-бота к этому проекту, чтобы внешние пользователи могли задавать вопросы
          по вашим документам напрямую в мессенджере. Ниже — только чтение переписки бота с ними;
          отвечать из этого экрана нельзя, отвечает только сам ассистент.
        </p>
      </header>

      <TelegramChannelPanel projectId={projectId} />

      <section aria-labelledby="channel-sessions-heading" style={{ marginTop: "2rem" }}>
        <h2 id="channel-sessions-heading" style={{ fontSize: "1.05rem", marginBottom: "0.9rem" }}>
          Диалоги через внешние каналы
        </h2>
        {sessions.length === 0 ? (
          <div className="card empty-state">
            <p>Пока никто не писал боту.</p>
            <p className="field-hint">
              Как только внешний пользователь напишет боту в подключённом канале, диалог появится здесь.
            </p>
          </div>
        ) : (
          <ul className="channel-session-list">
            {sessions.map((session) => {
              const preview = previewByConversationId.get(session.id) ?? null;
              return (
                <li key={session.id}>
                  <Link href={`/projects/${projectId}/channels/${session.id}`} className="card channel-session-card">
                    <div className="channel-session-meta">
                      <span className="badge badge-neutral">{channelLabel(session.channel)}</span>
                      <span className="field-hint">{session.external_participant_id}</span>
                      <span className="field-hint">{formatRelativeTime(session.updated_at)}</span>
                    </div>
                    <p className="channel-session-preview">
                      {preview ? `${preview.role === "user" ? "Пользователь: " : "Ассистент: "}${truncate(preview.content, PREVIEW_LENGTH)}` : "Нет сообщений"}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
