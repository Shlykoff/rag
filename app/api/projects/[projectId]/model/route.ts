// app/api/projects/[projectId]/model/route.ts
//
// Read/set a project's two AI settings, both backed by the owner's
// account-level keys (connected via app/api/profile/ai-providers/route.ts):
//   - the chat model (`projects.active_ai_provider`) -- switchable any time;
//   - the embedding model (`projects.embedding_provider`) -- fixed once the
//     project has documents (vectors from different models aren't
//     comparable, see lib/ai/index.ts's header).
// Thin HTTP wrapper around lib/ai/credentials.ts: auth, ownership check (404,
// not 403, on mismatch), and mapping outcomes to status codes.
//
// Request contract:
//   GET /api/projects/{projectId}/model
//   -> 401 { error: "unauthorized" } | 404 { error: "not_found" }
//   -> 200 { activeProvider: "openai" | "anthropic" | "gemini" | null,
//            embeddingProvider: "openai" | "gemini" | "voyage" | null,
//            embeddingLocked: boolean,
//            configured: { openai, anthropic, gemini, voyage: boolean } }
//
//   PUT /api/projects/{projectId}/model
//   body: { provider: "openai" | "anthropic" | "gemini" }         -- chat model
//      or { embeddingProvider: "openai" | "gemini" | "voyage" }   -- embedding model
//   -> 401 | 404 | 400 { error: "invalid_request", details }
//   -> 400 { error: "missing_credentials", message, provider, missing } -- key not connected yet
//   -> 409 { error: "embedding_locked", message } -- project already has documents
//   -> 200 { activeProvider } | { embeddingProvider }
// missing_credentials / embedding_locked are expected user states, so they
// are not logged via console.error.

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient, verifyProjectOwnership } from "@/lib/supabase/server-client";
import {
  getActiveProvider,
  setActiveProvider,
  getProjectEmbeddingState,
  setProjectEmbeddingProvider,
  getConfiguredProvidersMap,
  MissingProviderCredentialsError,
  EmbeddingProviderLockedError,
} from "@/lib/ai";
import { isUuidShape } from "@/lib/validation/uuid";
import { parseJsonBody } from "@/lib/http/parse-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PutBodySchema = z.union([
  z.object({ provider: z.enum(["openai", "anthropic", "gemini"]) }).strict(),
  z.object({ embeddingProvider: z.enum(["openai", "gemini", "voyage"]) }).strict(),
]);

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
    const [activeProvider, embedding, configured] = await Promise.all([
      getActiveProvider(supabase, projectId),
      getProjectEmbeddingState(supabase, projectId),
      getConfiguredProvidersMap(supabase, user.id),
    ]);
    return Response.json(
      { activeProvider, embeddingProvider: embedding.provider, embeddingLocked: embedding.locked, configured },
      { status: 200 }
    );
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
  const body = parsed.data;

  const supabase = getServiceRoleClient();
  try {
    if ("provider" in body) {
      await setActiveProvider(supabase, projectId, user.id, body.provider);
      return Response.json({ activeProvider: body.provider }, { status: 200 });
    }
    await setProjectEmbeddingProvider(supabase, projectId, user.id, body.embeddingProvider);
    return Response.json({ embeddingProvider: body.embeddingProvider }, { status: 200 });
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
    if (err instanceof EmbeddingProviderLockedError) {
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
