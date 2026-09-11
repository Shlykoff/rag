// lib/ai/credentials.ts
//
// Server-side read/write of per-user AI-provider credentials
// (`ai_provider_credentials`, account-level) and the per-project
// active-provider selection (`projects.active_ai_provider`).
// lib/ai/index.ts's getAIProviders() calls
// getActiveProvider()/getAIProviderCredential() to build the active
// ChatProvider/EmbeddingsProvider pair for one request.
// app/api/profile/ai-providers/route.ts uses only the account-level
// credential CRUD exports here -- picking which connected provider a
// project uses is project-scoped, handled elsewhere.
// Mirrors lib/sources/credentials.ts's shape (including the bytea
// hex-encoding helpers), duplicated rather than imported -- see
// lib/ai/crypto.ts's header for why lib/ai/ and lib/sources/ stay
// domain-isolated.
//
// bytea encoding note: PostgREST (what supabase-js talks to) represents
// Postgres `bytea` columns as a hex string prefixed "\x" on both read and
// write by default (Postgres's `bytea_output = 'hex'` default) -- not
// base64, not a raw Buffer over the JSON wire. bufferToBytea/byteaToBuffer
// below are the only place that encoding is handled, so a future change to
// the column type or output format only needs updating here.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredential, decryptCredential } from "./crypto";

/** Matches the `ai_provider_type` Postgres enum exactly (see the ai_provider_credentials migration) -- every provider that can hold a stored API key, including 'voyage' (Anthropic's fixed embeddings pairing, never independently selectable as an active provider -- see ActiveAIProvider below). */
export type AIProviderCredentialType = "openai" | "anthropic" | "gemini" | "voyage";

/**
 * Every value AIProviderCredentialType can take, as a concrete array.
 * Hardcoded here rather than derived from lib/ai/index.ts's
 * SUPPORTED_AI_PROVIDERS, which excludes 'voyage' -- this list needs to
 * include 'voyage', unlike SUPPORTED_AI_PROVIDERS.
 */
export const ALL_CREDENTIAL_PROVIDERS: AIProviderCredentialType[] = ["openai", "anthropic", "gemini", "voyage"];

/** The subset of AIProviderCredentialType that can actually be `projects.active_ai_provider` -- excludes 'voyage', enforced both by the DB CHECK constraint (projects_active_provider_not_voyage) and by this narrower type, so a caller can't pass 'voyage' to setActiveProvider() without a compile error. */
export type ActiveAIProvider = Exclude<AIProviderCredentialType, "voyage">;

interface AIProviderCredentialRow {
  api_key_ciphertext: string;
  api_key_nonce: string;
  encryption_key_version: number;
}

function bufferToBytea(buf: Buffer): string {
  return `\\x${buf.toString("hex")}`;
}

function byteaToBuffer(value: string): Buffer {
  if (value.startsWith("\\x")) return Buffer.from(value.slice(2), "hex");
  // Fallback for the (rare/legacy) `bytea_output = 'escape'` server
  // setting, or a client library that base64-encodes bytea on its own --
  // trying base64 rather than throwing outright avoids silently corrupting
  // every stored credential if a future Supabase/PostgREST version changes
  // this default.
  return Buffer.from(value, "base64");
}

/**
 * Upserts (insert-or-replace) the encrypted API key for `provider`. One row
 * per (user, provider) -- see the ai_provider_credentials_one_per_user_provider
 * unique constraint -- so re-saving (e.g. the user rotates their OpenAI key)
 * replaces the old value rather than accumulating rows.
 */
export async function saveAIProviderCredential(
  supabase: SupabaseClient,
  userId: string,
  provider: AIProviderCredentialType,
  plaintext: string
): Promise<void> {
  const encrypted = encryptCredential(plaintext);
  const { error } = await supabase.from("ai_provider_credentials").upsert(
    {
      user_id: userId,
      provider,
      api_key_ciphertext: bufferToBytea(encrypted.ciphertext),
      api_key_nonce: bufferToBytea(encrypted.nonce),
      encryption_key_version: encrypted.keyVersion,
    },
    { onConflict: "user_id,provider" }
  );
  if (error) {
    throw new Error(`saveAIProviderCredential: failed to store ${provider} credential: ${error.message}`);
  }
}

/**
 * Returns the decrypted API key for (userId, provider), or null if none is
 * stored. Callers (lib/ai/index.ts's provider registries) must treat
 * the return value as a secret: never log it, never include it in a thrown
 * error's `message`/`userMessage`, never return it from an API route.
 */
