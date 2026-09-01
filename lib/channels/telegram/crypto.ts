// lib/channels/telegram/crypto.ts
//
// Application-level encryption for `channel_integrations.credential_ciphertext`
// (a project's Telegram Bot API token + webhook secret, packed together --
// see integration-store.ts).
//
// Thin re-export of lib/crypto/secret-box.ts's domain-neutral AES-256-GCM
// implementation -- see that module's header for why it's shared rather
// than domains importing each other, and why this file re-exports under
// its own naming instead of integration-store.ts importing
// lib/crypto/secret-box.ts directly. Importing lib/crypto/ here specifically
// does not violate lib/channels/**'s enforced import boundary (CLAUDE.md
// rule 8, which forbids lib/ai/, lib/chat/, lib/retrieval/, lib/rate-limit/)
// since lib/crypto/ is none of those.

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
