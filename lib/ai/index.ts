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
import { createOpenAICompatiblePair } from "./providers/openai";
import { VoyageEmbeddingsProvider } from "./providers/voyage";
import { createGeminiProvider } from "./providers/gemini";
import type { AIProviderPair } from "./types";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required env var ${name} for the active AI_PROVIDER. See .env.example.`
    );
  }
  return value;
}

interface ProviderRegistryEntry {
  /** Human-readable label for the "работает на: ..." UI badge (lib/ui/ai-provider.ts) -- kept next to the construction logic so a new provider's label can't be added in one place and forgotten in the other. */
  label: string;
  build: () => AIProviderPair;
}

/**
 * The single source of truth for "which AI_PROVIDER values exist." Adding
 * a new provider (Grok, Qwen, ...) means: write its adapter(s) in
 * lib/ai/providers/, then add ONE entry here. Nothing else in this file --
 * not the valid-value check, not the error message, not the exported type
 * -- needs a matching edit; they're all derived from this object's keys
 * below, not hand-duplicated.
 */
const PROVIDER_REGISTRY = {
  openai: {
    label: "OpenAI",
    // createOpenAICompatiblePair() returns two distinct, correctly-labeled
    // views (chatProvider.modelName = chat model, embeddingsProvider.modelName
    // = embedding model) sharing one underlying HTTP client -- NOT the same
    // object handed out twice. See providers/openai.ts's OpenAICompatibleCore
    // comment for why a single dual-interface object was the bug here
    // (embeddingsProvider.modelName used to silently read back the chat
    // model, e.g. in document_chunks.embedding_model).
    build: (): AIProviderPair =>
      createOpenAICompatiblePair({
        apiKey: requireEnv("OPENAI_API_KEY"),
        chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      }),
  },
  anthropic: {
    label: "Anthropic Claude (+ Voyage AI для embeddings)",
    // Anthropic has no embeddings API of its own -- Voyage is this
    // provider's fixed pairing, not an independently selectable choice,
    // so it's baked into this one entry rather than a separate env var.
    build: (): AIProviderPair => ({
      chatProvider: new AnthropicChatProvider({
        apiKey: requireEnv("ANTHROPIC_API_KEY"),
        chatModel: process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-4-5",
      }),
      embeddingsProvider: new VoyageEmbeddingsProvider({
        apiKey: requireEnv("VOYAGE_API_KEY"),
        embeddingModel: process.env.VOYAGE_EMBEDDING_MODEL || "voyage-3-large",
      }),
    }),
  },
  gemini: {
    label: "Google Gemini",
    // Same two-views-over-one-client shape as 'openai' above -- see
    // providers/gemini.ts's doc comment.
    build: (): AIProviderPair =>
      createGeminiProvider({
        apiKey: requireEnv("GEMINI_API_KEY"),
        chatModel: process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash",
        embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
      }),
  },
} satisfies Record<string, ProviderRegistryEntry>;

export type SupportedAIProvider = keyof typeof PROVIDER_REGISTRY;

/** Every valid AI_PROVIDER value, derived from the registry -- lib/ui/ai-provider.ts's display badge reads this (and each entry's `label`) instead of keeping its own separate copy of the provider list. */
export const SUPPORTED_AI_PROVIDERS = Object.keys(PROVIDER_REGISTRY) as SupportedAIProvider[];

export function getProviderLabel(provider: string): string | undefined {
  return (PROVIDER_REGISTRY as Record<string, ProviderRegistryEntry>)[provider]?.label;
}

function readProviderEnv(): SupportedAIProvider {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw && (SUPPORTED_AI_PROVIDERS as string[]).includes(raw)) {
    return raw as SupportedAIProvider;
  }
  throw new Error(
    `Invalid or missing AI_PROVIDER env var (got: ${JSON.stringify(
      process.env.AI_PROVIDER
    )}). Expected one of: ${SUPPORTED_AI_PROVIDERS.join(", ")}. See .env.example.`
  );
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
    cached = PROVIDER_REGISTRY[readProviderEnv()].build();
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
