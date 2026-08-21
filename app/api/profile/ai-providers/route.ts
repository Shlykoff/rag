// app/api/profile/ai-providers/route.ts
//
// Bring-your-own-key: lets the signed-in user store/remove their own AI
// provider API keys (encrypted at rest, lib/ai/crypto.ts -- see
// ai_provider_credentials' migration header) and choose which one is
// active for their own chat/ingestion requests (lib/ai/index.ts's
// getAIProviders() reads exactly what this route writes). Owned by
// rag-pipeline-specialist (not nextjs-frontend) because it's a thin layer
// directly on top of lib/ai/credentials.ts, the same division of labor as
// document-sources-specialist owning app/api/sources/credentials/route.ts
// on top of lib/sources/credentials.ts -- nextjs-frontend's /profile page
// (a later stage) only ever calls this route, never lib/ai/credentials.ts
// directly.
//
// The plaintext API key is never echoed back in any response, logged, or
// exposed to the client after a save -- GET only returns booleans ("is
// openai configured") plus the current active provider, never a key value.
//
// Request contract:
//   GET /api/profile/ai-providers
//   -> 401 { error: "unauthorized" }
//   -> 200 { configured: { openai: boolean, anthropic: boolean, gemini: boolean, voyage: boolean }, activeProvider: "openai" | "anthropic" | "gemini" | null }
//
//   POST /api/profile/ai-providers
//   body: { provider: "openai" | "anthropic" | "gemini" | "voyage", apiKey: string }
//     'anthropic' needs BOTH an 'anthropic' key (chat) AND a 'voyage' key
//     (embeddings -- Anthropic has no embeddings API of its own, see
//     lib/ai/index.ts) before it can be made active. There is deliberately
//     no single "two keys in one body" shape for that pairing: every
//     provider (including 'voyage') is saved through this exact same
//     { provider, apiKey } body, keeping this endpoint's request shape
//     uniform instead of special-casing anthropic's body -- the frontend's
//     "Anthropic (+ Voyage)" form section (a later stage) just makes two
//     POST calls, one per key, the same way it already needs two GET
//     `configured` flags to show two independent statuses.
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 200 { status: "saved", activeProvider: "openai" | "anthropic" | "gemini" | null }
//     `activeProvider` is the up-to-date value of `user_settings.active_ai_provider`
//     AFTER this save -- almost always unchanged, EXCEPT: if the user had no
//     active provider at all yet (activeProvider was null) and this save just
//     completed a provider (openai/gemini: their own key; anthropic: this was
//     the second of its two required keys, anthropic+voyage, to arrive), that
//     provider is auto-activated right here, with no separate PUT required.
//     See maybeAutoActivateProvider() below for the exact rule -- this exists
//     specifically so a brand-new user isn't stuck on "no active_ai_provider
//     set" after saving their first (and only) key, which previously required
//     an extra, easy-to-miss manual radio-button click in "Активный
//     провайдер" below. Once a user has ANY active provider, further POSTs
//     never change it automatically -- only PUT does.
//
//   DELETE /api/profile/ai-providers
//   body: { provider: "openai" | "anthropic" | "gemini" | "voyage" }
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 200 { status: "deleted" }
//     Note: deleting a credential that is currently the active provider does
//     NOT clear `activeProvider` here -- lib/ai/index.ts's getAIProviders()
//     already treats "active provider set, but its credential is gone" the
//     same as "no active provider at all" (a clean 422 on the next chat
//     request, see app/api/chat/route.ts), so there is no separate broken
//     state for this route to additionally guard against.
//
//   PUT /api/profile/ai-providers  (sets the active provider)
//   body: { activeProvider: "openai" | "anthropic" | "gemini" }
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details } — malformed body
//   -> 400 { error: "missing_credentials", message } — the requested
//      provider (or, for anthropic, one of its two required credentials)
//      hasn't been saved yet; `message` names which one(s) are missing.
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 200 { status: "saved", activeProvider }
//
// Rate limiting: every state-changing method (POST/DELETE/PUT) is checked
// against lib/rate-limit/ai-credentials-rate-limiter.ts BEFORE touching
// encryption/the DB -- see that module's header for why this is a small,
// dedicated in-memory limiter (not the usage_events-backed chat limiter,
// not source-ingest-rate-limiter.ts's bucket) rather than unrated. GET is
// read-only and not rate-limited, same as app/api/sources/credentials'
// GET.

import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import {
  saveAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  MissingProviderCredentialsError,
  type AIProviderCredentialType,
  type ActiveAIProvider,
} from "@/lib/ai";
import {
  checkAICredentialsRateLimit,
  type AICredentialsRateLimitResult,
} from "@/lib/rate-limit/ai-credentials-rate-limiter";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ALL_CREDENTIAL_PROVIDERS: AIProviderCredentialType[] = ["openai", "anthropic", "gemini", "voyage"];
const ProviderTypeSchema = z.enum(["openai", "anthropic", "gemini", "voyage"]);
const ActiveProviderSchema = z.enum(["openai", "anthropic", "gemini"]);

