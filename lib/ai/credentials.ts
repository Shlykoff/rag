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
 * stored. Callers (lib/ai/index.ts's PROVIDER_REGISTRY builders) must treat
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
 * Thrown by setActiveProvider() when the requested provider isn't actually
 * usable yet (its credential -- or, for anthropic, one of its *two* required
 * credentials -- hasn't been saved). A distinct class (rather than a plain
 * Error) so callers (app/api/profile/ai-providers/route.ts) can map this
 * specifically to a 400 with an actionable message, instead of a generic 500
 * -- this is an expected "you tried to activate something you haven't
 * configured yet" user error, not a server fault.
 */
export class MissingProviderCredentialsError extends Error {
  readonly provider: ActiveAIProvider;
  readonly missing: AIProviderCredentialType[];

  constructor(provider: ActiveAIProvider, missing: AIProviderCredentialType[]) {
    super(
      `setActiveProvider: cannot activate '${provider}' -- missing credential(s): ${missing.join(", ")}. Save ${
        missing.length > 1 ? "them" : "it"
      } first via POST /api/profile/ai-providers.`
    );
    this.name = "MissingProviderCredentialsError";
    this.provider = provider;
    this.missing = missing;
  }
}

/**
 * Sets `projects.active_ai_provider` for `projectId`.
 *
 * `ownerUserId` is the caller's already server-validated notion of who owns
 * this project (verified via the RLS-scoped session client before this is
 * ever called). Two things are checked against it before the write, both
 * app-level rather than DB constraints (see the projects migration's
 * column comment):
 *   1. `projectId` actually belongs to `ownerUserId` -- defense in depth
 *      against a caller-side scoping bug (mirrors the
 *      `documentRow.project_id !== doc.projectId` guard in
 *      lib/ingestion/ingest.ts), not the primary enforcement boundary.
 *   2. `ownerUserId` actually holds the credential(s) `provider` needs --
 *      'anthropic' requires both an 'anthropic' row (chat) and a 'voyage'
 *      row (Anthropic has no embeddings API of its own -- see
 *      lib/ai/index.ts's PROVIDER_REGISTRY); every other provider needs
 *      just its own row.
 * Both checks run before the write, so a rejected call never leaves
 * `projects.active_ai_provider` pointing at a provider with no usable
 * credential.
 */
export async function setActiveProvider(
  supabase: SupabaseClient,
  projectId: string,
  ownerUserId: string,
  provider: ActiveAIProvider
): Promise<void> {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .maybeSingle<{ id: string; user_id: string }>();
  if (projectError) {
    throw new Error(`setActiveProvider: failed to load project ${projectId}: ${projectError.message}`);
  }
  if (!project) {
    throw new Error(`setActiveProvider: project ${projectId} does not exist`);
  }
  if (project.user_id !== ownerUserId) {
    throw new Error(
      `setActiveProvider: project ${projectId} belongs to user ${project.user_id}, not ${ownerUserId}`
    );
  }

  const required: AIProviderCredentialType[] = provider === "anthropic" ? ["anthropic", "voyage"] : [provider];
  const haveEach = await Promise.all(
    required.map((p) => hasAIProviderCredential(supabase, ownerUserId, p))
  );
  const missing = required.filter((_, i) => !haveEach[i]);
  if (missing.length > 0) {
    throw new MissingProviderCredentialsError(provider, missing);
  }

  const { error } = await supabase
    .from("projects")
    .update({ active_ai_provider: provider })
    .eq("id", projectId);
  if (error) {
    throw new Error(`setActiveProvider: failed to update project ${projectId}: ${error.message}`);
  }
}
