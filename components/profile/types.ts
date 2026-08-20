// components/profile/types.ts
//
// Shared view-model types for the /profile page's client components,
// matching app/api/profile/ai-providers/route.ts's GET response shape
// exactly (see that route's header comment for the full wire contract).
// Type-only imports from "@/lib/ai" -- same pattern already established by
// components/chat/types.ts importing `ContextSource` (type-only) from
// lib/retrieval/search.ts, and by components/chat/ChatView.tsx importing
// `ChatStreamEvent` (type-only) from lib/chat/handle-chat-request.ts: this
// is erased at compile time, so nothing from lib/ai/'s runtime (including
// its "server-only"-guarded modules, lib/ai/crypto.ts/credentials.ts) ever
// ends up in the client bundle.

import type { AIProviderCredentialType, ActiveAIProvider } from "@/lib/ai";

export type { AIProviderCredentialType, ActiveAIProvider };

/** Matches GET's `configured` object exactly -- one boolean per storable credential, including 'voyage' (never itself an active provider, but its own configured/not-configured slot in the Anthropic section). */
export type ConfiguredFlags = Record<AIProviderCredentialType, boolean>;
