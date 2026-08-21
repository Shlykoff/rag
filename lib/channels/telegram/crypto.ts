// lib/channels/telegram/crypto.ts
//
// Application-level encryption for `channel_integrations.credential_ciphertext`
// (a project's Telegram Bot API token + webhook secret, packed together --
// see integration-store.ts). Deliberately a near-duplicate of
// lib/ai/crypto.ts (itself a near-duplicate of lib/sources/crypto.ts) --
// same AES-256-GCM scheme, same CREDENTIALS_ENCRYPTION_KEY env var, same
// threat model -- NOT imported from either: this project keeps lib/ai/,
// lib/sources/, and now lib/channels/ fully domain-isolated (zero
// cross-imports) rather than factor a "shared crypto module" that would
// make any one specialist's future encryption change a cross-domain
// dependency. This is doubly deliberate here specifically because
// lib/channels/** has an ENFORCED import boundary (CLAUDE.md rule 8): it
// may not import lib/ai/ at all, so lib/channels/telegram/crypto.ts being
// its own copy isn't just stylistic consistency with the rest of the
// codebase, it's required by that boundary.
//
// Reusing the SAME env var as lib/ai/crypto.ts / lib/sources/crypto.ts
// (not a third one) is intentional -- all three tables store the same
// *kind* of secret (a bearer credential handed to an external API) under
// the same threat model, so provisioning a third encryption key for no
// functional difference would only be an extra thing to lose/rotate/
// document.
//
// AES-256-GCM: an AEAD cipher, so a ciphertext that's been tampered with
// (bit-flipped, truncated, swapped with a different row) fails to decrypt
// instead of silently producing garbage plaintext -- important here since
// the "plaintext" is a Telegram Bot API token that gets handed straight to
// lib/channels/telegram/client.ts's fetch calls.
//
// The key itself lives ONLY in the `CREDENTIALS_ENCRYPTION_KEY` env var,
// never in the database (see .env.example for how to generate one).

import "server-only";
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit GCM nonce -- the size the spec recommends for best performance/security
const AUTH_TAG_BYTES = 16;

// Bumped only if CREDENTIALS_ENCRYPTION_KEY is ever rotated to a new key AND
// old rows still need to decrypt under the previous one -- see
// channel_integrations.encryption_key_version's column comment. This
// implementation supports exactly one active key (no rotation/version lookup
// table yet); decryptChannelCredential() fails loudly rather than silently
// misinterpreting a row written under a version it doesn't recognize.
const CURRENT_KEY_VERSION = 1;

function loadKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "Missing CREDENTIALS_ENCRYPTION_KEY env var -- required to encrypt/decrypt channel_integrations. " +
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

export interface EncryptedChannelCredential {
  /** Ciphertext with the GCM authentication tag appended (last 16 bytes). */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

/** Encrypts `plaintext` (a JSON-packed { botToken, webhookSecret } string -- see integration-store.ts) for storage in channel_integrations. Never logs the input. */
export function encryptChannelCredential(plaintext: string): EncryptedChannelCredential {
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
 * Decrypts a row read back from channel_integrations. Throws (rather than
 * returning corrupted/garbage text) if the auth tag doesn't verify -- e.g.
 * the row was tampered with, or CREDENTIALS_ENCRYPTION_KEY doesn't match the
 * key it was encrypted under. Callers must never log the return value.
 */
export function decryptChannelCredential(encrypted: { ciphertext: Buffer; nonce: Buffer; keyVersion: number }): string {
  if (encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(
      `decryptChannelCredential: unsupported encryption_key_version ${encrypted.keyVersion} (this deployment only has key version ${CURRENT_KEY_VERSION} configured). Implement a key-version lookup here before rotating CREDENTIALS_ENCRYPTION_KEY.`
    );
  }
  if (encrypted.ciphertext.length < AUTH_TAG_BYTES) {
    throw new Error("decryptChannelCredential: stored ciphertext is shorter than the GCM auth tag -- data is corrupt.");
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
