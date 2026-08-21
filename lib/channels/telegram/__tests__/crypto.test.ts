// lib/channels/telegram/__tests__/crypto.test.ts
//
// Pure unit tests for lib/channels/telegram/crypto.ts's AES-256-GCM
// encrypt/decrypt round trip -- no I/O, no Supabase needed. Mirrors
// lib/ai/__tests__/crypto.test.ts exactly (same scheme, same env var, same
// failure modes) since lib/channels/telegram/crypto.ts is a deliberate
// near-duplicate of that module -- see its own header for why it isn't
// just imported instead (lib/channels/** is import-boundary-isolated from
// lib/ai/, CLAUDE.md rule 8). Sets CREDENTIALS_ENCRYPTION_KEY itself (via
// vi.stubEnv) rather than relying on .env.local, so this test is
// self-contained.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { encryptChannelCredential, decryptChannelCredential } from "../crypto";

const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex");

describe("lib/channels/telegram/crypto: encrypt/decrypt round trip", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", TEST_KEY_HEX);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decrypts back to the original plaintext (a JSON-packed { botToken, webhookSecret } blob)", () => {
    const plaintext = JSON.stringify({ botToken: "123456:AAFakeTelegramBotToken", webhookSecret: "shh-secret-value" });
    const encrypted = encryptChannelCredential(plaintext);
    expect(decryptChannelCredential(encrypted)).toBe(plaintext);
    expect(JSON.parse(decryptChannelCredential(encrypted))).toEqual({
      botToken: "123456:AAFakeTelegramBotToken",
      webhookSecret: "shh-secret-value",
    });
  });

  it("produces a different nonce (and ciphertext) on every call, even for identical plaintext", () => {
    const a = encryptChannelCredential("same-secret");
    const b = encryptChannelCredential("same-secret");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails to decrypt (does not silently return garbage) if the ciphertext is tampered with", () => {
    const encrypted = encryptChannelCredential("do-not-leak-me");
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] ^= 0xff; // flip a bit
    expect(() => decryptChannelCredential({ ...encrypted, ciphertext: tampered })).toThrow();
  });

  it("fails to decrypt under the wrong key", () => {
    const encrypted = encryptChannelCredential("do-not-leak-me-either");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", crypto.randomBytes(32).toString("hex"));
    expect(() => decryptChannelCredential(encrypted)).toThrow();
  });

  it("throws a clear error if CREDENTIALS_ENCRYPTION_KEY is missing", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(() => encryptChannelCredential("x")).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("throws a clear error if CREDENTIALS_ENCRYPTION_KEY is not 32 bytes", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "abcd"); // 2 bytes
    expect(() => encryptChannelCredential("x")).toThrow(/32 bytes/);
  });

  it("rejects an unsupported encryption_key_version rather than silently misreading a future-format row", () => {
    const encrypted = encryptChannelCredential("x");
    expect(() => decryptChannelCredential({ ...encrypted, keyVersion: 2 })).toThrow(/encryption_key_version/);
  });
});
