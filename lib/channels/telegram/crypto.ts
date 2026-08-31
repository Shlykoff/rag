// lib/channels/telegram/crypto.ts
//
// Application-level encryption for `channel_integrations.credential_ciphertext`
// (a project's Telegram Bot API token + webhook secret, packed together --
// see integration-store.ts).
//
// Thin re-export of lib/crypto/secret-box.ts's domain-neutral AES-256-GCM
// implementation -- this file, lib/ai/crypto.ts, and lib/sources/crypto.ts
// used to be three byte-for-byte identical copies of this same scheme; see
// that module's own header for why the shared implementation lives in a
// neutral `lib/crypto/` location instead of any one domain importing
// another. This is doubly deliberate here specifically because
// lib/channels/** has an ENFORCED import boundary (CLAUDE.md rule 8): it
// may not import lib/ai/ (or lib/chat/, lib/retrieval/, lib/rate-limit/) at
// all -- `lib/crypto/` is none of those, so re-exporting from it here does
// not violate that boundary. Kept as its own file (rather than having
// integration-store.ts import lib/crypto/secret-box.ts directly) so this
// domain's own naming
// (`encryptChannelCredential`/`decryptChannelCredential`,
// `EncryptedChannelCredential`) and doc comments stay put for every
// existing caller/test.
//
// Reusing the SAME env var as lib/ai/crypto.ts / lib/sources/crypto.ts
// (not a third one) is intentional -- all three tables store the same
// *kind* of secret (a bearer credential handed to an external API) under
// the same threat model, so provisioning a third encryption key for no
// functional difference would only be an extra thing to lose/rotate/
// document.
//
// The key itself lives ONLY in the `CREDENTIALS_ENCRYPTION_KEY` env var,
// never in the database (see .env.example for how to generate one).

import "server-only";
import { encryptSecret, decryptSecret, type EncryptedSecret } from "../../crypto/secret-box";

export type EncryptedChannelCredential = EncryptedSecret;

/** Encrypts `plaintext` (a JSON-packed { botToken, webhookSecret } string -- see integration-store.ts) for storage in channel_integrations. Never logs the input. */
export const encryptChannelCredential = encryptSecret;

/**
 * Decrypts a row read back from channel_integrations. Throws (rather than
 * returning corrupted/garbage text) if the auth tag doesn't verify -- e.g.
 * the row was tampered with, or CREDENTIALS_ENCRYPTION_KEY doesn't match the
 * key it was encrypted under. Callers must never log the return value.
 */
export const decryptChannelCredential = decryptSecret;
