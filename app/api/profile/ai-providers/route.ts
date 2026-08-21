// app/api/profile/ai-providers/route.ts
//
// Bring-your-own-key: lets the signed-in user store/remove their own,
// account-level AI provider API keys (encrypted at rest, lib/ai/crypto.ts
// -- see ai_provider_credentials' migration header). Owned by
// rag-pipeline-specialist (not nextjs-frontend) because it's a thin layer
// directly on top of lib/ai/credentials.ts, the same division of labor as
// document-sources-specialist owning app/api/sources/credentials/route.ts
// on top of lib/sources/credentials.ts -- nextjs-frontend's /profile page
// only ever calls this route, never lib/ai/credentials.ts directly.
//
// PROJECTS PIVOT NOTE: this route used to also expose "pick the active
// provider" (a PUT method + an `activeProvider` field on GET/POST), back
// when `active_ai_provider` was a per-USER setting (`user_settings`). That
// column has moved to `projects.active_ai_provider` (per-PROJECT now, see
// the projects migration's header) -- CLAUDE.md's explicit split is
// "connect a provider" is an ACCOUNT-level action (this route, unchanged
// role), "which connected provider a given PROJECT uses" is a PROJECT-level
// selection, which belongs on a project-scoped route/screen
// (`/projects/[projectId]/model`, nextjs-frontend's Stage C) that has an
// actual `projectId` + `ownerUserId` pair to hand to
// lib/ai/credentials.ts's now project-scoped `getActiveProvider`/
// `setActiveProvider`. This account-level route has neither, so the PUT
// method and every `activeProvider`/auto-activation concern are removed
// here rather than faked against a made-up project id.
//
// The plaintext API key is never echoed back in any response, logged, or
// exposed to the client after a save -- GET only returns booleans ("is
// openai configured"), never a key value or an active-provider selection.
//
// Request contract:
//   GET /api/profile/ai-providers
//   -> 401 { error: "unauthorized" }
//   -> 200 { configured: { openai: boolean, anthropic: boolean, gemini: boolean, voyage: boolean } }
//
//   POST /api/profile/ai-providers
//   body: { provider: "openai" | "anthropic" | "gemini" | "voyage", apiKey: string }
//     Every provider (including 'voyage') is saved through this exact same
//     { provider, apiKey } body, keeping this endpoint's request shape
//     uniform -- the frontend's "Anthropic (+ Voyage)" form section makes
//     two POST calls, one per key, the same way it already needs two GET
//     `configured` flags to show two independent statuses.
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 200 { status: "saved" }
//
//   DELETE /api/profile/ai-providers
//   body: { provider: "openai" | "anthropic" | "gemini" | "voyage" }
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 200 { status: "deleted" }
//     Note: deleting a credential that some project currently points its
//     `active_ai_provider` at does NOT clear that project's selection here
//     -- lib/ai/index.ts's getAIProviders() already treats "active provider
//     set, but its credential is gone" the same as "no active provider at
//     all" (a clean 422 on the next chat request, see app/api/chat/route.ts),
//     so there is no separate broken state for this route to additionally
//     guard against.
//
// Rate limiting: every state-changing method (POST/DELETE) is checked
// against lib/rate-limit/ai-credentials-rate-limiter.ts BEFORE touching
// encryption/the DB -- see that module's header for why this is a small,
// dedicated in-memory limiter (not the usage_events-backed chat limiter,
// not source-ingest-rate-limiter.ts's bucket) rather than unrated. GET is
// read-only and not rate-limited, same as app/api/sources/credentials'
// GET.

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import {
  saveAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  type AIProviderCredentialType,
} from "@/lib/ai";
import {
  checkAICredentialsRateLimit,
  type AICredentialsRateLimitResult,
} from "@/lib/rate-limit/ai-credentials-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALL_CREDENTIAL_PROVIDERS: AIProviderCredentialType[] = ["openai", "anthropic", "gemini", "voyage"];
const ProviderTypeSchema = z.enum(["openai", "anthropic", "gemini", "voyage"]);

const PostBodySchema = z.object({
  provider: ProviderTypeSchema,
  apiKey: z.string().min(1, "apiKey must not be empty"),
});

const DeleteBodySchema = z.object({
  provider: ProviderTypeSchema,
});

function rateLimitedResponse(rateLimit: Pick<AICredentialsRateLimitResult, "retryAfterMs">): Response {
  return Response.json(
    {
      error: "rate_limited",
      message: "Слишком много запросов к настройкам AI-провайдера. Попробуйте через несколько секунд.",
      retryAfterMs: rateLimit.retryAfterMs,
    },
    { status: 429, headers: { "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)) } }
  );
}

async function parseJsonBody<T>(request: Request, schema: z.ZodType<T>): Promise<{ data: T } | { errorResponse: Response }> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return { errorResponse: Response.json({ error: "invalid_request", details: "Body must be valid JSON." }, { status: 400 }) };
  }
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    return { errorResponse: Response.json({ error: "invalid_request", details: parsed.error.flatten() }, { status: 400 }) };
  }
  return { data: parsed.data };
}

export async function GET(): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getServiceRoleClient();
  const configuredFlags = await Promise.all(ALL_CREDENTIAL_PROVIDERS.map((p) => hasAIProviderCredential(supabase, user.id, p)));
  const configured = Object.fromEntries(
    ALL_CREDENTIAL_PROVIDERS.map((p, i) => [p, configuredFlags[i]])
  ) as Record<AIProviderCredentialType, boolean>;

  return Response.json({ configured }, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Checked before any parsing/encryption/DB work, per this route's own
  // module-header contract and CLAUDE.md rule 4's "on the server, before
  // doing the work" principle.
  const rateLimit = checkAICredentialsRateLimit(user.id);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const parsed = await parseJsonBody(request, PostBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  await saveAIProviderCredential(supabase, user.id, parsed.data.provider, parsed.data.apiKey);
  return Response.json({ status: "saved" }, { status: 200 });
}

export async function DELETE(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const rateLimit = checkAICredentialsRateLimit(user.id);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const parsed = await parseJsonBody(request, DeleteBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  await deleteAIProviderCredential(supabase, user.id, parsed.data.provider);
  return Response.json({ status: "deleted" }, { status: 200 });
}
