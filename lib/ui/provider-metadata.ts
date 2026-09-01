// lib/ui/provider-metadata.ts
//
// Single frontend source of truth for two facts about each
// ActiveAIProvider: its display label, and which credential(s) an account
// needs configured before that provider is usable ('anthropic' uniquely
// also needs 'voyage', since Anthropic has no embeddings API of its own --
// see lib/ai/index.ts's PROVIDER_REGISTRY). Shared by
// components/projects/ModelPicker.tsx, components/profile/
// ActiveProviderSection.tsx, and components/profile/ProfileForm.tsx so
// they can't drift from each other.
//
// The canonical source is still lib/ai/index.ts's PROVIDER_REGISTRY
// (server-only -- it holds the actual adapter constructors, not just
// labels). Only a type-only import from "@/lib/ai" here (erased at compile
// time) -- no runtime/value import, so nothing server-only reaches a "use
// client" bundle through this module.

import type { ActiveAIProvider, AIProviderCredentialType } from "@/lib/ai";

export interface ProviderDisplayInfo {
  label: string;
  /** Every credential type that must be configured for this provider to be usable. Always includes the provider's own id, plus 'voyage' for 'anthropic' (its fixed, non-optional embeddings pairing). */
  requiresCredentials: AIProviderCredentialType[];
}

export const PROVIDER_DISPLAY_INFO: Record<ActiveAIProvider, ProviderDisplayInfo> = {
  openai: { label: "OpenAI", requiresCredentials: ["openai"] },
  anthropic: {
    label: "Anthropic Claude (+ Voyage AI для embeddings)",
    requiresCredentials: ["anthropic", "voyage"],
  },
  gemini: { label: "Google Gemini", requiresCredentials: ["gemini"] },
};

/** Stable display order for rendering every provider (openai, anthropic, gemini) -- `Object.keys()` on the map above would work too, but this makes the order an explicit, reviewable decision rather than incidental object-key iteration order. */
export const PROVIDER_DISPLAY_ORDER: ActiveAIProvider[] = ["openai", "anthropic", "gemini"];
