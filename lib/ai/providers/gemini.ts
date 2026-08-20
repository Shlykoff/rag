// lib/ai/providers/gemini.ts
//
// Deliberate reuse, not a copy-paste mistake: Google publishes an official
// OpenAI-compatible endpoint for both chat and embeddings
// (https://generativelanguage.googleapis.com/v1beta/openai/), so this
// adapter constructs the exact same OpenAICompatibleProvider class used for
// AI_PROVIDER=openai, just pointed at Google's baseURL/apiKey/model
// instead. No separate Google SDK (`@ai-sdk/google` / `@google/genai`) is
// used for chat or text embeddings -- see CLAUDE.md and the
// rag-pipeline-specialist brief, which explicitly call this out as the
// preferred approach for development speed, given Google's own
// compatibility guarantee for this subset of the API.

import { createOpenAICompatiblePair } from "./openai";
import type { ChatProvider, EmbeddingsProvider } from "../types";

const GEMINI_OPENAI_COMPATIBLE_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";

export interface GeminiConfig {
  apiKey: string;
  chatModel: string;
  embeddingModel: string;
}

/**
 * Returns a {chatProvider, embeddingsProvider} pair backed by Google's
 * OpenAI-compatible endpoint, sharing a single underlying HTTP client (see
 * createOpenAICompatiblePair()'s doc comment for why this is two objects
 * with independently-correct `modelName`s rather than one object
 * implementing both interfaces -- that used to be the shape here, and it
 * silently reported the CHAT model as the EMBEDDING model wherever
 * `embeddingsProvider.modelName` was read, e.g.
 * document_chunks.embedding_model). Kept as a thin factory function (rather
 * than a subclass) since there is no Gemini-specific behavior beyond the
 * constructor config -- createOpenAICompatiblePair() already fully covers
 * both roles.
 */
export function createGeminiProvider(config: GeminiConfig): {
  chatProvider: ChatProvider;
  embeddingsProvider: EmbeddingsProvider;
} {
  return createOpenAICompatiblePair({
    providerName: "gemini",
    apiKey: config.apiKey,
    baseURL: GEMINI_OPENAI_COMPATIBLE_BASE_URL,
    chatModel: config.chatModel,
    embeddingModel: config.embeddingModel,
  });
}
