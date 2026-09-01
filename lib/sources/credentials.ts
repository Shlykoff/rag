// lib/sources/credentials.ts
//
// Server-side read/write of per-user source credentials
// (`source_credentials`), encrypting/decrypting via lib/sources/crypto.ts.
// notion.ts / google-drive.ts call getSourceCredential() to obtain the
// plaintext token/JSON right before using it against the Notion/Google
// API, and never store or log it beyond that call.
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

export type SourceCredentialType = "notion" | "google_drive";

interface SourceCredentialRow {
  credential_ciphertext: string;
  credential_nonce: string;
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
 * Upserts (insert-or-replace) the encrypted credential for `sourceType`.
 * One row per (user, source_type) -- see the
 * source_credentials_one_per_user_source unique constraint -- so re-saving
 * (e.g. the user pastes a rotated Notion token) replaces the old value
 * rather than accumulating rows.
 */
export async function saveSourceCredential(
  supabase: SupabaseClient,
  userId: string,
  sourceType: SourceCredentialType,
  plaintext: string
): Promise<void> {
  const encrypted = encryptCredential(plaintext);
  const { error } = await supabase.from("source_credentials").upsert(
    {
      user_id: userId,
      source_type: sourceType,
      credential_ciphertext: bufferToBytea(encrypted.ciphertext),
      credential_nonce: bufferToBytea(encrypted.nonce),
      encryption_key_version: encrypted.keyVersion,
    },
    { onConflict: "user_id,source_type" }
  );
  if (error) {
    throw new Error(`saveSourceCredential: failed to store ${sourceType} credential: ${error.message}`);
  }
}

/**
 * Returns the decrypted credential for (userId, sourceType), or null if
 * none is stored. Callers (notion.ts/google-drive.ts) must treat the
 * return value as a secret: never log it, never include it in a thrown
 * error's `message`/`userMessage`, never return it from an API route.
 */
export async function getSourceCredential(
  supabase: SupabaseClient,
  userId: string,
  sourceType: SourceCredentialType
): Promise<string | null> {
  const { data, error } = await supabase
    .from("source_credentials")
    .select("credential_ciphertext, credential_nonce, encryption_key_version")
    .eq("user_id", userId)
    .eq("source_type", sourceType)
    .maybeSingle<SourceCredentialRow>();
  if (error) {
    throw new Error(`getSourceCredential: failed to load ${sourceType} credential: ${error.message}`);
  }
  if (!data) return null;
  return decryptCredential({
    ciphertext: byteaToBuffer(data.credential_ciphertext),
    nonce: byteaToBuffer(data.credential_nonce),
    keyVersion: data.encryption_key_version,
  });
}

/** Connection-status check for the UI/API ("is Notion connected: yes/no") that never touches the ciphertext -- see app/api/sources/credentials/route.ts's GET handler. */
export async function hasSourceCredential(
  supabase: SupabaseClient,
  userId: string,
  sourceType: SourceCredentialType
): Promise<boolean> {
  const { count, error } = await supabase
    .from("source_credentials")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("source_type", sourceType);
  if (error) {
    throw new Error(`hasSourceCredential: failed to check ${sourceType} credential: ${error.message}`);
  }
  return (count ?? 0) > 0;
}
