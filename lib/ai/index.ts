// lib/ai/index.ts
//
// THE boundary for AI-provider selection. Every other module in this
// project (ingestion, retrieval, API routes) imports `getAIProviders()`
// (or the narrower `getEmbeddingsProvider()`) from here -- never a concrete
// adapter from lib/ai/providers/, and never a vendor SDK directly
// (CLAUDE.md rule 4).
//
// Bring-your-own-key: the provider pair returned here is per-USER, not
// process-global. Each signed-in user picks one active provider
// (`user_settings.active_ai_provider`) and supplies their own encrypted API
// key(s) (`ai_provider_credentials`, see lib/ai/credentials.ts) via
// app/api/profile/ai-providers/route.ts. There is no more `AI_PROVIDER`/
// `*_API_KEY` env-var-driven global default for the running app -- those
// env vars still exist in .env.example, but their only remaining purpose is
// feeding scripts/seed-ai-credentials.ts (`npm run seed:ai-keys`), which
// seeds the *demo account's* row in these same per-user tables from
// .env.local at setup time. See that script's header and README "Running
// locally" for why skipping it breaks the demo account exactly like an
// unconfigured real user.
//
// anthropic has no embeddings API of its own, so activating 'anthropic'
// always pairs AnthropicChatProvider with VoyageEmbeddingsProvider -- this
// pairing is fixed by this factory (and by setActiveProvider()'s own
// validation, see lib/ai/credentials.ts), not a separate selectable value,
// so it's impossible to misconfigure "anthropic chat + openai embeddings"
// by accident.

import type { SupabaseClient } from "@supabase/supabase-js";
import { AnthropicChatProvider } from "./providers/anthropic";
import { createOpenAICompatiblePair } from "./providers/openai";
import { VoyageEmbeddingsProvider } from "./providers/voyage";
import { createGeminiProvider } from "./providers/gemini";
import type { AIProviderPair } from "./types";
import { AIProviderError } from "./errors";
import { getActiveProvider, getAIProviderCredential, type AIProviderCredentialType } from "./credentials";

/**
 * Loads one provider's decrypted API key for `userId`, or throws a
 * normalized AIProviderError{kind:"no_credentials"} if it isn't stored.
 * This is the async, per-user replacement for the old `requireEnv(name)`
 * helper -- same "fail loudly and clearly, right where the key is needed"
 * shape, but reading from ai_provider_credentials instead of process.env.
 *
 * The "credential row missing" case this guards against isn't just
 * theoretical: `active_ai_provider` can point at a provider whose
 * credential(s) were deleted after being made active (deleteAIProviderCredential()
 * deliberately does not clear active_ai_provider on delete -- see that
 * function's comment) -- so this check has to happen on every call, not
 * just once via getActiveProvider().
 */
async function requireCredential(
  supabase: SupabaseClient,
  userId: string,
  provider: AIProviderCredentialType
): Promise<string> {
  const apiKey = await getAIProviderCredential(supabase, userId, provider);
  if (!apiKey) {
    throw new AIProviderError({
      provider: "none",
      kind: "no_credentials",
      retryable: false,
      // Internal/log message only -- never shown to the end user (see
      // AIProviderErrorInit's own field comments). Safe to be this
      // specific since it never reaches a response body.
      message: `getAIProviders: user ${userId} has no stored '${provider}' credential.`,
      userMessage:
        "Добавьте свой API-ключ AI-провайдера в профиле, чтобы начать общаться с ассистентом.",
    });
  }
  return apiKey;
}

interface ProviderRegistryEntry {
  /** Human-readable label for the "работает на: ..." UI badge (lib/ui/ai-provider.ts, via getActiveProviderLabel() below) -- kept next to the construction logic so a new provider's label can't be added in one place and forgotten in the other. */
  label: string;
  build: (userId: string, supabase: SupabaseClient) => Promise<AIProviderPair>;
}

/**
 * The single source of truth for "which active-provider values exist."
 * Adding a new provider (Grok, Qwen, ...) means: write its adapter(s) in
 * lib/ai/providers/, add its 'ai_provider_type' enum value (db-architect's
 * call), then add ONE entry here. Nothing else in this file -- not the
 * exported type, not lib/ai/credentials.ts's validation -- needs a
 * matching edit; they're all derived from this object's keys below, not
 * hand-duplicated.
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
    build: async (userId, supabase): Promise<AIProviderPair> =>
      createOpenAICompatiblePair({
        apiKey: await requireCredential(supabase, userId, "openai"),
        chatModel: process.env.OPENAI_CHAT_MODEL || "gpt-4.1-mini",
        embeddingModel: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      }),
  },
  anthropic: {
    label: "Anthropic Claude (+ Voyage AI для embeddings)",
    // Anthropic has no embeddings API of its own -- Voyage is this
    // provider's fixed pairing, not an independently selectable choice, so
    // both credentials are required here (setActiveProvider() already
    // refuses to make 'anthropic' active without both -- see
    // lib/ai/credentials.ts -- but this fetches them independently rather
    // than trusting that invariant still holds, per requireCredential()'s
    // own comment on credentials being deletable after activation).
    build: async (userId, supabase): Promise<AIProviderPair> => {
      const [anthropicKey, voyageKey] = await Promise.all([
        requireCredential(supabase, userId, "anthropic"),
        requireCredential(supabase, userId, "voyage"),
      ]);
      return {
        chatProvider: new AnthropicChatProvider({
          apiKey: anthropicKey,
          chatModel: process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-4-5",
        }),
        embeddingsProvider: new VoyageEmbeddingsProvider({
          apiKey: voyageKey,
          embeddingModel: process.env.VOYAGE_EMBEDDING_MODEL || "voyage-3-large",
        }),
      };
    },
  },
  gemini: {
    label: "Google Gemini",
    // Same two-views-over-one-client shape as 'openai' above -- see
    // providers/gemini.ts's doc comment.
    build: async (userId, supabase): Promise<AIProviderPair> =>
      createGeminiProvider({
        apiKey: await requireCredential(supabase, userId, "gemini"),
        chatModel: process.env.GEMINI_CHAT_MODEL || "gemini-3.6-flash",
        embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || "gemini-embedding-001",
      }),
  },
} satisfies Record<string, ProviderRegistryEntry>;

export type SupportedAIProvider = keyof typeof PROVIDER_REGISTRY;

/** Every valid active-provider value, derived from the registry -- lib/ui/ai-provider.ts's display badge and app/api/profile/ai-providers/route.ts's request validation both read this (and each entry's `label`) instead of keeping a separate copy of the provider list. Deliberately the same three values as lib/ai/credentials.ts's ActiveAIProvider type (excludes 'voyage', which is a real, independently-storable credential but never an activatable provider on its own). */
export const SUPPORTED_AI_PROVIDERS = Object.keys(PROVIDER_REGISTRY) as SupportedAIProvider[];

