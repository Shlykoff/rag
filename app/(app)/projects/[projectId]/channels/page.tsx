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

  // One small query per session for its most recent message preview --
  // bounded by MAX_SESSIONS (well above realistic demo-scale external
  // traffic, same "keep it simple, document the bound" tradeoff this
  // codebase already makes elsewhere, e.g.
  // app/api/projects/[projectId]/route.ts's STORAGE_LIST_PAGE_SIZE
  // comment) rather than one bigger query + client-side grouping.
  const previews = await Promise.all(
    sessions.map(async (session) => {
      const { data, error } = await supabase
        .from("messages")
        .select("content, role")
        .eq("conversation_id", session.id)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) {
        console.error(`projects/[projectId]/channels: failed to load last message for ${session.id}:`, error.message);
        return null;
      }
      return ((data ?? [])[0] as LastMessageRow | undefined) ?? null;
    })
  );

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
            {sessions.map((session, index) => {
              const preview = previews[index];
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
