// lib/ai/__tests__/credentials.integration.test.ts
//
// Round-trips lib/ai/credentials.ts against a REAL local Supabase Postgres
// -- mirrors lib/sources/__tests__/credentials.integration.test.ts: the
// `bytea` wire-format assumption is verified against a real column, not a
// fake client that could agree with a wrong assumption on both sides.
// Project model selection is covered by model-selection.integration.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  saveAIProviderCredential,
  getAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
} from "../credentials";
import {
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "AI provider credentials (integration, real Supabase)",
  () => {
    let supabase: SupabaseClient;
    let userId: string;

    beforeAll(async () => {
      supabase = makeIntegrationSupabaseClient();
      const user = await createTestUser(supabase, "ai-credentials");
      userId = user.id;
    });

    afterAll(async () => {
      if (userId) await deleteTestUser(supabase, userId);
    });

    it("hasAIProviderCredential is false before anything is saved", async () => {
      expect(await hasAIProviderCredential(supabase, userId, "openai")).toBe(false);
    });

    it("getAIProviderCredential returns null (not an error) for a provider with nothing saved", async () => {
      expect(await getAIProviderCredential(supabase, userId, "gemini")).toBeNull();
    });

    it("round-trips a plain API key string through real Postgres bytea encoding", async () => {
      const key = `sk-${randomBytes(16).toString("hex")}`;
      await saveAIProviderCredential(supabase, userId, "openai", key);

      expect(await hasAIProviderCredential(supabase, userId, "openai")).toBe(true);
      expect(await getAIProviderCredential(supabase, userId, "openai")).toBe(key);
    });

    it("round-trips a key with unicode/special characters", async () => {
      const key = `pa-${randomBytes(8).toString("hex")}-unicode-check-тест-测试-🔑`;
      await saveAIProviderCredential(supabase, userId, "voyage", key);
      expect(await getAIProviderCredential(supabase, userId, "voyage")).toBe(key);
    });

    it("upsert replaces the previous value for the same (user, provider) rather than erroring or duplicating", async () => {
      await saveAIProviderCredential(supabase, userId, "gemini", "first-key");
      await saveAIProviderCredential(supabase, userId, "gemini", "second-key");
      expect(await getAIProviderCredential(supabase, userId, "gemini")).toBe("second-key");
    });

    it("stores independent rows per provider for the same user (openai and gemini don't clobber each other)", async () => {
      await saveAIProviderCredential(supabase, userId, "openai", "openai-key-independent");
      await saveAIProviderCredential(supabase, userId, "gemini", "gemini-key-independent");
      expect(await getAIProviderCredential(supabase, userId, "openai")).toBe("openai-key-independent");
      expect(await getAIProviderCredential(supabase, userId, "gemini")).toBe("gemini-key-independent");
    });

    it("deleteAIProviderCredential removes the row (has/get reflect the deletion), and is a no-op (not an error) if nothing was stored", async () => {
      await saveAIProviderCredential(supabase, userId, "anthropic", "temp-anthropic-key");
      expect(await hasAIProviderCredential(supabase, userId, "anthropic")).toBe(true);

      await deleteAIProviderCredential(supabase, userId, "anthropic");
      expect(await hasAIProviderCredential(supabase, userId, "anthropic")).toBe(false);
      expect(await getAIProviderCredential(supabase, userId, "anthropic")).toBeNull();

      await expect(deleteAIProviderCredential(supabase, userId, "anthropic")).resolves.toBeUndefined();
    });

    it("credentials for one user are never visible under another user's id", async () => {
      const other = await createTestUser(supabase, "ai-credentials-other");
      try {
        await saveAIProviderCredential(supabase, userId, "openai", "user-a-openai-key");
        expect(await getAIProviderCredential(supabase, other.id, "openai")).toBeNull();
        expect(await hasAIProviderCredential(supabase, other.id, "openai")).toBe(false);
      } finally {
        await deleteTestUser(supabase, other.id);
      }
    });
  }
);
