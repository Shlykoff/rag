// lib/ai/credentials.ts
//
// Server-side read/write of per-user, account-level AI-provider API keys
// (`ai_provider_credentials`, encrypted at rest via lib/ai/crypto.ts).
// Which model a project uses is project-scoped: lib/ai/model-selection.ts.
// Mirrors lib/sources/credentials.ts's shape, duplicated rather than
// imported -- see lib/ai/crypto.ts's header for why lib/ai/ and
// lib/sources/ stay domain-isolated.
//
// bytea encoding: PostgREST represents `bytea` as a "\x"-prefixed hex string
// on read and write (Postgres's default bytea_output = 'hex'), not base64.
// bufferToBytea/byteaToBuffer are the only place that is handled.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptCredential, decryptCredential } from "./crypto";

/** Matches the `ai_provider_type` Postgres enum: every provider that can hold a stored API key. */
export type AIProviderCredentialType = "openai" | "anthropic" | "gemini" | "voyage";

export const ALL_CREDENTIAL_PROVIDERS: AIProviderCredentialType[] = ["openai", "anthropic", "gemini", "voyage"];

/** Providers with a chat API (Voyage is embeddings-only). */
export type ActiveAIProvider = Exclude<AIProviderCredentialType, "voyage">;

/** Providers with an embeddings API (Anthropic has none). */
export type EmbeddingProviderType = Exclude<AIProviderCredentialType, "anthropic">;

export const CHAT_MODEL_PROVIDERS: readonly ActiveAIProvider[] = ["openai", "anthropic", "gemini"];

export const EMBEDDING_MODEL_PROVIDERS: readonly EmbeddingProviderType[] = ["openai", "gemini", "voyage"];

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
  // Fallback for a non-default bytea_output or a client that base64-encodes
  // bytea itself -- better than making every stored key undecryptable.
  return Buffer.from(value, "base64");
}

/**
 * Upserts the encrypted API key for `provider` -- one row per (user,
 * provider), so re-saving (key rotation) replaces the old value.
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
 * stored. The result is a secret: never log it, put it in an error message,
 * or return it from an API route.
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

/** Whether a key is stored, without touching the ciphertext. */
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

/** `{ openai: boolean, ... }` for every provider in ALL_CREDENTIAL_PROVIDERS, checked concurrently. */
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
 * Deletes the stored key for (userId, provider); a no-op if none is stored.
 * Project model selections that use this provider are left as they are:
 * getAIProviders() reports the missing key as no_credentials (a 422), the
 * same prompt as "nothing configured".
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
