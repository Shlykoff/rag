// lib/crypto/secret-box.ts
//
// Domain-neutral AES-256-GCM encrypt/decrypt for any bearer secret this
// project needs to store at rest (an AI-provider API key, a Notion
// Internal Integration Secret / Google service-account JSON, a Telegram
// Bot API token). Extracted from what used to be THREE byte-for-byte
// identical implementations (lib/ai/crypto.ts, lib/sources/crypto.ts,
// lib/channels/telegram/crypto.ts) -- same scheme, same
// CREDENTIALS_ENCRYPTION_KEY env var, same threat model, just copy-pasted
// three times as each domain was built. Those three files are now thin
// re-exports of this module (see each file's own header) so every existing
// caller/import/test keeps working unchanged.
//
// Naming this module `lib/crypto/` (not `lib/ai/`, `lib/sources/`, or
// `lib/channels/`) is deliberate: it's a NEUTRAL module none of those three
// domains own, so all three importing it does not recreate the
// cross-domain dependency the original duplication was specifically trying
// to avoid (see the domain-specific files' own headers on why they were
// kept separate before). This is doubly load-bearing for
// lib/channels/telegram/crypto.ts specifically -- CLAUDE.md's enforced
// import boundary (non-negotiable rule 8) only forbids lib/channels/**
// from importing lib/chat/, lib/retrieval/, lib/ai/, or lib/rate-limit/;
// lib/crypto/ is none of those, so this does not violate that boundary.
//
// AES-256-GCM: an AEAD cipher, so a ciphertext that's been tampered with
// (bit-flipped, truncated, swapped with a different row) fails to decrypt
// instead of silently producing garbage plaintext -- important since every
// caller's "plaintext" is a bearer credential handed straight to an
// external API.
//
// The key itself lives ONLY in the `CREDENTIALS_ENCRYPTION_KEY` env var,
// never in the database (see .env.example for how to generate one) --
// CLAUDE.md's threat model for this: a leaked DB dump/backup alone must not
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
