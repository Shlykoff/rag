// lib/ai/__tests__/credentials.integration.test.ts
//
// Round-trips lib/ai/credentials.ts against a REAL local Supabase Postgres
// -- mirrors lib/sources/__tests__/credentials.integration.test.ts's shape
// (same reasoning: verify the `bytea` wire-format assumption against a real
// column, not just a fake client that could agree with a wrong assumption
// on both the write and read side).
//
// PROJECTS PIVOT: getActiveProvider()/setActiveProvider() are project-scoped
// now (`projects.active_ai_provider`, see credentials.ts's header) --
// every test below creates a real `projects` row via
// lib/testing/integration-helpers.ts's createTestProject() and exercises
// the pair through that, including the new ownerUserId ownership check on
// setActiveProvider().

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  saveAIProviderCredential,
  getAIProviderCredential,
  hasAIProviderCredential,
  deleteAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  MissingProviderCredentialsError,
} from "../credentials";
import {
  createTestProject,
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

      // Deleting again (nothing left to delete) must not throw.
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

    describe("getActiveProvider / setActiveProvider (project-scoped)", () => {
      it("getActiveProvider is null for a freshly-created project (active_ai_provider starts null, not a default 'openai' or similar)", async () => {
        const freshUser = await createTestUser(supabase, "ai-credentials-active-fresh");
        try {
          const project = await createTestProject(supabase, freshUser.id);
          expect(await getActiveProvider(supabase, project.id)).toBeNull();
        } finally {
          await deleteTestUser(supabase, freshUser.id);
        }
      });

      it("getActiveProvider throws for a project id that doesn't exist (distinct from 'not configured yet')", async () => {
        await expect(getActiveProvider(supabase, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(
          /does not exist/
        );
      });

      it("setActiveProvider succeeds for openai/gemini once their owner's own credential exists, and getActiveProvider reflects it", async () => {
        const u = await createTestUser(supabase, "ai-credentials-active-openai");
        try {
          const project = await createTestProject(supabase, u.id);
          await saveAIProviderCredential(supabase, u.id, "openai", "some-openai-key");
          await setActiveProvider(supabase, project.id, u.id, "openai");
          expect(await getActiveProvider(supabase, project.id)).toBe("openai");
        } finally {
          await deleteTestUser(supabase, u.id);
        }
      });

      it("setActiveProvider rejects 'openai' with MissingProviderCredentialsError when the owner has no openai credential stored, and does not write projects.active_ai_provider", async () => {
        const u = await createTestUser(supabase, "ai-credentials-active-missing");
        try {
          const project = await createTestProject(supabase, u.id);
          await expect(setActiveProvider(supabase, project.id, u.id, "openai")).rejects.toBeInstanceOf(
            MissingProviderCredentialsError
          );
          expect(await getActiveProvider(supabase, project.id)).toBeNull();
        } finally {
          await deleteTestUser(supabase, u.id);
        }
      });

      it("setActiveProvider('anthropic') requires BOTH an anthropic AND a voyage credential -- rejects with only one saved", async () => {
        const u = await createTestUser(supabase, "ai-credentials-active-anthropic-partial");
        try {
          const project = await createTestProject(supabase, u.id);
          await saveAIProviderCredential(supabase, u.id, "anthropic", "claude-key-only");
          const err = await setActiveProvider(supabase, project.id, u.id, "anthropic").catch((e: unknown) => e);
          expect(err).toBeInstanceOf(MissingProviderCredentialsError);
          expect((err as InstanceType<typeof MissingProviderCredentialsError>).missing).toEqual(["voyage"]);
          expect(await getActiveProvider(supabase, project.id)).toBeNull();
        } finally {
          await deleteTestUser(supabase, u.id);
        }
      });

      it("setActiveProvider('anthropic') succeeds once BOTH anthropic and voyage credentials exist", async () => {
        const u = await createTestUser(supabase, "ai-credentials-active-anthropic-full");
        try {
          const project = await createTestProject(supabase, u.id);
          await saveAIProviderCredential(supabase, u.id, "anthropic", "claude-key");
          await saveAIProviderCredential(supabase, u.id, "voyage", "voyage-key");
          await setActiveProvider(supabase, project.id, u.id, "anthropic");
          expect(await getActiveProvider(supabase, project.id)).toBe("anthropic");
        } finally {
          await deleteTestUser(supabase, u.id);
        }
      });

      it("setActiveProvider upserts (switching from one active provider to another works, not just the first-ever set)", async () => {
        const u = await createTestUser(supabase, "ai-credentials-active-switch");
        try {
          const project = await createTestProject(supabase, u.id);
          await saveAIProviderCredential(supabase, u.id, "openai", "key-1");
          await saveAIProviderCredential(supabase, u.id, "gemini", "key-2");
          await setActiveProvider(supabase, project.id, u.id, "openai");
          expect(await getActiveProvider(supabase, project.id)).toBe("openai");
          await setActiveProvider(supabase, project.id, u.id, "gemini");
          expect(await getActiveProvider(supabase, project.id)).toBe("gemini");
        } finally {
          await deleteTestUser(supabase, u.id);
        }
      });

      it("setActiveProvider rejects when the project belongs to a DIFFERENT user than ownerUserId, even if ownerUserId itself has the credential", async () => {
        const owner = await createTestUser(supabase, "ai-credentials-owner");
        const impostor = await createTestUser(supabase, "ai-credentials-impostor");
        try {
          const project = await createTestProject(supabase, owner.id);
          await saveAIProviderCredential(supabase, impostor.id, "openai", "impostor-key");
          await expect(setActiveProvider(supabase, project.id, impostor.id, "openai")).rejects.toThrow(
            /belongs to user/
          );
          expect(await getActiveProvider(supabase, project.id)).toBeNull();
        } finally {
          await deleteTestUser(supabase, owner.id);
          await deleteTestUser(supabase, impostor.id);
        }
      });
    });
  }
);
