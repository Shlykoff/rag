// lib/ai/providers/gemini.ts
//
// Deliberate reuse, not a copy-paste mistake: Google publishes an official
// OpenAI-compatible endpoint for both chat and embeddings
// (https://generativelanguage.googleapis.com/v1beta/openai/), so this
// adapter constructs the same OpenAICompatibleCore class used for
// AI_PROVIDER=openai, just pointed at Google's baseURL/apiKey/model instead.
// No separate Google SDK is used for chat or text embeddings.

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
 * with independently-correct `modelName`s rather than one dual-interface
 * object). Kept as a thin factory function rather than a subclass since
 * there's no Gemini-specific behavior beyond the constructor config.
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