export async function getAIProviderCredential(
  supabase: SupabaseClient,
  userId: string,
  provider: AIProviderCredentialType
): Promise<string | null> {
  const { data, error } = await supabase
    .from("ai_provider_credentials")
    .select("api_key_ciphertext, api_key_nonce, encryption_key_version")
    .eq("user_id", userId)
    .eq("provider", provider)
    .maybeSingle<AIProviderCredentialRow>();
  if (error) {
    throw new Error(`getAIProviderCredential: failed to load ${provider} credential: ${error.message}`);
  }
  if (!data) return null;
  return decryptCredential({
    ciphertext: byteaToBuffer(data.api_key_ciphertext),
    nonce: byteaToBuffer(data.api_key_nonce),
    keyVersion: data.encryption_key_version,
  });
}

/** Connection-status check for the /profile UI/API ("is OpenAI configured: yes/no") that never touches the ciphertext -- see app/api/profile/ai-providers/route.ts's GET handler. Also used internally by setActiveProvider() to validate a provider is actually configured before it can be made active. */
export async function hasAIProviderCredential(
  supabase: SupabaseClient,
  userId: string,
  provider: AIProviderCredentialType
): Promise<boolean> {
  const { count, error } = await supabase
    .from("ai_provider_credentials")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) {
    throw new Error(`hasAIProviderCredential: failed to check ${provider} credential: ${error.message}`);
  }
  return (count ?? 0) > 0;
}

/**
 * Returns which of every credential provider (ALL_CREDENTIAL_PROVIDERS) is
 * currently configured for `userId`, as a `{ openai: boolean, ... }` map --
 * all `hasAIProviderCredential` checks run concurrently via Promise.all.
 * Shared by app/api/profile/ai-providers/route.ts's GET (what's connected
 * on the profile screen) and app/api/projects/[projectId]/model/route.ts's
 * GET (which options a project's "pick a model" screen can offer).
 */
export async function getConfiguredProvidersMap(
  supabase: SupabaseClient,
  userId: string
): Promise<Record<AIProviderCredentialType, boolean>> {
  const flags = await Promise.all(ALL_CREDENTIAL_PROVIDERS.map((provider) => hasAIProviderCredential(supabase, userId, provider)));
  return Object.fromEntries(ALL_CREDENTIAL_PROVIDERS.map((provider, i) => [provider, flags[i]])) as Record<
    AIProviderCredentialType,
    boolean
  >;
}

/**
 * Deletes the stored credential for (userId, provider), if any -- a no-op
 * if none was stored. Deliberately does not touch
 * `projects.active_ai_provider` even if the deleted provider was active:
 * lib/ai/index.ts's getAIProviders() already handles "active provider set
 * but credential missing" by throwing the same
 * AIProviderError{kind:"no_credentials"} as "no active provider at all",
 * so the user sees the same "add a key" prompt either way without this
 * function needing a second write on every delete.
 */
export async function deleteAIProviderCredential(
  supabase: SupabaseClient,
  userId: string,
  provider: AIProviderCredentialType
): Promise<void> {
  const { error } = await supabase
    .from("ai_provider_credentials")
    .delete()
    .eq("user_id", userId)
    .eq("provider", provider);
  if (error) {
    throw new Error(`deleteAIProviderCredential: failed to delete ${provider} credential: ${error.message}`);
  }
}

interface ProjectActiveProviderRow {
  active_ai_provider: ActiveAIProvider | null;
}

/**
 * Reads `projects.active_ai_provider` for `projectId`. A `projects` row
 * always exists by the time this is called -- every project is created
 * with a (possibly null) `active_ai_provider` column. A missing project is
 * therefore a real error, not "not configured yet": the caller must
 * already have verified project ownership before calling anything in
 * lib/ai/ (see CLAUDE.md / the match_document_chunks RPC's security
 * comment), so a stale/bogus projectId reaching this far is a caller bug.
 */
