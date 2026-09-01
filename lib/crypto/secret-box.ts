// lib/crypto/secret-box.ts
//
// Domain-neutral AES-256-GCM encrypt/decrypt for any bearer secret this
// project stores at rest (an AI-provider API key, a Notion Internal
// Integration Secret / Google service-account JSON, a Telegram Bot API
// token). Same scheme, same `CREDENTIALS_ENCRYPTION_KEY` env var, same
// threat model across all of them. lib/ai/crypto.ts, lib/sources/crypto.ts,
// and lib/channels/telegram/crypto.ts are thin re-exports of this module
// (see each file's own header), not independent implementations --
// duplicated as thin re-exports rather than imported directly by each
// domain's own consumers, so each domain keeps its own naming
// (`encryptCredential`, etc.) and doc comments stable for existing callers.
//
// This module lives in a neutral `lib/crypto/` location, not under any one
// of `lib/ai/`, `lib/sources/`, or `lib/channels/`, so all three importing
// it doesn't create a cross-domain dependency between them. This matters
// most for lib/channels/telegram/crypto.ts: CLAUDE.md rule 8 forbids
// lib/channels/** from importing lib/chat/, lib/retrieval/, lib/ai/, or
// lib/rate-limit/ -- lib/crypto/ is none of those, so importing it here
// doesn't violate that boundary.
//
// AES-256-GCM: an AEAD cipher, so tampered ciphertext (bit-flipped,
// truncated, swapped with a different row) fails to decrypt instead of
// silently producing garbage plaintext -- every caller's "plaintext" is a
// bearer credential handed straight to an external API.
//
// The key lives only in the `CREDENTIALS_ENCRYPTION_KEY` env var, never in
// the database (see .env.example) -- a leaked DB dump/backup alone must not
// be enough to recover any stored secret.

import "server-only";
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit GCM nonce -- the size the spec recommends for best performance/security
const AUTH_TAG_BYTES = 16;

// Bumped only if CREDENTIALS_ENCRYPTION_KEY is ever rotated to a new key AND
// old rows still need to decrypt under the previous one -- see each
// caller's own `encryption_key_version` column comment. This implementation
// supports exactly one active key (no rotation/version lookup table yet);
// decryptSecret() fails loudly rather than silently misinterpreting a row
// written under a version it doesn't recognize.
const CURRENT_KEY_VERSION = 1;

function loadKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "Missing CREDENTIALS_ENCRYPTION_KEY env var -- required to encrypt/decrypt stored secrets. " +
        "Generate one with `openssl rand -hex 32`. See .env.example."
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CREDENTIALS_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex characters) for AES-256-GCM, got ${key.length} bytes. Generate one with \`openssl rand -hex 32\`.`
    );
  }
  return key;
}

export interface EncryptedSecret {
  /** Ciphertext with the GCM authentication tag appended (last 16 bytes). */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

/** Encrypts `plaintext` (any bearer secret -- an API key, a JSON service-account blob, a packed { botToken, webhookSecret } string, ...) for storage. Never logs the input. */
export function encryptSecret(plaintext: string): EncryptedSecret {
  const key = loadKey();
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    // Auth tag travels appended to the ciphertext (not the nonce column) --
    // it's an integrity check over THIS ciphertext, not part of the nonce.
    ciphertext: Buffer.concat([encrypted, authTag]),
    nonce,
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Decrypts a previously-encrypted secret. Throws (rather than returning
 * corrupted/garbage text) if the auth tag doesn't verify -- e.g. the row
 * was tampered with, or CREDENTIALS_ENCRYPTION_KEY doesn't match the key it
 * was encrypted under. Callers must never log the return value.
 */
export function decryptSecret(encrypted: { ciphertext: Buffer; nonce: Buffer; keyVersion: number }): string {
  if (encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(
      `decryptSecret: unsupported encryption_key_version ${encrypted.keyVersion} (this deployment only has key version ${CURRENT_KEY_VERSION} configured). Implement a key-version lookup here before rotating CREDENTIALS_ENCRYPTION_KEY.`
    );
  }
  if (encrypted.ciphertext.length < AUTH_TAG_BYTES) {
    throw new Error("decryptSecret: stored ciphertext is shorter than the GCM auth tag -- data is corrupt.");
  }
  const key = loadKey();
  const authTag = encrypted.ciphertext.subarray(encrypted.ciphertext.length - AUTH_TAG_BYTES);
  const ciphertextOnly = encrypted.ciphertext.subarray(0, encrypted.ciphertext.length - AUTH_TAG_BYTES);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, encrypted.nonce);
  decipher.setAuthTag(authTag);
  // Throws (GCM tag mismatch) if the ciphertext/nonce/key don't all match --
  // this is the "fails to decrypt instead of decrypting to garbage" property
  // referenced in the module header.
  const decrypted = Buffer.concat([decipher.update(ciphertextOnly), decipher.final()]);
  return decrypted.toString("utf8");
}
