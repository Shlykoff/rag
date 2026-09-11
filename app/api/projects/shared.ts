// app/api/projects/shared.ts
//
// The "one project over the wire" shape, shared by ./route.ts (list/create)
// and ./[projectId]/route.ts (get/rename) so it can't drift between them.
// documentCount and the chat model come from embeds in the same query --
// one round trip, even when listing many projects.

import { z } from "zod";
import { PROJECT_CHAT_MODEL_EMBED, type ActiveAIProvider } from "@/lib/ai";

export const PROJECT_SELECT_COLUMNS = `id, name, chat_model_id, embedding_model_id, created_at, updated_at, documents(count), ${PROJECT_CHAT_MODEL_EMBED}`;

/** One row of a `.select(PROJECT_SELECT_COLUMNS)` query. */
export interface ProjectRow {
  id: string;
  name: string;
  chat_model_id: string | null;
  embedding_model_id: string | null;
  created_at: string;
  updated_at: string;
  documents: { count: number }[];
  chat_model: { display_name: string; provider: ActiveAIProvider } | null;
}

export interface ProjectDTO {
  id: string;
  name: string;
  /** Provider of the chat model (read from the catalog row, not the legacy column); null until a model is chosen. */
  activeAiProvider: ActiveAIProvider | null;
  chatModelId: string | null;
  /** The chat model's display name, for the "Работает на: …" label; null until a model is chosen. */
  chatModelName: string | null;
  embeddingModelId: string | null;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
}

export function toProjectDTO(row: ProjectRow): ProjectDTO {
  return {
    id: row.id,
    name: row.name,
    activeAiProvider: row.chat_model?.provider ?? null,
    chatModelId: row.chat_model_id,
    chatModelName: row.chat_model?.display_name ?? null,
    embeddingModelId: row.embedding_model_id,
    documentCount: row.documents?.[0]?.count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Shared by POST (create) and PATCH (rename): trimmed, so "  " and "" are rejected alike. */
export const ProjectNameSchema = z
  .string()
  .trim()
  .min(1, "name must not be empty")
  .max(200, "name must be 200 characters or fewer");
