// components/profile/types.ts
//
// Shared view-model types for the /profile page's client components,
// matching app/api/profile/ai-providers/route.ts's GET response shape.
// Type-only imports from "@/lib/ai" (erased at compile time, same pattern
// as components/chat/types.ts) so nothing from lib/ai/'s
// "server-only"-guarded modules ever ends up in the client bundle.

import type { AIProviderCredentialType, ActiveAIProvider } from "@/lib/ai";

export type { AIProviderCredentialType, ActiveAIProvider };

/** Matches GET's `configured` object exactly -- one boolean per storable credential, including 'voyage' (never itself an active provider, but its own configured/not-configured slot in the Anthropic section). */
export type ConfiguredFlags = Record<AIProviderCredentialType, boolean>;
