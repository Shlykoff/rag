// app/api/projects/[projectId]/channels/telegram/route.ts
//
// Owner-facing management of a PROJECT's Telegram integration
// (`channel_integrations` where channel = 'telegram') -- connect/rotate a
// bot token, check connection status, disconnect. This is the HTTP
// counterpart to scripts/telegram-set-webhook.ts's bootstrap flow: same
// three steps (generate-or-reuse a webhook secret -> save the encrypted
// credential via lib/channels/telegram/integration-store.ts -> register
// the webhook with Telegram via lib/channels/telegram/client.ts's
// setTelegramWebhook()) -- see that script's own header for the exact
// step-by-step this mirrors, now reachable from the app instead of only a
// one-off CLI.
//
// Lives under app/api/ (core-app territory), NOT under lib/channels/** --
// the import-boundary rule (CLAUDE.md non-negotiable rule 8) only
// restricts what lib/channels/** itself may import, not what calls INTO
// it, so this route importing lib/channels/telegram/{integration-store,client}
// directly is the same pattern the inbound webhook route
// (app/api/channels/telegram/[integrationId]/route.ts) already uses.
//
// The plaintext bot token is never echoed back in any response, logged, or
// exposed to the client after a save -- same write-only posture
// app/api/profile/ai-providers/route.ts already takes for provider API
// keys (see that route's own header comment).
//
// WEBHOOK STATUS (`webhookStatus`): the credential row is saved before
// setWebhook is even attempted (see the NOTE below), so row-existence alone
// can't be trusted as "the bot is live" -- a saved row with an invalid
// token would otherwise still read back as "connected" even though
// Telegram never registered anything. Fixed without a schema change:
// rather than caching a "did setWebhook ever succeed" boolean (which can
// itself go stale -- revoked token, webhook cleared via BotFather,
// overwritten by something outside this app), GET calls Telegram's own
// `getWebhookInfo` live and compares the URL Telegram currently has on file
// against this integration's own expected path
// (`/api/channels/telegram/{integrationId}` -- independent of whatever
// base URL was used to register it, so a later base-URL rotation doesn't
// require re-deriving anything stored). This reflects Telegram's current
// state at read time, not a snapshot from whenever setWebhook last
// succeeded. See lib/channels/telegram/client.ts's getTelegramWebhookInfo()
// for the raw call. `webhookStatus` is only present when `connected: true`,
// with two values: "confirmed" (Telegram has this exact integration's URL
// registered right now) or "unconfirmed" (no webhook registered, a
// mismatched one, or the live check itself failed -- e.g. a revoked token
// -- treated the same as "can't confirm it's working" rather than a hard
// 500, since the underlying saved-row state is still valid either way).
//
// WEBHOOK BASE URL: unlike scripts/telegram-set-webhook.ts (a CLI flag,
// --url), there is no global "this deployment's public base URL" env var
// in this project (see README "`.env.example`": "No global Telegram env
// var was added" -- more generally, .env.example has no APP_URL/BASE_URL
// either). The caller supplies `webhookBaseUrl` explicitly in the POST
// body -- in production this is the app's own public origin; in local dev
// it's a public HTTPS tunnel (ngrok/cloudflared) pointed at the dev
// server, exactly the constraint scripts/telegram-set-webhook.ts's own
// header already documents (Telegram cannot reach `localhost` directly).
// nextjs-frontend's connect-Telegram form is expected to default this
// field to `window.location.origin` and let the user override it for the
// local-tunnel case.
//
// Request contract:
//   POST /api/projects/{projectId}/channels/telegram
//   body: { botToken: string; webhookBaseUrl: string; displayLabel?: string }
//     webhookBaseUrl must start with "https://" (Telegram requires HTTPS
//     for webhooks -- same check scripts/telegram-set-webhook.ts's
//     parseArgs() already performs); trailing slashes are stripped.
//     Re-submitting for an already-connected project rotates the bot token
//     in place (upsert) and reuses the existing webhook secret, mirroring
//     the bootstrap script's own "rotate just the token" behavior.
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 400 { error: "invalid_request", details }
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 400 { error: "telegram_setup_failed", message } -- Telegram's own
//      setWebhook call rejected the request (most commonly: an invalid bot
//      token) -- a clear 4xx, never a bare 500. NOTE: the encrypted
//      credential is still saved at this point (upsert, same as the
//      bootstrap script) so correcting the token and re-submitting this
//      same endpoint retries cleanly without a separate "undo" step -- see
//      the inline comment above the setTelegramWebhook() call below for
//      why this mirrors the script's own accepted save-then-register
//      ordering instead of attempting a rollback with no established
//      precedent in this codebase.
//   -> 200 { integrationId, displayLabel, enabled, webhookUrl, webhookStatus: "confirmed", status: "connected" }
//      -- never `botToken`/`webhookSecret`. `webhookStatus` is always
//      "confirmed" here specifically (not "unconfirmed") because reaching
//      this 200 already means the setWebhook call above succeeded without
//      throwing -- see the WEBHOOK STATUS note above for the general case.
//
//   GET /api/projects/{projectId}/channels/telegram
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 200 { connected: false }
//   -> 200 { connected: true, enabled: boolean, displayLabel: string | null,
//            webhookStatus: "confirmed" | "unconfirmed" }
//      -- never `.credentials`. See the WEBHOOK STATUS note above for what
//      these two values mean and how they're computed (a live call to
//      Telegram's getWebhookInfo, not a cached DB flag).
//
//   DELETE /api/projects/{projectId}/channels/telegram
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 429 { error: "rate_limited", message, retryAfterMs }
//   -> 200 { status: "deleted" }
//      NOTE: this only removes the DB row -- it does not also call a
//      Telegram deleteWebhook API. A leftover webhook registration pointed
//      at a now-deleted integration id is harmless: the inbound webhook
//      route (app/api/channels/telegram/[integrationId]/route.ts) already
//      treats an unknown integration id as a silent, logged no-op (still
//      200, per Telegram's own retry semantics) -- it just stops doing
//      anything, forever, until the owner reconnects. A future "pause
//      without losing config" toggle could use the existing
//      channel_integrations.enabled column without any Telegram API call.

