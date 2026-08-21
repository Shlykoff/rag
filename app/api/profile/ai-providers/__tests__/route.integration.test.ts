// app/api/profile/ai-providers/__tests__/route.integration.test.ts
//
// Regression test for the "no active_ai_provider set despite a key being
// configured" UX bug: a user saved a provider's key via POST but had to
// separately click a radio button in "Активный провайдер" (PUT) before
// chat/ingestion worked at all -- confusing enough that it was reproduced
// live against a real Google OAuth account. Exercises the REAL POST/GET
// route handlers (not the DB-agnostic auto-activation logic in isolation --
// route.test.ts's mocked unit tests already cover that) against a REAL
// local Supabase, the same "auth layer mocked, service-role DB client real"
// pattern as app/api/sources/[documentId]/__tests__/route.integration.test.ts's
// header comment explains (no HTTP/cookie session harness in this project's
// test setup; the auth layer itself is covered elsewhere).
//
// Covers exactly the three scenarios from this task's live-verification
// checklist:
//   1. A single-key provider (openai) becomes active the instant its only
//      key is saved, with no separate PUT.
//   2. Once a provider is active, saving a second, different provider's key
//      does NOT silently switch the active provider.
//   3. anthropic (two required keys: anthropic + voyage) only auto-activates
//      once BOTH are present -- not after the first one alone.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../../../../lib/testing/integration-helpers";

let currentUser: { id: string; email: string } | null = null;

vi.mock("@/lib/supabase/server-client", () => ({
  getRouteHandlerSupabaseClient: async () => ({}),
  getAuthenticatedUser: async () => currentUser,
}));

// NOT mocked: lib/supabase/service-client.ts's getServiceRoleClient() (and
// therefore lib/ai/credentials.ts's real encrypt/DB calls) talks to the real
// local Supabase started by `supabase start`, via NEXT_PUBLIC_SUPABASE_URL/
// SUPABASE_SERVICE_ROLE_KEY loaded from .env.local by `npm run
// test:integration`'s --env-file flag. Static import after vi.mock is safe
// -- Vitest hoists vi.mock calls above imports, same as that sibling
// integration test.
import { GET, POST } from "../route";

function makePostRequest(provider: string, apiKey: string): Request {
  return new Request("http://localhost/api/profile/ai-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
}

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "POST /api/profile/ai-providers auto-activation (integration, real Supabase)",
  () => {
    let supabase: SupabaseClient;

    beforeAll(() => {
      supabase = makeIntegrationSupabaseClient();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      currentUser = null;
    });

    async function freshUser(label: string): Promise<{ id: string; email: string }> {
      const user = await createTestUser(supabase, label);
      currentUser = user;
      return user;
    }

    it("scenario 1: a brand-new user saving their only key (openai) becomes active with no separate PUT", async () => {
      const user = await freshUser("auto-activate-openai");
      try {
        const before = await GET();
        expect((await before.json()).activeProvider).toBeNull();

        const postResponse = await POST(makePostRequest("openai", `sk-integration-${user.id}`));
        expect(postResponse.status).toBe(200);
        expect(await postResponse.json()).toEqual({ status: "saved", activeProvider: "openai" });

        const after = await GET();
        expect(await after.json()).toMatchObject({ activeProvider: "openai" });
      } finally {
        await deleteTestUser(supabase, user.id);
      }
    });

    it("scenario 2: once openai is active, saving a second provider's key (gemini) does not switch the active provider", async () => {
      const user = await freshUser("auto-activate-no-override");
      try {
        const first = await POST(makePostRequest("openai", `sk-integration-${user.id}`));
        expect((await first.json()).activeProvider).toBe("openai");

        const second = await POST(makePostRequest("gemini", `AIza-integration-${user.id}`));
        expect(second.status).toBe(200);
        // Still openai -- gemini being fully configured now must NOT steal
        // the active slot from an already-active provider.
        expect(await second.json()).toEqual({ status: "saved", activeProvider: "openai" });

        const after = await GET();
        const body = await after.json();
        expect(body.activeProvider).toBe("openai");
        expect(body.configured.gemini).toBe(true);
      } finally {
        await deleteTestUser(supabase, user.id);
      }
    });

    it("scenario 3: anthropic activates only once BOTH anthropic and voyage keys are present, not after the first alone", async () => {
      const user = await freshUser("auto-activate-anthropic-pair");
      try {
        const anthropicOnly = await POST(makePostRequest("anthropic", `sk-ant-integration-${user.id}`));
        expect(anthropicOnly.status).toBe(200);
        expect(await anthropicOnly.json()).toEqual({ status: "saved", activeProvider: null });

        const stillNull = await GET();
        expect((await stillNull.json()).activeProvider).toBeNull();

        const voyageCompletesPair = await POST(makePostRequest("voyage", `pa-integration-${user.id}`));
        expect(voyageCompletesPair.status).toBe(200);
        expect(await voyageCompletesPair.json()).toEqual({ status: "saved", activeProvider: "anthropic" });

        const after = await GET();
        expect((await after.json()).activeProvider).toBe("anthropic");
      } finally {
        await deleteTestUser(supabase, user.id);
      }
    });

    afterAll(async () => {
      currentUser = null;
    });
  }
);
