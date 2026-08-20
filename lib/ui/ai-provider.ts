// lib/ui/ai-provider.ts
//
// Display-only mapping of AI_PROVIDER -> a human label, for the "работает
// на: ..." footer badge (CLAUDE.md: "ненавязчиво показать, какой
// AI-провайдер сейчас активен ... это часть продающей истории"). Reads
// process.env.AI_PROVIDER directly and only imports lib/ai/index.ts's
// SUPPORTED_AI_PROVIDERS/getProviderLabel -- never getAIProviders() itself,
// which throws if the matching *_API_KEY is missing (e.g. no real keys
// provisioned yet in this environment -- see task context). Importing just
// the provider *list* is safe: lib/ai/index.ts's provider adapters have no
// top-level side effects, so this never touches an API key and can render
// even when getAIProviders() would throw.
//
// The provider list/labels themselves live in lib/ai/index.ts's
// PROVIDER_REGISTRY, not a second copy here -- adding a provider there is
// what makes it show up correctly in this badge too, automatically.
//
// Only ever called from Server Components (the value is read at render
// time on the server and baked into the returned HTML/RSC payload as
// plain text) -- never imported into a "use client" module.

import { SUPPORTED_AI_PROVIDERS, getProviderLabel, type SupportedAIProvider } from "@/lib/ai";

export type { SupportedAIProvider };

export interface ActiveAIProviderInfo {
  raw: string | undefined;
  recognized: boolean;
  label: string;
}

/** Never throws -- an unset/invalid AI_PROVIDER renders as "не настроен", not a crashed page. */
export function getActiveAIProviderInfo(): ActiveAIProviderInfo {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (raw && (SUPPORTED_AI_PROVIDERS as string[]).includes(raw)) {
    return { raw, recognized: true, label: getProviderLabel(raw)! };
  }
  return { raw, recognized: false, label: "не настроен" };
}
