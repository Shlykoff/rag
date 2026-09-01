// app/api/projects/shared.ts
//
// Small helper shared by the two `projects` CRUD route files
// (./route.ts's GET-list/POST-create, ./[projectId]/route.ts's
// GET-one/PATCH-rename/DELETE) so the "one project, as returned over the
// wire" shape can't drift between the four endpoints that return it.
// Route-local, colocated under app/api/projects/, the same way
// app/api/chat/route.ts keeps its own `formatSSE` helper local rather than
// promoting a two-line function into lib/.
//
// documentCount is fetched via PostgREST's embedded-resource count
// aggregate over the documents.project_id FK (`documents(count)`) in the
// SAME query as the rest of a project's columns -- one round trip per
// call, not a second query per project (no N+1: this is a single query
// even when listing many projects at once, since the join/count happens
// inside Postgres, not by looping in this file).

import { z } from "zod";
import type { ActiveAIProvider } from "@/lib/ai";

export const PROJECT_SELECT_COLUMNS = "id, name, active_ai_provider, created_at, updated_at, documents(count)";

/** Shape of one row as returned by a `.select(PROJECT_SELECT_COLUMNS)` query. PostgREST's `(count)` embed always yields exactly one element for a to-many relation, even when the related count is 0 -- never an empty array -- but toProjectDTO below still guards with `?? 0` rather than assuming that. */
export interface ProjectRow {
  id: string;
  name: string;
  active_ai_provider: ActiveAIProvider | null;
  created_at: string;
  updated_at: string;
  documents: { count: number }[];
}

/** The "project" object shape every one of this feature's endpoints returns (GET list/one, POST, PATCH) -- kept identical across all four so nextjs-frontend can use one `Project` type for all of them. */
export interface ProjectDTO {
  id: string;
  name: string;
  activeAiProvider: ActiveAIProvider | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toProjectDTO(row: ProjectRow): ProjectDTO {
  return {
    id: row.id,
    name: row.name,
    activeAiProvider: row.active_ai_provider,
    documentCount: row.documents?.[0]?.count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Shared by POST (create) and PATCH (rename) -- trimmed so "  " / "" are both rejected the same way, capped well above any realistic project name (matches the general "cap free-text input" posture app/api/chat/route.ts's own `message` field takes, just a much smaller number since this is a short label, not a chat turn). */
export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(200, "name must be 200 characters or fewer");