export async function getActiveProvider(
  supabase: SupabaseClient,
  projectId: string
): Promise<ActiveAIProvider | null> {
  const { data, error } = await supabase
    .from("projects")
    .select("active_ai_provider")
    .eq("id", projectId)
    .maybeSingle<ProjectActiveProviderRow>();
  if (error) {
    throw new Error(`getActiveProvider: failed to load project ${projectId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`getActiveProvider: project ${projectId} does not exist`);
  }
  return data.active_ai_provider ?? null;
}

/**
 * Thrown by setActiveProvider()/setProjectEmbeddingProvider() when the
 * requested provider's credential hasn't been saved yet. A distinct class so
 * the API route can map it to a 400 with an actionable message instead of a
 * generic 500 -- an expected user state, not a server fault.
 */
export class MissingProviderCredentialsError extends Error {
  readonly provider: AIProviderCredentialType;
  readonly missing: AIProviderCredentialType[];

  constructor(provider: AIProviderCredentialType, missing: AIProviderCredentialType[]) {
    super(
      `cannot use '${provider}' -- missing credential(s): ${missing.join(", ")}. Save ${
        missing.length > 1 ? "them" : "it"
      } first via POST /api/profile/ai-providers.`
    );
    this.name = "MissingProviderCredentialsError";
    this.provider = provider;
    this.missing = missing;
  }
}

/** Providers a project can pick for embeddings -- Anthropic has no embeddings API (matches projects_embedding_provider_not_anthropic). */
export type EmbeddingProviderType = Exclude<AIProviderCredentialType, "anthropic">;

/** Thrown by setProjectEmbeddingProvider() when the project already has documents embedded with its current model. */
export class EmbeddingProviderLockedError extends Error {
  constructor(projectId: string) {
    super(`setProjectEmbeddingProvider: project ${projectId} already has documents embedded with its current model`);
    this.name = "EmbeddingProviderLockedError";
  }
}

interface OwnedProjectRow {
  id: string;
  user_id: string;
  embedding_provider: EmbeddingProviderType | null;
}

/** Defense in depth against a caller-side scoping bug (the primary ownership check is the caller's RLS-scoped one). */
async function requireProjectOwnedBy(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  caller: string
): Promise<OwnedProjectRow> {
  const { data, error } = await supabase
    .from("projects")
    .select("id, user_id, embedding_provider")
    .eq("id", projectId)
    .maybeSingle<OwnedProjectRow>();
  if (error) {
    throw new Error(`${caller}: failed to load project ${projectId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`${caller}: project ${projectId} does not exist`);
  }
  if (data.user_id !== ownerUserId) {
    throw new Error(`${caller}: project ${projectId} belongs to user ${data.user_id}, not ${ownerUserId}`);
  }
  return data;
}

async function countProjectDocuments(supabase: SupabaseClient, projectId: string): Promise<number> {
  const { count, error } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (error) {
    throw new Error(`countProjectDocuments: failed to count documents for project ${projectId}: ${error.message}`);
  }
  return count ?? 0;
}

/**
 * The project's embedding model, and whether it's locked: once a model is
 * chosen and the project has documents, those vectors only compare with the
 * same model, so it can't be changed.
 */
export async function getProjectEmbeddingState(
  supabase: SupabaseClient,
  projectId: string
): Promise<{ provider: EmbeddingProviderType | null; locked: boolean }> {
  const { data, error } = await supabase
    .from("projects")
    .select("embedding_provider")
    .eq("id", projectId)
    .maybeSingle<{ embedding_provider: EmbeddingProviderType | null }>();
  if (error) {
    throw new Error(`getProjectEmbeddingState: failed to load project ${projectId}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`getProjectEmbeddingState: project ${projectId} does not exist`);
  }
  const locked = data.embedding_provider !== null && (await countProjectDocuments(supabase, projectId)) > 0;
  return { provider: data.embedding_provider, locked };
}

/**
 * Sets `projects.embedding_provider`. The first choice is always allowed;
 * changing it is refused with EmbeddingProviderLockedError once the project
 * has documents. Re-selecting the current provider is a no-op.
 */
export async function setProjectEmbeddingProvider(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  provider: EmbeddingProviderType
): Promise<void> {
  const project = await requireProjectOwnedBy(supabase, projectId, ownerUserId, "setProjectEmbeddingProvider");
  if (project.embedding_provider === provider) return;

  if (!(await hasAIProviderCredential(supabase, ownerUserId, provider))) {
    throw new MissingProviderCredentialsError(provider, [provider]);
  }
  if (project.embedding_provider !== null && (await countProjectDocuments(supabase, projectId)) > 0) {
    throw new EmbeddingProviderLockedError(projectId);
  }

  const { error } = await supabase.from("projects").update({ embedding_provider: provider }).eq("id", projectId);
  if (error) {
    throw new Error(`setProjectEmbeddingProvider: failed to update project ${projectId}: ${error.message}`);
  }
}

/**
 * Sets `projects.active_ai_provider` (the chat model) for `projectId`, after
 * checking the project belongs to `ownerUserId` and the owner has saved this
 * provider's key -- so the column never points at an unusable provider.
 * Switching it never touches stored vectors: embeddings are a separate
 * setting (setProjectEmbeddingProvider()).
 */
export async function setActiveProvider(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  provider: ActiveAIProvider
): Promise<void> {
  await requireProjectOwnedBy(supabase, projectId, ownerUserId, "setActiveProvider");

  if (!(await hasAIProviderCredential(supabase, ownerUserId, provider))) {
    throw new MissingProviderCredentialsError(provider, [provider]);
  }

  const { error } = await supabase
    .from("projects")
    .update({ active_ai_provider: provider })
    .eq("id", projectId);
  if (error) {
    throw new Error(`setActiveProvider: failed to update project ${projectId}: ${error.message}`);
  }
}