const PostBodySchema = z.object({
  provider: ProviderTypeSchema,
  apiKey: z.string().min(1, "apiKey must not be empty"),
});

const DeleteBodySchema = z.object({
  provider: ProviderTypeSchema,
});

const PutBodySchema = z.object({
  activeProvider: ActiveProviderSchema,
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

/**
 * Auto-activates the provider that saving `savedProvider`'s key just
 * completed -- but ONLY if the user has no active provider at all yet (this
 * task's whole point: a brand-new user shouldn't have to separately click a
 * radio button in "Активный провайдер" after saving their first/only key).
 * If the user already has an active provider (non-null), this is a no-op --
 * saving further keys for OTHER providers must never silently steal the
 * active slot; that stays a manual PUT action.
 *
 * 'voyage' has no ActiveAIProvider of its own -- saving a voyage key can
 * only ever complete the 'anthropic' pairing (chat model 'anthropic' +
 * embeddings 'voyage', see lib/ai/index.ts), never become active by itself.
 * openai/gemini are "fully configured" the instant their own single key is
 * saved; anthropic additionally requires a voyage key, so saving *either*
 * half of that pair re-checks both -- whichever key arrives second is the
 * one that flips anthropic over into "fully configured" and triggers this.
 *
 * Always returns the up-to-date active provider (existing, newly
 * auto-activated, or still null) so callers can hand it straight back in
 * their response without a second read.
 */
async function maybeAutoActivateProvider(
  supabase: SupabaseClient,
  userId: string,
  savedProvider: AIProviderCredentialType
): Promise<ActiveAIProvider | null> {
  const current = await getActiveProvider(supabase, userId);
  if (current !== null) return current;

  const candidate: ActiveAIProvider = savedProvider === "voyage" ? "anthropic" : savedProvider;
  const isFullyConfigured =
    candidate === "anthropic"
      ? await Promise.all([
          hasAIProviderCredential(supabase, userId, "anthropic"),
          hasAIProviderCredential(supabase, userId, "voyage"),
        ]).then(([hasAnthropic, hasVoyage]) => hasAnthropic && hasVoyage)
      : true; // openai/gemini only ever need the single key that was just saved.
  if (!isFullyConfigured) return null;

  try {
    // setActiveProvider() re-validates the same credentials itself (see its
    // own doc comment in lib/ai/credentials.ts) -- a deliberate, cheap
    // re-check rather than trusting the boolean computed above, so this
    // stays correct even if a concurrent DELETE raced in between.
    await setActiveProvider(supabase, userId, candidate);
  } catch (err) {
    if (err instanceof MissingProviderCredentialsError) {
      // Lost that race -- don't fail the POST that already successfully
      // saved the credential just because auto-activation didn't pan out;
      // report "still no active provider" and let the user retry manually.
      return null;
    }
    throw err;
  }
  return candidate;
}

export async function GET(): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getServiceRoleClient();
  const [configuredFlags, activeProvider] = await Promise.all([
    Promise.all(ALL_CREDENTIAL_PROVIDERS.map((p) => hasAIProviderCredential(supabase, user.id, p))),
    getActiveProvider(supabase, user.id),
  ]);
  const configured = Object.fromEntries(
    ALL_CREDENTIAL_PROVIDERS.map((p, i) => [p, configuredFlags[i]])
  ) as Record<AIProviderCredentialType, boolean>;

  return Response.json({ configured, activeProvider }, { status: 200 });
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
  const activeProvider = await maybeAutoActivateProvider(supabase, user.id, parsed.data.provider);
  return Response.json({ status: "saved", activeProvider }, { status: 200 });
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

export async function PUT(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const rateLimit = checkAICredentialsRateLimit(user.id);
  if (!rateLimit.allowed) return rateLimitedResponse(rateLimit);

  const parsed = await parseJsonBody(request, PutBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  const activeProvider: ActiveAIProvider = parsed.data.activeProvider;
  try {
    await setActiveProvider(supabase, user.id, activeProvider);
  } catch (err) {
    if (err instanceof MissingProviderCredentialsError) {
      // Expected user error ("you tried to activate something you haven't
      // configured yet"), not a server fault -- see that class's own doc
      // comment in lib/ai/credentials.ts.
      return Response.json({ error: "missing_credentials", message: err.message }, { status: 400 });
    }
    console.error("app/api/profile/ai-providers/route.ts: setActiveProvider failed:", err);
    return Response.json(
      { error: "internal_error", message: "Не удалось сохранить активного AI-провайдера." },
      { status: 500 }
    );
  }
  return Response.json({ status: "saved", activeProvider }, { status: 200 });
}
