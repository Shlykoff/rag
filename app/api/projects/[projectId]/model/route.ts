// app/api/projects/[projectId]/model/route.ts
//
// Read/set a project's chat and embedding models, picked from the ai_models
// catalog and backed by the owner's account-level keys. GET first fills
// empty slots the owner's keys make unambiguous (lib/ai/model-autofill.ts).
//
//   GET -> 200 { chatModelId, embeddingModelId, embeddingLocked,
//                configured: { openai, anthropic, gemini, voyage },
//                models: AIModelDTO[] }  -- active rows + any selected retired row, by sort_order
//   PUT { chatModelId: uuid } | { embeddingModelId: uuid }
//     -> 200 { chatModelId } | { embeddingModelId }
//     -> 400 { error: "invalid_request", details }               malformed body
//     -> 400 { error: "invalid_model", reason, message }         reason: not_found | wrong_kind | inactive
//     -> 409 { error: "embedding_locked", message }              documents already embedded with the current model
//     -> 422 { error: "missing_credentials", provider, message } no key for the model's provider
//   Both: 401 { error: "unauthorized" }; 404 { error: "not_found" }, also for another user's project.
// The 400 invalid_model / 409 / 422 outcomes are expected user states and aren't logged.

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import {
  autoFillProjectModels,
  getConfiguredProvidersMap,
  getProjectModelState,
  getProviderLabel,
  listAIModels,
  setProjectChatModel,
  setProjectEmbeddingModel,
  toAIModelDTO,
  EmbeddingModelLockedError,
  InvalidModelSelectionError,
  MissingProviderCredentialsError,
  type AIModelKind,
  type InvalidModelReason,
} from "@/lib/ai";
import { isUuidShape, uuidShapeSchema } from "@/lib/validation/uuid";
import { parseJsonBody } from "@/lib/http/parse-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PutBodySchema = z.union([
  z.object({ chatModelId: uuidShapeSchema }).strict(),
  z.object({ embeddingModelId: uuidShapeSchema }).strict(),
]);

const INVALID_MODEL_MESSAGES: Record<InvalidModelReason, (slot: AIModelKind) => string> = {
  not_found: () => "Такой модели нет в каталоге.",
  wrong_kind: (slot) => (slot === "chat" ? "Эта модель не подходит для чата." : "Эта модель не подходит для эмбеддингов."),
  inactive: () => "Эта модель больше недоступна для выбора.",
};

/** Auth + ownership (404, not 403, on mismatch) shared by GET and PUT. */
async function resolveOwnedProject(
  params: Promise<{ projectId: string }>
): Promise<{ projectId: string; userId: string } | { response: Response }> {
  const { projectId } = await params;
  // Shape-check before touching the DB -- see app/api/projects/[projectId]/route.ts's identical guard.
  if (!isUuidShape(projectId)) return { response: Response.json({ error: "not_found" }, { status: 404 }) };

  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return { response: Response.json({ error: "unauthorized" }, { status: 401 }) };

  const owned = await verifyProjectOwnership(authClient, projectId);
  if (!owned) return { response: Response.json({ error: "not_found" }, { status: 404 }) };
  return { projectId, userId: user.id };
}

export async function GET(_request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const resolved = await resolveOwnedProject(params);
  if ("response" in resolved) return resolved.response;
  const { projectId, userId } = resolved;

  const supabase = getServiceRoleClient();
  try {
    const [configured, catalog] = await Promise.all([getConfiguredProvidersMap(supabase, userId), listAIModels(supabase)]);
    try {
      await autoFillProjectModels(supabase, userId, { projectId, configured, catalog });
    } catch (err) {
      // Best-effort: the settings still load, and the next read retries the fill.
      console.error(`GET /api/projects/${projectId}/model: auto-filling models failed:`, err);
    }
    const state = await getProjectModelState(supabase, projectId);
    const selected = new Set([state.chatModelId, state.embeddingModelId]);
    const models = catalog.filter((model) => model.isActive || selected.has(model.id)).map(toAIModelDTO);
    return Response.json({ ...state, configured, models }, { status: 200 });
  } catch (err) {
    console.error(`GET /api/projects/${projectId}/model: failed to load model settings:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось загрузить настройки модели." }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ projectId: string }> }): Promise<Response> {
  const resolved = await resolveOwnedProject(params);
  if ("response" in resolved) return resolved.response;
  const { projectId, userId } = resolved;

  const parsed = await parseJsonBody(request, PutBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;
  const body = parsed.data;

  const supabase = getServiceRoleClient();
  try {
    if ("chatModelId" in body) {
      const model = await setProjectChatModel(supabase, projectId, userId, body.chatModelId);
      return Response.json({ chatModelId: model.id }, { status: 200 });
    }
    const model = await setProjectEmbeddingModel(supabase, projectId, userId, body.embeddingModelId);
    return Response.json({ embeddingModelId: model.id }, { status: 200 });
  } catch (err) {
    if (err instanceof InvalidModelSelectionError) {
      return Response.json(
        { error: "invalid_model", reason: err.reason, message: INVALID_MODEL_MESSAGES[err.reason](err.slot) },
        { status: 400 }
      );
    }
    if (err instanceof MissingProviderCredentialsError) {
      const label = getProviderLabel(err.provider) ?? err.provider;
      return Response.json(
        {
          error: "missing_credentials",
          provider: err.provider,
          message: `Сначала подключите API-ключ ${label} на странице профиля, чтобы выбрать эту модель.`,
        },
        { status: 422 }
      );
    }
    if (err instanceof EmbeddingModelLockedError) {
      return Response.json(
        {
          error: "embedding_locked",
          message:
            "Модель эмбеддингов нельзя сменить: документы проекта уже проиндексированы текущей моделью. Удалите документы или создайте новый проект.",
        },
        { status: 409 }
      );
    }
    console.error(`PUT /api/projects/${projectId}/model: failed to update the project's model:`, err);
    return Response.json({ error: "internal_error", message: "Не удалось обновить модель проекта." }, { status: 500 });
  }
}