import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import {
  getTelegramIntegrationByProject,
  saveTelegramIntegration,
  deleteTelegramIntegration,
} from "@/lib/channels/telegram/integration-store";
import { setTelegramWebhook, getTelegramWebhookInfo } from "@/lib/channels/telegram/client";
import { checkAICredentialsRateLimit } from "@/lib/rate-limit/ai-credentials-rate-limiter";
import { isUuidShape } from "@/lib/validation/uuid";
import { parseJsonBody } from "@/lib/http/parse-json-body";
import { rateLimitedResponse } from "@/lib/http/rate-limited-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PostBodySchema = z.object({
  botToken: z.string().min(1, "botToken must not be empty"),
  webhookBaseUrl: z
    .string()
    .min(1, "webhookBaseUrl must not be empty")
    .max(2048, "webhookBaseUrl is too long")
    .refine((v) => v.startsWith("https://"), {
      message: "webhookBaseUrl must be an https:// URL -- Telegram requires HTTPS for webhooks.",
    }),
  displayLabel: z.string().trim().max(200, "displayLabel must be 200 characters or fewer").optional(),
});

// Reuses lib/rate-limit/ai-credentials-rate-limiter.ts's generic
// per-identity sliding window rather than adding a fourth, near-identical
// limiter module. Namespaced with a "telegram:" prefix so this route's own
// write-request budget lives in its own map entry, independent of that
// same user's POST/DELETE /api/profile/ai-providers calls -- that module's
// own header explicitly warns against two unrelated write actions silently
// sharing one counter, and a distinct map key (not a whole distinct
// module) is enough to satisfy that here.
//
// Keyed by project id, not the account-wide user id: this protects a
// project-scoped resource (one project's channel_integrations row), and a
// single account can own several projects -- one project's Telegram-connect
// churn must not eat into a completely different project's own budget.
function rateLimitKey(projectId: string): string {
  return `telegram:${projectId}`;
}

function telegramRateLimitedResponse(rateLimit: { retryAfterMs: number }): Response {
  return rateLimitedResponse(
    "Слишком много запросов к настройкам Telegram-интеграции. Попробуйте через несколько секунд.",
    rateLimit.retryAfterMs
  );
}

type WebhookStatus = "confirmed" | "unconfirmed";

/**
 * Live check against Telegram's own getWebhookInfo -- see this file's
 * WEBHOOK STATUS header comment for why this isn't a cached DB flag.
 * Deliberately never throws: a failed check (bad/revoked token, Telegram
 * unreachable, ...) degrades to "unconfirmed" rather than turning GET's
 * whole response into a 500 -- the saved integration row is still valid
 * information even when this enrichment can't be obtained.
 */
