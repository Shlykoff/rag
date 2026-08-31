// lib/ai/crypto.ts
//
// Application-level encryption for `ai_provider_credentials.api_key_ciphertext`
// (a user's own OpenAI / Anthropic / Voyage / Gemini API key, bring-your-own-key
// -- see the ai_provider_credentials migration's header comment).
//
// Thin re-export of lib/crypto/secret-box.ts's domain-neutral AES-256-GCM
// implementation -- this file, lib/sources/crypto.ts, and
// lib/channels/telegram/crypto.ts used to be three byte-for-byte identical
// copies of this same scheme; see that module's own header for why the
// shared implementation lives in a neutral `lib/crypto/` location instead
// of any one domain importing another. Kept as its own file (rather than
// having lib/ai/credentials.ts import lib/crypto/secret-box.ts directly) so
// this domain's own naming (`encryptCredential`/`decryptCredential`,
// `EncryptedCredential`) and doc comments stay put for every existing
// caller/test.
//
// Reusing the SAME env var (not a second one) is intentional -- both
// tables store the same *kind* of secret (a bearer credential handed to an
// external API) under the same threat model, so provisioning a second
// encryption key for no functional difference would only be an extra thing
// to lose/rotate/document.

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
