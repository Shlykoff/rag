// lib/ai/providers/gemini.ts
//
// Deliberate reuse, not a copy-paste mistake: Google publishes an official
// OpenAI-compatible endpoint for chat and embeddings, so Gemini runs through
// the OpenAI-compatible adapter classes (providers/openai.ts) with Google's
// baseURL. No separate Google SDK is used.
//
// Google's docs don't list `dimensions` for the compatible embeddings
// endpoint, but it is honored (mapped to output_dimensionality) -- checked
// live for gemini-embedding-001 and gemini-embedding-2. Should that change,
// embed-batch.ts's per-vector length check fails loudly instead of storing
// vectors of the wrong size. gemini-embedding-001 doesn't normalize vectors
// truncated below 3072; harmless here, retrieval uses cosine distance.

import { OpenAICompatibleChatProvider, OpenAICompatibleEmbeddingsProvider } from "./openai";
import type { ChatProvider, EmbeddingsProvider } from "../types";

export const GEMINI_OPENAI_COMPATIBLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

export function createGeminiChatProvider(config: { apiKey: string; model: string }): ChatProvider {
  return new OpenAICompatibleChatProvider({
    providerName: "gemini",
    baseURL: GEMINI_OPENAI_COMPATIBLE_BASE_URL,
    apiKey: config.apiKey,
    model: config.model,
  });
}

export function createGeminiEmbeddingsProvider(config: {
  apiKey: string;
  model: string;
  dimensions: number;
}): EmbeddingsProvider {
  return new OpenAICompatibleEmbeddingsProvider({
    providerName: "gemini",
    baseURL: GEMINI_OPENAI_COMPATIBLE_BASE_URL,
    apiKey: config.apiKey,
    model: config.model,
    dimensions: config.dimensions,
  });
}
