// lib/retrieval/search.ts
//
// Embeds the user's question, calls the match_document_chunks RPC
// (db-architect), and assembles a token-budgeted context string plus the
// list of sources that actually made it into that context -- the API route
// (app/api/chat/route.ts) passes the context into the ChatProvider and
// returns the sources alongside the streamed answer so the frontend never
// has to guess what was actually used (CLAUDE.md retrieval section).
//
// SECURITY: match_document_chunks is security definer and EXECUTE is
// granted to service_role only (see the RPC migration's comment) -- it
// trusts p_user_id completely and does not re-derive it from RLS. This
// module is called ONLY from server code with a p_user_id that came from
// lib/supabase/server-client.ts's getAuthenticatedUser() -- see
// app/api/chat/route.ts. It must never accept a userId parameter sourced
// from the request body/query string.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmbeddingsProvider } from "../ai/types";
import { estimateTokens } from "../tokens";

export type DocumentSourceType = "manual_upload" | "notion" | "url" | "google_drive";

/** One row from match_document_chunks, typed to match the RPC's `returns table (...)` exactly (see supabase/migrations/20260819052359_create_match_document_chunks_rpc.sql). */
export interface MatchedChunk {
  chunk_id: string;
  document_id: string;
  content: string;
  chunk_index: number;
  page_number: number | null;
  chunk_position: number | null;
  similarity: number;
  document_title: string;
  document_source_type: DocumentSourceType;
  document_source_ref: string | null;
}

/** A source citation for one chunk that was actually included in the assembled context -- this is what gets attached to messages.sources (jsonb) and shown in the UI as "based on document X". */
export interface ContextSource {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceType: DocumentSourceType;
  sourceRef: string | null;
  pageNumber: number | null;
  chunkPosition: number | null;
  similarity: number;
}

export interface RetrievalResult {
  /** Formatted, numbered context ready to interpolate into the chat prompt. Empty string if no chunks matched (or the user has no ready documents) -- the system prompt (lib/retrieval/system-prompt.ts) instructs the model to say it doesn't know in that case, so an empty context is a valid, handled outcome, not an error. */
  contextText: string;
  /** Sources for exactly the chunks included in contextText, in the same order -- see the module comment. */
  sources: ContextSource[];
  /** How many candidate matches the RPC returned before the token budget trimmed them (for logging/debugging retrieval quality). */
  candidateCount: number;
}

export interface RetrievalOptions {
  /** top-k passed to match_document_chunks. 4-6 per CLAUDE.md; default 6. */
  matchCount?: number;
  /** Hard cap on the assembled context, in estimated tokens -- CLAUDE.md "Лимит на длину собираемого контекста (по токенам, не по количеству символов на глаз)". Chunks are added most-similar-first until the next one would exceed this budget. Default 3000 (~a few chunks at 500-800 tokens each, leaving headroom for the system prompt + chat history + the model's own output within typical context windows). */
  maxContextTokens?: number;
}

const DEFAULT_MATCH_COUNT = 6;
const DEFAULT_MAX_CONTEXT_TOKENS = 3000;

function describeSourceType(type: DocumentSourceType): string {
  switch (type) {
    case "manual_upload":
      return "загруженный файл";
    case "notion":
      return "страница Notion";
    case "url":
      return "веб-страница";
    case "google_drive":
      return "файл из Google Drive";
  }
}

function describePosition(chunk: MatchedChunk): string | null {
  if (chunk.page_number != null) return `стр. ${chunk.page_number}`;
  if (chunk.chunk_position != null) return `фрагмент ${chunk.chunk_position + 1}`;
  return null;
}

/**
 * Formats matched chunks (most-similar-first, as returned by the RPC) into
 * a numbered context block, stopping once adding the next chunk would
 * exceed `maxContextTokens`. Pure function of its inputs -- no I/O -- so
 * it's directly unit-testable (lib/retrieval/__tests__/context.test.ts)
 * without a database or embeddings provider.
 */
export function assembleContext(
  matches: MatchedChunk[],
  maxContextTokens: number = DEFAULT_MAX_CONTEXT_TOKENS
): { contextText: string; sources: ContextSource[] } {
  const parts: string[] = [];
  const sources: ContextSource[] = [];
  let usedTokens = 0;

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const position = describePosition(match);
    const header = `[${i + 1}] Источник: "${match.document_title}" (${describeSourceType(
      match.document_source_type
    )}${position ? `, ${position}` : ""})`;
    const block = `${header}\n${match.content}`;
    const blockTokens = estimateTokens(block);

    // Always include at least one chunk even if it alone exceeds the
    // budget -- an empty context is worse than a slightly-over-budget one,
    // and maxContextTokens is sized with headroom precisely so this is a
    // rare edge case, not the common path.
    if (parts.length > 0 && usedTokens + blockTokens > maxContextTokens) {
      break;
    }

    parts.push(block);
    usedTokens += blockTokens;
    sources.push({
      chunkId: match.chunk_id,
      documentId: match.document_id,
      documentTitle: match.document_title,
      sourceType: match.document_source_type,
      sourceRef: match.document_source_ref,
      pageNumber: match.page_number,
      chunkPosition: match.chunk_position,
      similarity: match.similarity,
    });
  }

  return { contextText: parts.join("\n\n"), sources };
}

export interface RunRetrievalDeps {
  supabase: SupabaseClient;
  embeddingsProvider: EmbeddingsProvider;
}

/**
 * End-to-end retrieval: embed the question, call match_document_chunks,
 * assemble a token-budgeted context. `userId` MUST come from a validated
 * server-side session -- see the module-level security comment.
 */
export async function runRetrieval(
  question: string,
  userId: string,
  deps: RunRetrievalDeps,
  options: RetrievalOptions = {}
): Promise<RetrievalResult> {
  const matchCount = options.matchCount ?? DEFAULT_MATCH_COUNT;
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;

  const [queryEmbedding] = await deps.embeddingsProvider.embed([question]);

  const { data, error } = await deps.supabase.rpc("match_document_chunks", {
    query_embedding: queryEmbedding,
    match_count: matchCount,
    p_user_id: userId,
  });

  if (error) {
    throw new Error(`runRetrieval: match_document_chunks RPC failed: ${error.message}`);
  }

  const matches = (data ?? []) as MatchedChunk[];
  const { contextText, sources } = assembleContext(matches, maxContextTokens);

  return { contextText, sources, candidateCount: matches.length };
}
