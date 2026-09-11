// lib/ui/provider-metadata.ts
//
// Client-safe display info for AI providers: labels, display order and what
// a key for each provider enables. Concrete models (names, dimensions,
// prices) are not listed here -- they come from the ai_models catalog via
// GET /api/projects/{id}/model. Only type-only imports from "@/lib/ai", so
// nothing server-only reaches a "use client" bundle.

import type { AIModelKind, AIProviderCredentialType, ActiveAIProvider, EmbeddingProviderType } from "@/lib/ai";

export const PROVIDER_LABELS: Record<AIProviderCredentialType, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude",
  gemini: "Google Gemini",
  voyage: "Voyage AI",
};

/** Display order of every provider that can hold a key (profile page). */
export const ALL_PROVIDER_DISPLAY_ORDER: readonly AIProviderCredentialType[] = ["openai", "anthropic", "gemini", "voyage"];

/** Providers with chat models, in display order. */
export const PROVIDER_DISPLAY_ORDER: readonly ActiveAIProvider[] = ["openai", "anthropic", "gemini"];

/** Providers with embedding models, in display order. */
export const EMBEDDING_PROVIDER_DISPLAY_ORDER: readonly EmbeddingProviderType[] = ["openai", "gemini", "voyage"];

export function providersForKind(kind: AIModelKind): readonly AIProviderCredentialType[] {
  return kind === "chat" ? PROVIDER_DISPLAY_ORDER : EMBEDDING_PROVIDER_DISPLAY_ORDER;
}

export function providerLabel(provider: string): string {
  return (PROVIDER_LABELS as Record<string, string | undefined>)[provider] ?? provider;
}

/** Joins provider labels as "A, B или C". */
export function joinProviderLabels(providers: readonly AIProviderCredentialType[]): string {
  const labels = providers.map((provider) => PROVIDER_LABELS[provider]);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} или ${labels[labels.length - 1]}`;
}

/** What a key for `provider` lets a project use, e.g. "чат и эмбеддинги (поиск по документам)". */
export function describeProviderCapabilities(provider: AIProviderCredentialType): string {
  const chat = PROVIDER_DISPLAY_ORDER.includes(provider as ActiveAIProvider);
  const embedding = EMBEDDING_PROVIDER_DISPLAY_ORDER.includes(provider as EmbeddingProviderType);
  if (chat && embedding) return "чат и эмбеддинги (поиск по документам)";
  if (chat) return "только чат";
  return "только эмбеддинги (поиск по документам)";
}

export type ConfiguredProviders = Record<AIProviderCredentialType, boolean>;

export interface AccountReadiness {
  chat: boolean;
  embedding: boolean;
  /** What to tell the user about the keys saved so far. */
  message: string;
}

/** Whether the saved keys cover both model kinds a project needs. */
export function describeAccountReadiness(configured: ConfiguredProviders): AccountReadiness {
  const chat = PROVIDER_DISPLAY_ORDER.some((provider) => configured[provider]);
  const embedding = EMBEDDING_PROVIDER_DISPLAY_ORDER.some((provider) => configured[provider]);
  let message: string;
  if (chat && embedding) {
    message = "Ключей хватает и для чата, и для поиска по документам. Модели выбираются в каждом проекте отдельно.";
  } else if (chat) {
    message = `Для поиска по документам (эмбеддингов) нужен ещё ключ ${joinProviderLabels(EMBEDDING_PROVIDER_DISPLAY_ORDER)}.`;
  } else if (embedding) {
    message = `Для ответов в чате нужен ещё ключ ${joinProviderLabels(PROVIDER_DISPLAY_ORDER)}.`;
  } else {
    message = "Пока не сохранён ни один ключ. Проекту нужны модель чата и модель эмбеддингов — например, одного ключа OpenAI или Gemini хватит на обе.";
  }
  return { chat, embedding, message };
}
