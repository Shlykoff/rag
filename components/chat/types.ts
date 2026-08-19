// components/chat/types.ts
//
// Shared view-model types for the chat UI. `ContextSource` is imported
// (type-only -- zero runtime footprint) from lib/retrieval/search.ts so
// the citation shape used here can never drift from what
// app/api/chat/route.ts actually streams / what messages.sources actually
// stores -- see that module's doc comment for the exact field meanings.

import type { ContextSource } from "@/lib/retrieval/search";

export type { ContextSource };

export interface ChatMessageVM {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources: ContextSource[];
  /** True while this assistant message's answer is still streaming in. */
  pending?: boolean;
  /** Set if this turn ended in a terminal `error` SSE event (or a non-2xx before streaming even started). */
  error?: { message: string; retryable: boolean } | null;
  /** For assistant messages only: the paired user question, so a "Повторить" button on a failed turn can resend the exact same text. Never set on messages loaded from history (those never carry an error -- see handleChatRequest's "no assistant message on failure" comment). */
  question?: string;
}
