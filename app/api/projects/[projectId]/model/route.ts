// app/api/projects/[projectId]/model/route.ts
//
// Read/set which of the project owner's account-level AI-provider
// credentials (`ai_provider_credentials`, connect/rotate/delete via
// app/api/profile/ai-providers/route.ts) THIS PROJECT actually uses
// (`projects.active_ai_provider`) -- the project-level half of the split
// CLAUDE.md documents explicitly: "connect a provider" is an account-level
// action, "which connected provider a given project uses" is a
// project-level selection (see lib/ai/credentials.ts's own header). Thin
// HTTP wrapper around lib/ai/credentials.ts's already-existing
// getActiveProvider()/setActiveProvider() -- this route adds nothing
// beyond auth, ownership verification, and mapping their outcomes onto
// HTTP status codes.
//
// Same auth -> ownership check (404, not 403, on mismatch) -> service-role
// client pattern as every other project-scoped route in this codebase.
//
// Request contract:
//   GET /api/projects/{projectId}/model
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 200 { activeProvider: "openai" | "anthropic" | "gemini" | null,
//            configured: { openai: boolean, anthropic: boolean, gemini: boolean, voyage: boolean } }
//      `configured` is account-level -- the same booleans
//      GET /api/profile/ai-providers already returns, reused here so this
//      project's "pick a model" screen doesn't need a second round-trip to
//      /profile just to know which options can actually be selected.
//
//   PUT /api/projects/{projectId}/model
//   body: { provider: "openai" | "anthropic" | "gemini" }   -- never
//     "voyage": see lib/ai/credentials.ts's ActiveAIProvider type --
//     Voyage is always Anthropic's paired embeddings credential, never
//     independently selectable as a project's own active provider.
//   -> 401 { error: "unauthorized" }
//   -> 404 { error: "not_found" }
//   -> 400 { error: "invalid_request", details }
//   -> 400 { error: "missing_credentials", message, provider, missing }
//      -- the requested provider's account-level credential(s) aren't
//      connected yet (lib/ai/credentials.ts's MissingProviderCredentialsError)
//      -- an expected "you haven't set this up yet" user state, not a
//      server fault, so deliberately NOT logged via console.error (same
//      posture as app/api/chat/route.ts's 422 no_credentials branch, or
//      lib/ai/index.ts's own comment on why "not configured yet" isn't an
//      error worth alarming server logs over).
//   -> 200 { activeProvider: "openai" | "anthropic" | "gemini" }

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import {
  getActiveProvider,
  setActiveProvider,
  getConfiguredProvidersMap,
  MissingProviderCredentialsError,
} from "@/lib/ai";
import { isUuidShape } from "@/lib/validation/uuid";
import { parseJsonBody } from "@/lib/http/parse-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Deliberately hardcoded (not derived from lib/ai's SUPPORTED_AI_PROVIDERS
// list) -- app/api/profile/ai-providers/route.ts's own ProviderTypeSchema
// already made this exact choice for the sibling account-level route; kept
// consistent with it here rather than introducing a second derivation
// style for the same three-provider enum.
const ActiveProviderSchema = z.enum(["openai", "anthropic", "gemini"]);
const PutBodySchema = z.object({ provider: ActiveProviderSchema });

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
    const [activeProvider, configured] = await Promise.all([
      getActiveProvider(supabase, projectId),
      getConfiguredProvidersMap(supabase, user.id),
    ]);
    return Response.json({ activeProvider, configured }, { status: 200 });
  } catch (err) {
    console.error(`GET /api/projects/${projectId}/model: failed to load provider state:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось загрузить настройки модели." }, { status: 500 });
  }
}

export async function PUT(
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

  const parsed = await parseJsonBody(request, PutBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  try {
    await setActiveProvider(supabase, projectId, user.id, parsed.data.provider);
  } catch (err) {
    if (err instanceof MissingProviderCredentialsError) {
      return Response.json(
        {
          error: "missing_credentials",
          message: `Сначала подключите API-ключ${err.missing.length > 1 ? "и" : ""} (${err.missing.join(
            ", "
          )}) на странице профиля, чтобы выбрать этого провайдера.`,
          provider: err.provider,
          missing: err.missing,
        },
        { status: 400 }
      );
    }
    // Any other failure here (e.g. the project/owner mismatch guard inside
    // setActiveProvider itself, or a DB error) is a real server-side fault,
    // not a normal "not configured yet" user state -- see
    // lib/ai/credentials.ts's own comment on that distinction.
    console.error(`PUT /api/projects/${projectId}/model: failed to set active provider:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось обновить модель проекта." }, { status: 500 });
  }

  return Response.json({ activeProvider: parsed.data.provider }, { status: 200 });
}
