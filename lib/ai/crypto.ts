// lib/ai/crypto.ts
//
// Application-level encryption for `ai_provider_credentials.api_key_ciphertext`
// (a user's own OpenAI / Anthropic / Voyage / Gemini API key, bring-your-own-key
// -- see the ai_provider_credentials migration's header comment). Deliberately
// a near-duplicate of lib/sources/crypto.ts (same AES-256-GCM scheme, same
// CREDENTIALS_ENCRYPTION_KEY env var, same threat model), NOT imported from
// there: this project keeps lib/ai/ and lib/sources/ fully domain-isolated
// (zero cross-imports today) rather than factor a "shared crypto module" that
// would make either specialist's future encryption change a cross-domain
// dependency. Reusing the SAME env var (not a second one) is intentional --
// both tables store the same *kind* of secret (a bearer credential handed to
// an external API) under the same threat model, so provisioning a second
// encryption key for no functional difference would only be an extra thing
// to lose/rotate/document.
//
// AES-256-GCM: an AEAD cipher, so a ciphertext that's been tampered with
// (bit-flipped, truncated, swapped with a different row) fails to decrypt
// instead of silently producing garbage plaintext -- important here since the
// "plaintext" is an AI-provider API key that gets handed straight to the
// matching vendor SDK (lib/ai/providers/*.ts).
//
// The key itself lives ONLY in the `CREDENTIALS_ENCRYPTION_KEY` env var,
// never in the database (see .env.example for how to generate one) --
// CLAUDE.md's threat model for this: a leaked DB dump/backup alone must not
// be enough to recover any user's stored AI-provider API key.

import "server-only";
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32; // AES-256
const NONCE_BYTES = 12; // 96-bit GCM nonce -- the size the spec recommends for best performance/security
const AUTH_TAG_BYTES = 16;

// Bumped only if CREDENTIALS_ENCRYPTION_KEY is ever rotated to a new key AND
// old rows still need to decrypt under the previous one -- see
// ai_provider_credentials.encryption_key_version's column comment. This
// implementation supports exactly one active key (no rotation/version lookup
// table yet); decryptCredential() fails loudly rather than silently
// misinterpreting a row written under a version it doesn't recognize.
const CURRENT_KEY_VERSION = 1;

function loadKey(): Buffer {
  const hex = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "Missing CREDENTIALS_ENCRYPTION_KEY env var -- required to encrypt/decrypt ai_provider_credentials. " +
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

export interface EncryptedCredential {
  /** Ciphertext with the GCM authentication tag appended (last 16 bytes). */
  ciphertext: Buffer;
  nonce: Buffer;
  keyVersion: number;
}

/** Encrypts `plaintext` (a provider API key, e.g. `sk-...`/`AQ....`) for storage in ai_provider_credentials. Never logs the input. */
export function encryptCredential(plaintext: string): EncryptedCredential {
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
 * Decrypts a row read back from ai_provider_credentials. Throws (rather than
 * returning corrupted/garbage text) if the auth tag doesn't verify -- e.g.
 * the row was tampered with, or CREDENTIALS_ENCRYPTION_KEY doesn't match the
 * key it was encrypted under. Callers must never log the return value.
 */
export function decryptCredential(encrypted: { ciphertext: Buffer; nonce: Buffer; keyVersion: number }): string {
  if (encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new Error(
      `decryptCredential: unsupported encryption_key_version ${encrypted.keyVersion} (this deployment only has key version ${CURRENT_KEY_VERSION} configured). Implement a key-version lookup here before rotating CREDENTIALS_ENCRYPTION_KEY.`
    );
  }
  if (encrypted.ciphertext.length < AUTH_TAG_BYTES) {
    throw new Error("decryptCredential: stored ciphertext is shorter than the GCM auth tag -- data is corrupt.");
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