export function getProviderLabel(provider: string): string | undefined {
  return (PROVIDER_REGISTRY as Record<string, ProviderRegistryEntry>)[provider]?.label;
}

/**
 * The single entry point the rest of the app should use to get a working
 * {chatProvider, embeddingsProvider} pair for one request. Looks up
 * `userId`'s active provider (lib/ai/credentials.ts's getActiveProvider())
 * and, if set, builds that provider's adapter pair using `userId`'s own
 * stored, decrypted API key(s).
 *
 * Throws AIProviderError{kind:"no_credentials"} (never a bare Error) if the
 * user has no active provider set, or if their active provider's
 * credential(s) are missing -- app/api/chat/route.ts special-cases exactly
 * this kind to return a clean 422 (see that route's header comment), and
 * lib/ingestion/ingest.ts's ingestDocumentWithDefaultProviders() catches it
 * to flip the document to processing_status: 'error' with a clear message,
 * same as any other AIProviderError.
 *
 * Deliberately NOT memoized/cached (an earlier, pre-bring-your-own-key
 * version of this function cached one process-wide provider pair -- see
 * git history). Adapter construction is still cheap and side-effect-free
 * (no network calls in any constructor, same as before), and that's exactly
 * what makes a per-user cache not worth it: a keyed-by-userId cache would
 * need explicit invalidation the moment a user rotates or deletes a key
 * (app/api/profile/ai-providers/route.ts's POST/DELETE), and a stale cache
 * entry serving a revoked/rotated key -- or another user's warm entry,
 * indexed correctly but never invalidated -- is a worse bug surface than
 * reconstructing a cheap object on every call.
 */
export async function getAIProviders(userId: string, supabase: SupabaseClient): Promise<AIProviderPair> {
  const active = await getActiveProvider(supabase, userId);
  if (!active) {
    throw new AIProviderError({
      provider: "none",
      kind: "no_credentials",
      retryable: false,
      message: `getAIProviders: user ${userId} has no active_ai_provider set.`,
      userMessage:
        "Добавьте и выберите AI-провайдера в профиле, чтобы начать общаться с ассистентом.",
    });
  }
  return PROVIDER_REGISTRY[active].build(userId, supabase);
}

/**
 * Narrower call for lib/ingestion/ingest.ts, which only ever needs the
 * embeddings half (ingestion never generates a chat completion) -- kept
 * instead of making every ingest call site destructure the full pair and
 * discard `chatProvider`. (The old `getChatProvider()` counterpart was
 * dropped: grepping the repo turned up zero callers of it outside this
 * file, i.e. dead code, not something any current route/pipeline needs a
 * narrowed chat-only accessor for.)
 */
export async function getEmbeddingsProvider(userId: string, supabase: SupabaseClient) {
  return (await getAIProviders(userId, supabase)).embeddingsProvider;
}

/**
 * For the "Работает на: ..." sidebar badge (nextjs-frontend's
 * lib/ui/ai-provider.ts, called from a Server Component) -- returns the
 * signed-in user's active provider's display label, or null if they haven't
 * configured one yet (renders as "не настроен", same as today). Never
 * throws: unlike getAIProviders(), a badge has no fallback "show an error"
 * UI to fall back to, so "no active provider" is just represented as null,
 * not an exception to catch on every page render.
 */
export async function getActiveProviderLabel(userId: string, supabase: SupabaseClient): Promise<string | null> {
  const active = await getActiveProvider(supabase, userId);
  if (!active) return null;
  return getProviderLabel(active) ?? null;
}

export type { ChatProvider, EmbeddingsProvider, AIProviderPair, ChatMessage, ChatStreamResult, TokenUsage } from "./types";
export { AIProviderError, normalizeProviderError } from "./errors";
export type { AIProviderCredentialType, ActiveAIProvider } from "./credentials";
export {
  saveAIProviderCredential,
  getAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  MissingProviderCredentialsError,
} from "./credentials";
