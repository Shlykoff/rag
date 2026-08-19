// lib/tokens.ts
//
// Shared, provider-agnostic token estimate used by both chunking
// (lib/ingestion/chunk.ts, sizing chunks) and retrieval (lib/retrieval/
// search.ts, enforcing the context token budget). Deliberately not a real
// tokenizer -- see the comment on estimateTokens for why chars/4 is good
// enough here, and why actually-billed token counts always come from
// provider API responses instead (lib/ai/stream-utils.ts usage, logged to
// usage_events), never from this estimate.

const CHARS_PER_TOKEN_ESTIMATE = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

export function tokensToChars(tokens: number): number {
  return tokens * CHARS_PER_TOKEN_ESTIMATE;
}
