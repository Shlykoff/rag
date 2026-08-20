// lib/ui/ai-provider.ts
//
// Display-only lookup of the signed-in user's active AI provider, for the
// "работает на: ..." footer badge (CLAUDE.md: "ненавязчиво показать, какой
// AI-провайдер сейчас активен ... это часть продающей истории"). Per-user
// now (bring-your-own-key), not a single process-global `AI_PROVIDER` env
// var: this thin wrapper just calls lib/ai/index.ts's
// `getActiveProviderLabel(userId, supabase)`, which already returns
// `null` (never throws) when the user hasn't configured/selected a
// provider yet -- that's rendered as "не настроен" here, same fallback
// text as before this refactor, just driven by a real per-user DB read
// instead of an unset env var.
//
// Only ever called from Server Components (app/(app)/layout.tsx, which
// already has both `user.id` and a request-scoped Supabase client on
// hand) -- never imported into a "use client" module; `getActiveProviderLabel`
// itself does a real Supabase query, so this can't be called at module
// scope or cached across requests/users the way the old env-var read
// could.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getActiveProviderLabel } from "@/lib/ai";

export interface ActiveAIProviderInfo {
  label: string;
}

/** Never throws -- a user with no active provider configured (or not yet signed in to one) renders as "не настроен", not a crashed page. */
export async function getActiveAIProviderInfo(
  userId: string,
  supabase: SupabaseClient
): Promise<ActiveAIProviderInfo> {
  const label = await getActiveProviderLabel(userId, supabase);
  return { label: label ?? "не настроен" };
}
