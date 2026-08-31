// lib/sources/crypto.ts
//
// Application-level encryption for `source_credentials.credential_ciphertext`
// (Notion Internal Integration Secret / Google Service Account JSON) --
// this is the "encrypt/decrypt code belongs to document-sources-specialist"
// half of the design the source_credentials migration deliberately left
// unimplemented (see that migration's header comment for the rationale:
// app-level AES-256-GCM, not Supabase Vault).
//
// Thin re-export of lib/crypto/secret-box.ts's domain-neutral AES-256-GCM
// implementation -- this file, lib/ai/crypto.ts, and
// lib/channels/telegram/crypto.ts used to be three byte-for-byte identical
// copies of this same scheme; see that module's own header for why the
// shared implementation lives in a neutral `lib/crypto/` location instead
// of any one domain importing another. Kept as its own file (rather than
// having lib/sources/credentials.ts import lib/crypto/secret-box.ts
// directly) so this domain's own naming
// (`encryptCredential`/`decryptCredential`, `EncryptedCredential`) and doc
// comments stay put for every existing caller/test.
//
// The key itself lives ONLY in the `CREDENTIALS_ENCRYPTION_KEY` env var,
// never in the database (see .env.example for how to generate one) --
// CLAUDE.md's threat model for this: a leaked DB dump/backup alone must not
// be enough to recover any user's stored source credential.

import "server-only";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "../crypto/secret-box";

export type EncryptedCredential = EncryptedSecret;

/** Encrypts `plaintext` (a Notion secret or a full Google service-account JSON string) for storage in source_credentials. Never logs the input. */
export const encryptCredential = encryptSecret;

/**
 * Decrypts a row read back from source_credentials. Throws (rather than
 * returning corrupted/garbage text) if the auth tag doesn't verify -- e.g.
 * the row was tampered with, or CREDENTIALS_ENCRYPTION_KEY doesn't match
 * the key it was encrypted under. Callers must never log the return value.
 */
export const decryptCredential = decryptSecret;
