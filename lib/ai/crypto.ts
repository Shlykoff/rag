// lib/ai/crypto.ts
//
// Application-level encryption for `ai_provider_credentials.api_key_ciphertext`
// (a user's own OpenAI/Anthropic/Voyage/Gemini API key, bring-your-own-key).
//
// Thin re-export of lib/crypto/secret-box.ts's domain-neutral AES-256-GCM
// implementation -- see that module's header for why it's a shared,
// domain-neutral module rather than each domain importing another, and why
// this file re-exports under its own naming instead of lib/ai/credentials.ts
// importing lib/crypto/secret-box.ts directly.

import "server-only";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "../crypto/secret-box";

export type EncryptedCredential = EncryptedSecret;

/** Encrypts `plaintext` (a provider API key, e.g. `sk-...`/`AQ....`) for storage in ai_provider_credentials. Never logs the input. */
export const encryptCredential = encryptSecret;

/**
 * Decrypts a row read back from ai_provider_credentials. Throws (rather than
 * returning corrupted/garbage text) if the auth tag doesn't verify -- e.g.
 * the row was tampered with, or CREDENTIALS_ENCRYPTION_KEY doesn't match the
 * key it was encrypted under. Callers must never log the return value.
 */
export const decryptCredential = decryptSecret;