async function resolveWebhookStatus(botToken: string, integrationId: string): Promise<WebhookStatus> {
  const expectedSuffix = `/api/channels/telegram/${integrationId}`;
  try {
    const { url } = await getTelegramWebhookInfo(botToken);
    return url.length > 0 && url.endsWith(expectedSuffix) ? "confirmed" : "unconfirmed";
  } catch (err) {
    console.warn(`resolveWebhookStatus: could not confirm webhook status for integration ${integrationId}:`, err);
    return "unconfirmed";
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  // Shape-check before touching the DB -- see app/api/projects/[projectId]/route.ts's identical guard.
  if (!isUuidShape(projectId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return Response.json({ error: "not_found" }, { status: 404 });

  const supabase = getServiceRoleClient();
  try {
    const integration = await getTelegramIntegrationByProject(supabase, projectId);
    if (!integration) return Response.json({ connected: false }, { status: 200 });
    const webhookStatus = await resolveWebhookStatus(integration.credentials.botToken, integration.id);
    // .credentials is intentionally never included below -- write-only
    // from the client's perspective, see this file's own header comment.
    return Response.json(
      { connected: true, enabled: integration.enabled, displayLabel: integration.displayLabel, webhookStatus },
      { status: 200 }
    );
  } catch (err) {
    console.error(`GET /api/projects/${projectId}/channels/telegram: failed to load integration:`, err);
    return Response.json(
      { error: "internal_error", message: "Не удалось загрузить статус Telegram-интеграции." },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  // Shape-check before touching the DB -- see app/api/projects/[projectId]/route.ts's identical guard.
  if (!isUuidShape(projectId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return Response.json({ error: "not_found" }, { status: 404 });

  const rateLimit = checkAICredentialsRateLimit(rateLimitKey(projectId));
  if (!rateLimit.allowed) return telegramRateLimitedResponse(rateLimit);

  const parsed = await parseJsonBody(request, PostBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;
  const webhookBaseUrl = parsed.data.webhookBaseUrl.replace(/\/+$/, "");

  const supabase = getServiceRoleClient();

  // Reuse the existing webhook secret on a re-submit (e.g. rotating just
  // the bot token) -- same reasoning as scripts/telegram-set-webhook.ts's
  // own "reuse when present" comment: generating a fresh one every call
  // would silently invalidate whatever Telegram currently has registered,
  // with no corresponding signal to the owner that it happened.
  let existing;
  try {
    existing = await getTelegramIntegrationByProject(supabase, projectId);
  } catch (err) {
    console.error(`POST /api/projects/${projectId}/channels/telegram: failed to read existing integration:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось подключить Telegram-бота." }, { status: 500 });
  }
  const webhookSecret = existing?.credentials.webhookSecret ?? randomBytes(32).toString("hex");
  const displayLabel = parsed.data.displayLabel ?? existing?.displayLabel ?? null;

  let integrationId: string;
  try {
    ({ id: integrationId } = await saveTelegramIntegration(
      supabase,
      projectId,
      { botToken: parsed.data.botToken, webhookSecret },
      displayLabel
    ));
  } catch (err) {
    console.error(`POST /api/projects/${projectId}/channels/telegram: failed to save integration:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось сохранить настройки Telegram-бота." }, { status: 500 });
  }

  const webhookUrl = `${webhookBaseUrl}/api/channels/telegram/${integrationId}`;
  try {
    // Same call scripts/telegram-set-webhook.ts makes -- this is what
    // actually activates the bot (registers the URL Telegram will POST
    // updates to) rather than just storing a token nobody told Telegram
    // about. The credential above is already saved by this point (see the
    // module header's NOTE on why a failure here doesn't roll that back --
    // the row is left in a safely-retryable "saved but not yet confirmed
    // registered" state, exactly like a failed run of the bootstrap
    // script would).
    await setTelegramWebhook(parsed.data.botToken, webhookUrl, webhookSecret);
  } catch (err) {
    // lib/channels/telegram/client.ts's callTelegramApi() throws a plain
    // Error (already redacted of the bot token, see that file's
    // redactToken()) for both a network failure and a real Telegram API
    // rejection (e.g. a malformed/revoked bot token) -- it doesn't
    // distinguish the two with a typed error, so both are surfaced here as
    // the same clear 4xx rather than guessing which one happened; the full
    // (redacted) detail is still logged server-side for debugging.
    console.error(`POST /api/projects/${projectId}/channels/telegram: Telegram setWebhook failed:`, err);
    return Response.json(
      {
        error: "telegram_setup_failed",
        message: "Не удалось зарегистрировать webhook в Telegram. Проверьте правильность токена бота и попробуйте снова.",
      },
      { status: 400 }
    );
  }

  return Response.json(
    {
      integrationId,
      displayLabel,
      enabled: existing?.enabled ?? true,
      webhookUrl,
      // Always "confirmed" on this success path -- reaching here already
      // means the setWebhook call above resolved without throwing, see the
      // WEBHOOK STATUS header note.
      webhookStatus: "confirmed" as const,
      status: "connected",
    },
    { status: 200 }
  );
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> }
): Promise<Response> {
  const { projectId } = await params;
  // Shape-check before touching the DB -- see app/api/projects/[projectId]/route.ts's identical guard.
  if (!isUuidShape(projectId)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return Response.json({ error: "not_found" }, { status: 404 });

  const rateLimit = checkAICredentialsRateLimit(rateLimitKey(projectId));
  if (!rateLimit.allowed) return telegramRateLimitedResponse(rateLimit);

  const supabase = getServiceRoleClient();
  try {
    await deleteTelegramIntegration(supabase, projectId);
  } catch (err) {
    console.error(`DELETE /api/projects/${projectId}/channels/telegram: failed to delete integration:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось отключить Telegram-бота." }, { status: 500 });
  }

  return Response.json({ status: "deleted" }, { status: 200 });
}
