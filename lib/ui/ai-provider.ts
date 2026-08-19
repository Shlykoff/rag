// lib/ui/ai-provider.ts
//
// Display-only mapping of AI_PROVIDER -> a human label, for the "работает
// на: ..." footer badge (CLAUDE.md: "ненавязчиво показать, какой
// AI-провайдер сейчас активен ... это часть продающей истории"). Reads
// process.env.AI_PROVIDER directly rather than importing lib/ai/index.ts's
// getAIProviders(): that factory throws if the matching *_API_KEY is
// missing (e.g. no real keys provisioned yet in this environment -- see
// task context), which would take down page rendering just to show a
// label. This module never constructs a provider client and never touches
// an API key, so it can render even when getAIProviders() would throw.
//
// Only ever called from Server Components (the value is read at render
// time on the server and baked into the returned HTML/RSC payload as
// plain text) -- never imported into a "use client" module.

export type SupportedAIProvider = "openai" | "anthropic" | "gemini";

const LABELS: Record<SupportedAIProvider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic Claude (+ Voyage AI для embeddings)",
  gemini: "Google Gemini",
};

export interface ActiveAIProviderInfo {
  raw: string | undefined;
  recognized: boolean;
  label: string;
}

/** Never throws -- an unset/invalid AI_PROVIDER renders as "не настроен", not a crashed page. */
export function getActiveAIProviderInfo(): ActiveAIProviderInfo {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw === "openai" || raw === "anthropic" || raw === "gemini") {
    return { raw, recognized: true, label: LABELS[raw] };
  }
  return { raw, recognized: false, label: "не настроен" };
}
