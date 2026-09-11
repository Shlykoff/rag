// app/api/profile/ai-providers/route.ts
//
// Bring-your-own-key: the signed-in user stores/removes their own
// account-level AI provider API keys (encrypted at rest, lib/ai/crypto.ts).
// Which model each project uses is set per project
// (app/api/projects/[projectId]/model/route.ts). Saving a key also fills
// empty project model slots that the user's keys now make unambiguous
// (lib/ai/model-autofill.ts). A key is never echoed back, logged or
// returned -- GET reports booleans only.
//
//   GET    -> 200 { configured: { openai, anthropic, gemini, voyage: boolean } }
//   POST   { provider: "openai" | "anthropic" | "gemini" | "voyage", apiKey: string } -> 200 { status: "saved" }
//   DELETE { provider } -> 200 { status: "deleted" }
//     Project models that need the deleted key stay selected; chat and
//     ingestion then report no_credentials (a 422) until a key is added.
//   All: 401 { error: "unauthorized" }. POST/DELETE: 400 { error: "invalid_request", details },
//   429 { error: "rate_limited", message, retryAfterMs } -- checked before any parsing or DB work
//   (lib/rate-limit/ai-credentials-rate-limiter.ts).

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import {
  autoFillProjectModels,
  deleteAIProviderCredential,
  getConfiguredProvidersMap,
  saveAIProviderCredential,
} from "@/lib/ai";
import { checkAICredentialsRateLimit } from "@/lib/rate-limit/ai-credentials-rate-limiter";
import { parseJsonBody } from "@/lib/http/parse-json-body";
import { rateLimitedResponse } from "@/lib/http/rate-limited-response";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const ProviderTypeSchema = z.enum(["openai", "anthropic", "gemini", "voyage"]);

const PostBodySchema = z.object({
  provider: ProviderTypeSchema,
  apiKey: z.string().min(1, "apiKey must not be empty"),
});

const DeleteBodySchema = z.object({
  provider: ProviderTypeSchema,
});

function aiProvidersRateLimitedResponse(rateLimit: { retryAfterMs: number }): Response {
  return rateLimitedResponse(
    "Слишком много запросов к настройкам AI-провайдера. Попробуйте через несколько секунд.",
    rateLimit.retryAfterMs
  );
}

function internalError(method: string, err: unknown, message: string): Response {
  console.error(`${method} /api/profile/ai-providers failed:`, err);
  return Response.json({ error: "internal_error", message }, { status: 500 });
}

export async function GET(): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  try {
    const configured = await getConfiguredProvidersMap(getServiceRoleClient(), user.id);
    return Response.json({ configured }, { status: 200 });
  } catch (err) {
    return internalError("GET", err, "Не удалось загрузить настройки AI-провайдеров.");
  }
}

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const rateLimit = checkAICredentialsRateLimit(user.id);
  if (!rateLimit.allowed) return aiProvidersRateLimitedResponse(rateLimit);

  const parsed = await parseJsonBody(request, PostBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  try {
    await saveAIProviderCredential(supabase, user.id, parsed.data.provider, parsed.data.apiKey);
  } catch (err) {
    return internalError("POST", err, "Не удалось сохранить API-ключ.");
  }

  try {
    await autoFillProjectModels(supabase, user.id);
  } catch (err) {
    // The key is saved either way; a project's model page retries the fill.
    console.error("POST /api/profile/ai-providers: auto-filling project models failed:", err);
  }
  return Response.json({ status: "saved" }, { status: 200 });
}

export async function DELETE(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const rateLimit = checkAICredentialsRateLimit(user.id);
  if (!rateLimit.allowed) return aiProvidersRateLimitedResponse(rateLimit);

  const parsed = await parseJsonBody(request, DeleteBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  try {
    await deleteAIProviderCredential(getServiceRoleClient(), user.id, parsed.data.provider);
  } catch (err) {
    return internalError("DELETE", err, "Не удалось удалить API-ключ.");
  }
  return Response.json({ status: "deleted" }, { status: 200 });
}
