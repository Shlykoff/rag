"use client";

// components/chat/ChatHistoryPanel.tsx
//
// Per-project conversation history, rendered by
// app/(app)/projects/[projectId]/chat/layout.tsx alongside the active chat
// page. The list passed in is already filtered to `channel is null` --
// the owner's own test-chat threads only, never external-channel sessions
// (those get their own read-only view under
// /projects/[projectId]/channels).
//
// "use client" for usePathname()-based active-conversation highlighting.
// On narrow screens this collapses into a native <details> disclosure, no
// extra JS needed for the open/close behavior itself.

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface ChatHistoryConversation {
  id: string;
  title: string | null;
}

export function ChatHistoryPanel({
  projectId,
  conversations,
}: {
  projectId: string;
  conversations: ChatHistoryConversation[];
}) {
  const pathname = usePathname();

  return (
    <details className="chat-history-panel" open>
      <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: "0.86rem" }}>
        История диалогов {conversations.length > 0 ? `(${conversations.length})` : ""}
      </summary>
      <Link href={`/projects/${projectId}/chat`} className="btn btn-primary btn-sm" style={{ marginTop: "0.6rem" }}>
        + Новый диалог
      </Link>
      {conversations.length === 0 ? (
        <p className="field-hint" style={{ marginTop: "0.6rem" }}>
          Пока нет ни одного диалога — начните новый вопрос выше.
        </p>
      ) : (
        <ul style={{ marginTop: "0.4rem" }}>
          {conversations.map((conversation) => {
            const href = `/projects/${projectId}/chat/${conversation.id}`;
            const isActive = pathname === href;
            return (
              <li key={conversation.id}>
                <Link
                  href={href}
                  className={`chat-history-link${isActive ? " chat-history-link-active" : ""}`}
                >
                  {conversation.title?.trim() || "Без названия"}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </details>
  );
}
