// app/api/projects/route.ts
//
// List/create the signed-in user's own projects -- the top-level scoping
// entity (see supabase/migrations/20260819052349_create_projects_table.sql).
//
// Queries run on the service-role client with an explicit
// `.eq("user_id", user.id)` filter; the RLS-scoped session client is used
// only to authenticate the caller (same convention as lib/ai/credentials.ts
// and lib/sources/credentials.ts).
//
//   GET /api/projects
//   -> 401 { error: "unauthorized" }
//   -> 200 { projects: ProjectDTO[] }   -- newest first; ProjectDTO: see ./shared.ts
//
//   POST /api/projects
//   body: { name: string }              -- trimmed, 1..200 chars
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 201 { project: ProjectDTO }      -- chat/embedding models pre-filled when the
//      owner's keys leave only one choice (lib/ai/model-autofill.ts), otherwise null

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
import { autoFillColumns, resolveAutoFillModels } from "@/lib/ai";
import { PROJECT_SELECT_COLUMNS, ProjectNameSchema, toProjectDTO, type ProjectRow } from "./shared";
import { parseJsonBody } from "@/lib/http/parse-json-body";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const CreateProjectBodySchema = z.object({ name: ProjectNameSchema });

export async function GET(): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("projects")
    .select(PROJECT_SELECT_COLUMNS)
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });
  if (error) {
    console.error(`GET /api/projects: failed to list projects for user ${user.id}:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось загрузить список проектов." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as ProjectRow[];
  return Response.json({ projects: rows.map(toProjectDTO) }, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(request, CreateProjectBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();

  let modelColumns: Record<string, string> = {};
  try {
    modelColumns = autoFillColumns(await resolveAutoFillModels(supabase, user.id));
  } catch (err) {
    // Best-effort: the project is still created, and its model page fills the slots later.
    console.error(`POST /api/projects: resolving default models for user ${user.id} failed:`, err);
  }

  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: user.id, name: parsed.data.name, ...modelColumns })
    .select(PROJECT_SELECT_COLUMNS)
    .single();
  if (error || !data) {
    console.error(`POST /api/projects: failed to create project for user ${user.id}:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось создать проект." }, { status: 500 });
  }

  return Response.json({ project: toProjectDTO(data as unknown as ProjectRow) }, { status: 201 });
}
