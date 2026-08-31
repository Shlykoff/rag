// app/api/projects/route.ts
//
// List/create the signed-in user's own projects ("бот1", "бот2", ...) --
// the top-level scoping entity introduced by the projects architecture
// pivot (see supabase/migrations/20260819052349_create_projects_table.sql
// and CLAUDE.md "Как организована работа агентов"). Until this route
// exists, nextjs-frontend's upcoming `/projects` list/create screen has
// nothing to call -- this file (plus ./[projectId]/route.ts,
// ./[projectId]/model/route.ts, ./[projectId]/channels/telegram/route.ts)
// is exactly that gap.
//
// Every read/write below goes through the service-role client with an
// explicit `.eq("user_id", user.id)` filter, never the RLS-scoped session
// client for the query itself -- the same convention lib/ai/credentials.ts
// / lib/sources/credentials.ts already use throughout this codebase for
// account-scoped reads. The RLS-scoped client
// (lib/supabase/server-client.ts) is used ONLY to authenticate the caller
// here; the single-project routes in ./[projectId]/**/route.ts additionally
// use it for verifyProjectOwnership() (there's no existing projectId to
// verify against on this file's own two endpoints -- POST creates a brand
// new row owned by the caller, GET is filtered to the caller's own rows by
// construction).
//
// Request contract (consumed by nextjs-frontend's /projects list page):
//   GET /api/projects
//   -> 401 { error: "unauthorized" }
//   -> 200 { projects: ProjectDTO[] }   -- newest first (created_at desc)
//      ProjectDTO (see ./shared.ts): { id, name,
//        activeAiProvider: "openai" | "anthropic" | "gemini" | null,
//        documentCount: number, createdAt, updatedAt }
//
//   POST /api/projects
//   body: { name: string }              -- trimmed, 1..200 chars
//   -> 401 { error: "unauthorized" }
//   -> 400 { error: "invalid_request", details }
//   -> 201 { project: ProjectDTO }      -- documentCount always 0 (brand new);
//      activeAiProvider always null (a fresh project has no model picked
//      yet, see PUT /api/projects/{projectId}/model)

import "server-only";
import { z } from "zod";
import { getServiceRoleClient } from "@/lib/supabase/service-client";
import { getAuthenticatedUser, getRouteHandlerSupabaseClient } from "@/lib/supabase/server-client";
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

  const rows = (data ?? []) as ProjectRow[];
  return Response.json({ projects: rows.map(toProjectDTO) }, { status: 200 });
}

export async function POST(request: Request): Promise<Response> {
  const authClient = await getRouteHandlerSupabaseClient();
  const user = await getAuthenticatedUser(authClient);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const parsed = await parseJsonBody(request, CreateProjectBodySchema);
  if ("errorResponse" in parsed) return parsed.errorResponse;

  const supabase = getServiceRoleClient();
  const { data, error } = await supabase
    .from("projects")
    .insert({ user_id: user.id, name: parsed.data.name })
    .select(PROJECT_SELECT_COLUMNS)
    .single();
  if (error || !data) {
    console.error(`POST /api/projects: failed to create project for user ${user.id}:`, error);
    return Response.json({ error: "internal_error", message: "Не удалось создать проект." }, { status: 500 });
  }

  return Response.json({ project: toProjectDTO(data as ProjectRow) }, { status: 201 });
}
