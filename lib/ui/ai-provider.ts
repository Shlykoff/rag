// lib/ui/ai-provider.ts
//
// STAGE-BOUNDARY NOTE (projects architecture pivot): `active_ai_provider`
// moved off the per-user `user_settings` table onto per-PROJECT
// `projects.active_ai_provider` (see lib/ai/index.ts's
// `getActiveProviderLabel(projectId, supabase)`). The sidebar footer that
// calls this helper (app/(app)/layout.tsx -> Sidebar.tsx) has no project in
// scope yet -- the app shell is still the pre-Stage-C flat layout, before
// nextjs-frontend restructures routing around
// `/projects/[projectId]/**` (see CLAUDE.md's Stage C). Rather than guess
// at "the" project for a multi-project account, this badge is downgraded,
// for this stage only, to "does this account have ANY AI-provider
// credential connected at all" -- a real per-PROJECT "работает на: X"
// badge belongs on the `/projects/[projectId]/**` shell nextjs-frontend
// builds next. Flagged explicitly in this task's report, not silently
// changed.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { hasAIProviderCredential, type AIProviderCredentialType } from "@/lib/ai";

export interface ActiveAIProviderInfo {
  label: string;
}

const ALL_CREDENTIAL_PROVIDERS: AIProviderCredentialType[] = ["openai", "anthropic", "gemini", "voyage"];

/** Never throws -- an account with no AI-provider credential connected yet renders as "не настроен", not a crashed page. See this file's header for why this no longer reports a specific per-project active provider. */
export async function getActiveAIProviderInfo(
  userId: string,
  supabase: SupabaseClient
): Promise<ActiveAIProviderInfo> {
  const configuredFlags = await Promise.all(
    ALL_CREDENTIAL_PROVIDERS.map((p) => hasAIProviderCredential(supabase, userId, p))
  );
  const hasAny = configuredFlags.some(Boolean);
  return { label: hasAny ? "ключ подключён" : "не настроен" };
}
