// lib/sources/__tests__/credentials.integration.test.ts
//
// Round-trips lib/sources/credentials.ts against a REAL local Supabase
// Postgres -- specifically to verify the `bytea` wire-format assumption
// (PostgREST hex-encodes bytea as "\x..." by default) actually holds
// against a real `source_credentials` row, not just against a fake
// Supabase client that could accidentally agree with a wrong assumption on
// both the write and read side. Also confirms RLS/service-role plumbing:
// this uses the service-role client the way app/api/sources/credentials
// does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { saveSourceCredential, getSourceCredential, hasSourceCredential } from "../credentials";
import { createTestUser, deleteTestUser, hasIntegrationEnv, makeIntegrationSupabaseClient } from "../../testing/integration-helpers";

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "source credentials (integration, real Supabase)",
  () => {
    let supabase: SupabaseClient;
    let userId: string;

    beforeAll(async () => {
      supabase = makeIntegrationSupabaseClient();
      const user = await createTestUser(supabase, "credentials");
      userId = user.id;
    });

    afterAll(async () => {
      if (userId) await deleteTestUser(supabase, userId);
    });

    it("hasSourceCredential is false before anything is saved", async () => {
      expect(await hasSourceCredential(supabase, userId, "notion")).toBe(false);
    });

    it("round-trips a plain secret string through real Postgres bytea encoding", async () => {
      const secret = `secret_${randomBytes(16).toString("hex")}`;
      await saveSourceCredential(supabase, userId, "notion", secret);

      expect(await hasSourceCredential(supabase, userId, "notion")).toBe(true);
      expect(await getSourceCredential(supabase, userId, "notion")).toBe(secret);
    });

    it("round-trips a large JSON payload with special characters (Google service-account-key-shaped)", async () => {
      const payload = JSON.stringify({
        type: "service_account",
        private_key: "-----BEGIN PRIVATE KEY-----\nMIIfake/+==\n-----END PRIVATE KEY-----\n",
        client_email: "svc@example-project.iam.gserviceaccount.com",
        extra: "unicode-check: тест 测试 🔑",
      });
      await saveSourceCredential(supabase, userId, "google_drive", payload);
      expect(await getSourceCredential(supabase, userId, "google_drive")).toBe(payload);
    });

    it("upsert replaces the previous value for the same (user, source_type) rather than erroring", async () => {
      await saveSourceCredential(supabase, userId, "notion", "first-token");
      await saveSourceCredential(supabase, userId, "notion", "second-token");
      expect(await getSourceCredential(supabase, userId, "notion")).toBe("second-token");
    });

    it("getSourceCredential returns null (not an error) for a source with nothing saved", async () => {
      const other = await createTestUser(supabase, "credentials-other");
      try {
        expect(await getSourceCredential(supabase, other.id, "google_drive")).toBeNull();
      } finally {
        await deleteTestUser(supabase, other.id);
      }
    });
  }
);
