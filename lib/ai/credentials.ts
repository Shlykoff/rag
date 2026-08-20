// lib/ai/credentials.ts
//
// Server-side read/write of per-user AI-provider credentials
// (`ai_provider_credentials`) and the per-user active-provider selection
// (`user_settings.active_ai_provider`), encrypting/decrypting via
// lib/ai/crypto.ts. lib/ai/index.ts's getAIProviders() calls
// getActiveProvider()/getAIProviderCredential() to build the active
// ChatProvider/EmbeddingsProvider pair for one request, and
// app/api/profile/ai-providers/route.ts calls every export here directly.
// Deliberately mirrors lib/sources/credentials.ts's shape (including the
// bytea hex-encoding helpers, duplicated rather than imported -- see
// lib/ai/crypto.ts's header for why lib/ai/ and lib/sources/ stay
// domain-isolated) -- not extracted into a shared module.
//
// bytea encoding note: PostgREST (what supabase-js talks to) represents
// Postgres `bytea` columns as a hex string prefixed "\x" on both read and
// write by default (Postgres's own `bytea_output = 'hex'` default) -- NOT
// base64 and NOT a raw Buffer over the JSON wire. bufferToBytea/byteaToBuffer
// below are the only place that encoding is handled, so a future change to
// the column type or output format only needs updating here.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredential, decryptCredential } from "./crypto";

/** Matches the `ai_provider_type` Postgres enum exactly (see the ai_provider_credentials migration) -- every provider that can hold a stored API key, including 'voyage' (Anthropic's fixed embeddings pairing, never independently selectable as an active provider -- see ActiveAIProvider below). */
export type AIProviderCredentialType = "openai" | "anthropic" | "gemini" | "voyage";

/** The subset of AIProviderCredentialType that can actually be `user_settings.active_ai_provider` -- excludes 'voyage', enforced both by the DB CHECK constraint (user_settings_active_provider_not_voyage) and by this narrower type, so a caller can't even attempt to pass 'voyage' to setActiveProvider() without a compile error. */
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
 * Deletes the stored credential for (userId, provider), if any -- a no-op
 * (not an error) if none was stored. Deliberately does NOT touch
 * `user_settings.active_ai_provider` even if the deleted provider was the
 * active one: lib/ai/index.ts's getAIProviders() already handles "active
 * provider set, but its credential is missing" by throwing the same
 * AIProviderError{kind:"no_credentials"} as "no active provider at all" --
 * so the user sees the same "add a key" prompt either way, without this
 * function needing a second write (and a second failure mode to handle) on
 * every delete.
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

interface UserSettingsRow {
  active_ai_provider: ActiveAIProvider | null;
}

/** Reads `user_settings.active_ai_provider` -- null both when the row doesn't exist yet (brand-new user, see the user_settings migration's "lazy row" comment) and when it exists but the column itself is null. Callers never need to distinguish those two cases. */
export async function getActiveProvider(
  supabase: SupabaseClient,
  userId: string
): Promise<ActiveAIProvider | null> {
  const { data, error } = await supabase
    .from("user_settings")
    .select("active_ai_provider")
    .eq("user_id", userId)
    .maybeSingle<UserSettingsRow>();
  if (error) {
    throw new Error(`getActiveProvider: failed to load user_settings: ${error.message}`);
  }
  return data?.active_ai_provider ?? null;
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
 * Sets `user_settings.active_ai_provider`, upserting the (lazily-created --
 * see the user_settings migration comment) row for this user.
 *
 * This is the app-level enforcement of "active_ai_provider must reference
 * credentials the user actually has" that the ai_provider_credentials/
 * user_settings migration deliberately left unimplemented at the DB layer
 * (see that migration's column comment on user_settings.active_ai_provider):
 * checked HERE, before the write, not after -- so a rejected call never
 * leaves user_settings pointing at a provider with no usable credential.
 * 'anthropic' specifically requires BOTH an 'anthropic' row (the chat model)
 * AND a 'voyage' row (Anthropic has no embeddings API of its own -- see
 * lib/ai/index.ts's PROVIDER_REGISTRY) to exist before it can be activated;
 * every other provider just needs its own single row.
 */
export async function setActiveProvider(
  supabase: SupabaseClient,
  userId: string,
  provider: ActiveAIProvider
): Promise<void> {
  const required: AIProviderCredentialType[] = provider === "anthropic" ? ["anthropic", "voyage"] : [provider];
  const haveEach = await Promise.all(
    required.map((p) => hasAIProviderCredential(supabase, userId, p))
  );
  const missing = required.filter((_, i) => !haveEach[i]);
  if (missing.length > 0) {
    throw new MissingProviderCredentialsError(provider, missing);
  }

  const { error } = await supabase
    .from("user_settings")
    .upsert({ user_id: userId, active_ai_provider: provider }, { onConflict: "user_id" });
  if (error) {
    throw new Error(`setActiveProvider: failed to update user_settings: ${error.message}`);
  }
}
