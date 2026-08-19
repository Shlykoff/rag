// lib/sources/__tests__/crypto.test.ts
//
// Pure unit tests for lib/sources/crypto.ts's AES-256-GCM encrypt/decrypt
// round trip -- no I/O, no Supabase needed. Sets CREDENTIALS_ENCRYPTION_KEY
// itself (via vi.stubEnv) rather than relying on .env.local, so this test
// is self-contained and doesn't silently pass/fail based on local dev env
// setup. No module-reset gymnastics needed: crypto.ts's loadKey() reads
// process.env fresh on every encrypt/decrypt call rather than caching it at
// import time, so vi.stubEnv alone is enough between test cases.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { encryptCredential, decryptCredential } from "../crypto";

// A fixed, obviously-fake 32-byte key (64 hex chars) -- distinct from
// whatever's in .env.local, so this test exercises its own key material.
const TEST_KEY_HEX = crypto.randomBytes(32).toString("hex"); // 64 hex chars = 32 bytes, freshly generated per test run

describe("lib/sources/crypto: encrypt/decrypt round trip", () => {
  beforeEach(() => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", TEST_KEY_HEX);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("decrypts back to the original plaintext (a Notion-secret-shaped string)", () => {
    const plaintext = "secret_abcdEFGH12345";
    const encrypted = encryptCredential(plaintext);
    expect(decryptCredential(encrypted)).toBe(plaintext);
  });

  it("decrypts back a large JSON payload (a Google service-account-key-shaped string)", () => {
    const plaintext = JSON.stringify({
      type: "service_account",
      project_id: "example-project",
      private_key: "-----BEGIN PRIVATE KEY-----\nMIIfake...\n-----END PRIVATE KEY-----\n",
      client_email: "svc@example-project.iam.gserviceaccount.com",
    });
    const encrypted = encryptCredential(plaintext);
    expect(decryptCredential(encrypted)).toBe(plaintext);
  });

  it("produces a different nonce (and ciphertext) on every call, even for identical plaintext", () => {
    const a = encryptCredential("same-secret");
    const b = encryptCredential("same-secret");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("fails to decrypt (does not silently return garbage) if the ciphertext is tampered with", () => {
    const encrypted = encryptCredential("do-not-leak-me");
    const tampered = Buffer.from(encrypted.ciphertext);
    tampered[0] ^= 0xff; // flip a bit
    expect(() => decryptCredential({ ...encrypted, ciphertext: tampered })).toThrow();
  });

  it("fails to decrypt under the wrong key", () => {
    const encrypted = encryptCredential("do-not-leak-me-either");
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", crypto.randomBytes(32).toString("hex"));
    expect(() => decryptCredential(encrypted)).toThrow();
  });

  it("throws a clear error if CREDENTIALS_ENCRYPTION_KEY is missing", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "");
    expect(() => encryptCredential("x")).toThrow(/CREDENTIALS_ENCRYPTION_KEY/);
  });

  it("throws a clear error if CREDENTIALS_ENCRYPTION_KEY is not 32 bytes", () => {
    vi.stubEnv("CREDENTIALS_ENCRYPTION_KEY", "abcd"); // 2 bytes
    expect(() => encryptCredential("x")).toThrow(/32 bytes/);
  });

  it("rejects an unsupported encryption_key_version rather than silently misreading a future-format row", () => {
    const encrypted = encryptCredential("x");
    expect(() => decryptCredential({ ...encrypted, keyVersion: 2 })).toThrow(/encryption_key_version/);
  });
});
