// lib/ai/index.ts
//
// THE boundary for AI-provider selection. Every other module in this
// project (ingestion, retrieval, API routes) imports `getAIProviders()`
// (or the narrower `getChatProvider()`/`getEmbeddingsProvider()`) from
// here -- never a concrete adapter from lib/ai/providers/, and never a
// vendor SDK directly (CLAUDE.md rule 4).
//
// AI_PROVIDER selects a *pair*: anthropic has no embeddings API of its own,
// so AI_PROVIDER=anthropic always pairs AnthropicChatProvider with
// VoyageEmbeddingsProvider -- this pairing is fixed by this factory, not a
// separate env var, so it's impossible to misconfigure "anthropic chat +
// openai embeddings" by accident.

import { AnthropicChatProvider } from "./providers/anthropic";
import { OpenAICompatibleProvider } from "./providers/openai";
import { VoyageEmbeddingsProvider } from "./providers/voyage";
import { createGeminiProvider } from "./providers/gemini";
import type { AIProviderPair } from "./types";

export type SupportedAIProvider = "openai" | "anthropic" | "gemini";

/** Default models per provider -- see README "Model defaults" for the price/quality rationale. Overridable via env so a demo deploy can swap models without a code change. */
const DEFAULT_MODELS: Record<
  SupportedAIProvider,
  { chat: string; embedding: string }
> = {
  openai: { chat: "gpt-4.1-mini", embedding: "text-embedding-3-small" },
  anthropic: { chat: "claude-sonnet-4-5", embedding: "voyage-3-large" },
  gemini: { chat: "gemini-3.6-flash", embedding: "gemini-embedding-001" },
};

function readProviderEnv(): SupportedAIProvider {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw === "openai" || raw === "anthropic" || raw === "gemini") return raw;
  throw new Error(
    `Invalid or missing AI_PROVIDER env var (got: ${JSON.stringify(
      process.env.AI_PROVIDER
    )}). Expected one of: 'openai' | 'anthropic' | 'gemini'. See .env.example.`
  );
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name} for the active AI_PROVIDER. See .env.example.`
    );
  }
  return value;
}

function buildProviders(provider: SupportedAIProvider): AIProviderPair {
  switch (provider) {
    case "openai": {
      const shared = new OpenAICompatibleProvider({
        apiKey: requireEnv("OPENAI_API_KEY"),
        chatModel: process.env.OPENAI_CHAT_MODEL || DEFAULT_MODELS.openai.chat,
        embeddingModel:
          process.env.OPENAI_EMBEDDING_MODEL || DEFAULT_MODELS.openai.embedding,
      });
      return { chatProvider: shared, embeddingsProvider: shared };
    }
    case "anthropic": {
      return {
        chatProvider: new AnthropicChatProvider({
          apiKey: requireEnv("ANTHROPIC_API_KEY"),
          chatModel:
            process.env.ANTHROPIC_CHAT_MODEL || DEFAULT_MODELS.anthropic.chat,
        }),
        // Anthropic has no embeddings API -- Voyage is the fixed pairing,
        // not independently configurable via AI_PROVIDER.
        embeddingsProvider: new VoyageEmbeddingsProvider({
          apiKey: requireEnv("VOYAGE_API_KEY"),
          embeddingModel:
            process.env.VOYAGE_EMBEDDING_MODEL ||
            DEFAULT_MODELS.anthropic.embedding,
        }),
      };
    }
    case "gemini": {
      const shared = createGeminiProvider({
        apiKey: requireEnv("GEMINI_API_KEY"),
        chatModel: process.env.GEMINI_CHAT_MODEL || DEFAULT_MODELS.gemini.chat,
        embeddingModel:
          process.env.GEMINI_EMBEDDING_MODEL || DEFAULT_MODELS.gemini.embedding,
      });
      return { chatProvider: shared, embeddingsProvider: shared };
    }
  }
}

// Providers are cheap to construct (no network calls in any constructor
// above) but we still memoize per-process so every caller within one
// server instance shares the same client (connection pooling, etc.), and
// so a missing API key throws once at first use with a clear error rather
// than silently reconstructing.
let cached: AIProviderPair | undefined;

/** The single entry point the rest of the app should use. Reads AI_PROVIDER (and the matching *_API_KEY) from process.env on first call. */
export function getAIProviders(): AIProviderPair {
  if (!cached) {
    cached = buildProviders(readProviderEnv());
  }
  return cached;
}

export function getChatProvider() {
  return getAIProviders().chatProvider;
}

export function getEmbeddingsProvider() {
  return getAIProviders().embeddingsProvider;
}

/** Test-only: clears the memoized provider pair so tests can re-invoke getAIProviders() under different env vars / mocks. Not used by application code. */
export function __resetAIProviderCacheForTests(): void {
  cached = undefined;
}

export type { ChatProvider, EmbeddingsProvider, AIProviderPair, ChatMessage, ChatStreamResult, TokenUsage } from "./types";
export { AIProviderError, normalizeProviderError } from "./errors";
