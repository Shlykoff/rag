// lib/channels/telegram/integration-store.ts
//
// Server-side read/write of per-project Telegram channel configuration
// (`channel_integrations` where channel = 'telegram'), encrypting/
// decrypting via lib/channels/telegram/crypto.ts. Mirrors
// lib/ai/credentials.ts's shape (save/get/has/delete) -- see that file's
// own header for the bytea-encoding note this module duplicates rather
// than imports (lib/channels/** is import-boundary-isolated from lib/ai/,
// see CLAUDE.md rule 8).
//
// Unlike lib/ai/credentials.ts's four independent provider credentials per
// user, Telegram only ever needs ONE credential blob per project (the
// unique constraint is (project_id, channel) -- see the migration), so
// this module's functions take just `projectId`, not a provider/type
// parameter.
//
// The stored credential blob packs TWO secrets into one ciphertext (the
// Bot API token AND the webhook secret token) as a single JSON string
// before encryption -- channel_integrations only has one
// ciphertext/nonce column pair (see that table's shape), so this mirrors
// how lib/sources/credentials.ts already stores Google's multi-field
// service-account JSON as one opaque string rather than needing a second
// column.

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptChannelCredential, decryptChannelCredential } from "./crypto";
import type { ChannelIntegrationConfig } from "../types";

export interface TelegramCredentials {
  botToken: string;
  webhookSecret: string;
}

export interface TelegramIntegrationRecord extends ChannelIntegrationConfig {
  channel: "telegram";
  credentials: TelegramCredentials;
  enabled: boolean;
  displayLabel: string | null;
}

interface ChannelIntegrationRow {
  id: string;
  project_id: string;
  credential_ciphertext: string;
  credential_nonce: string;
  encryption_key_version: number;
  enabled: boolean;
  display_label: string | null;
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
  // this default. Same defensive fallback as lib/ai/credentials.ts /
  // lib/sources/credentials.ts.
  return Buffer.from(value, "base64");
}

function rowToRecord(row: ChannelIntegrationRow): TelegramIntegrationRecord {
  const plaintext = decryptChannelCredential({
    ciphertext: byteaToBuffer(row.credential_ciphertext),
    nonce: byteaToBuffer(row.credential_nonce),
    keyVersion: row.encryption_key_version,
  });
  const credentials = JSON.parse(plaintext) as TelegramCredentials;
  return {
    id: row.id,
    projectId: row.project_id,
    channel: "telegram",
    credentials,
    enabled: row.enabled,
    displayLabel: row.display_label,
  };
}

const SELECT_COLUMNS = "id, project_id, credential_ciphertext, credential_nonce, encryption_key_version, enabled, display_label";

/**
 * Upserts (insert-or-replace) the Telegram credentials for `projectId`.
 * One row per (project, 'telegram') -- see
 * channel_integrations_one_per_project_channel -- so re-saving (e.g. the
 * owner rotates their bot token) replaces the old value rather than
 * accumulating rows.
 */
export async function saveTelegramIntegration(
  supabase: SupabaseClient,
  projectId: string,
  credentials: TelegramCredentials,
  displayLabel?: string | null
): Promise<{ id: string }> {
  const encrypted = encryptChannelCredential(JSON.stringify(credentials));
  const { data, error } = await supabase
    .from("channel_integrations")
    .upsert(
      {
        project_id: projectId,
        channel: "telegram",
        credential_ciphertext: bufferToBytea(encrypted.ciphertext),
        credential_nonce: bufferToBytea(encrypted.nonce),
        encryption_key_version: encrypted.keyVersion,
        display_label: displayLabel ?? null,
      },
      { onConflict: "project_id,channel" }
    )
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`saveTelegramIntegration: failed to store integration for project ${projectId}: ${error?.message ?? "no row returned"}`);
  }
  return { id: data.id as string };
}

/**
 * Returns the decrypted Telegram integration for `projectId`, or null if
 * none is configured. Callers must treat `.credentials` as a secret: never
 * log it, never include it in a thrown error's message, never return it
 * from an API route.
 */
export async function getTelegramIntegrationByProject(
  supabase: SupabaseClient,
  projectId: string
): Promise<TelegramIntegrationRecord | null> {
  const { data, error } = await supabase
    .from("channel_integrations")
    .select(SELECT_COLUMNS)
    .eq("project_id", projectId)
    .eq("channel", "telegram")
    .maybeSingle<ChannelIntegrationRow>();
  if (error) {
    throw new Error(`getTelegramIntegrationByProject: failed to load integration for project ${projectId}: ${error.message}`);
  }
  if (!data) return null;
  return rowToRecord(data);
}

/**
 * Returns the decrypted Telegram integration by its own `id` (the
 * webhook's path segment, `/api/channels/telegram/{integrationId}`) --
 * this is the ONLY lookup an inbound webhook request can use, since it
 * carries no project id of its own (see lib/gateway/answer.ts's module
 * header on why project_id never comes from the inbound payload).
 */
export async function getTelegramIntegrationById(
  supabase: SupabaseClient,
  integrationId: string
): Promise<TelegramIntegrationRecord | null> {
  const { data, error } = await supabase
    .from("channel_integrations")
    .select(SELECT_COLUMNS)
    .eq("id", integrationId)
    .eq("channel", "telegram")
    .maybeSingle<ChannelIntegrationRow>();
  if (error) {
    throw new Error(`getTelegramIntegrationById: failed to load integration ${integrationId}: ${error.message}`);
  }
  if (!data) return null;
  return rowToRecord(data);
}

/** Deletes the stored Telegram integration for `projectId`, if any -- a no-op (not an error) if none was stored. Cascades to that integration's channel_processed_updates rows via the FK (on delete cascade, see that table's migration). */
export async function deleteTelegramIntegration(supabase: SupabaseClient, projectId: string): Promise<void> {
  const { error } = await supabase
    .from("channel_integrations")
    .delete()
    .eq("project_id", projectId)
    .eq("channel", "telegram");
  if (error) {
    throw new Error(`deleteTelegramIntegration: failed to delete integration for project ${projectId}: ${error.message}`);
  }
}
