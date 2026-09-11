// lib/ui/provider-metadata.ts
//
// Client-safe display info for the AI providers a project can use, shared
// by components/projects/ModelPicker.tsx and components/profile/*. The
// canonical registries live in lib/ai/index.ts (server-only -- they hold the
// adapter constructors); only type-only imports from "@/lib/ai" here, so
// nothing server-only reaches a "use client" bundle.

import type { ActiveAIProvider, AIProviderCredentialType, EmbeddingProviderType } from "@/lib/ai";

export interface ProviderDisplayInfo {
  label: string;
  /** Credentials an account needs for this chat provider to be usable. */
  requiresCredentials: AIProviderCredentialType[];
}

export const PROVIDER_DISPLAY_INFO: Record<ActiveAIProvider, ProviderDisplayInfo> = {
  openai: { label: "OpenAI", requiresCredentials: ["openai"] },
  anthropic: { label: "Anthropic Claude", requiresCredentials: ["anthropic"] },
  gemini: { label: "Google Gemini", requiresCredentials: ["gemini"] },
};

/** Stable display order for the chat providers. */
export const PROVIDER_DISPLAY_ORDER: ActiveAIProvider[] = ["openai", "anthropic", "gemini"];

/** Embedding models a project can pick -- each needs only its own provider's key. Model names match lib/ai/index.ts's defaults. */
export const EMBEDDING_PROVIDER_DISPLAY_INFO: Record<EmbeddingProviderType, { label: string; model: string }> = {
  openai: { label: "OpenAI", model: "text-embedding-3-small" },
  gemini: { label: "Google Gemini", model: "gemini-embedding-001" },
  voyage: { label: "Voyage AI", model: "voyage-3-large" },
};

export const EMBEDDING_PROVIDER_DISPLAY_ORDER: EmbeddingProviderType[] = ["openai", "gemini", "voyage"];
