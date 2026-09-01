// app/api/profile/ai-providers/__tests__/route.integration.test.ts
//
// This route has no PUT method or `activeProvider` field (see route.ts's
// own header comment) -- `active_ai_provider` is a per-project setting.
// This file round-trips GET/POST/DELETE against a real local Supabase (real
// encryption, real `ai_provider_credentials` rows) -- the auth layer is
// mocked, the same "auth mocked, service-role DB client real" pattern as
// app/api/sources/[documentId]/__tests__/route.integration.test.ts's header
// explains.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
// test:integration`'s --env-file flag.
import { GET, POST, DELETE } from "../route";

function makePostRequest(provider: string, apiKey: string): Request {
  return new Request("http://localhost/api/profile/ai-providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, apiKey }),
  });
}

function makeDeleteRequest(provider: string): Request {
  return new Request("http://localhost/api/profile/ai-providers", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider }),
  });
}

describe.skipIf(!hasIntegrationEnv() || !process.env.CREDENTIALS_ENCRYPTION_KEY)(
  "GET/POST/DELETE /api/profile/ai-providers (integration, real Supabase)",
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

    it("a brand-new user has nothing configured, saves a real key, sees it reflected, then deletes it", async () => {
      const user = await freshUser("profile-credentials-roundtrip");
      try {
        const before = await GET();
        expect(await before.json()).toEqual({
          configured: { openai: false, anthropic: false, gemini: false, voyage: false },
        });

        const postResponse = await POST(makePostRequest("openai", `sk-integration-${user.id}`));
        expect(postResponse.status).toBe(200);
        expect(await postResponse.json()).toEqual({ status: "saved" });

        const after = await GET();
        const afterBody = await after.json();
        expect(afterBody.configured.openai).toBe(true);
        // No activeProvider field at all -- account-level route, not
        // project-scoped (see route.ts's header comment).
        expect(afterBody.activeProvider).toBeUndefined();

        const deleteResponse = await DELETE(makeDeleteRequest("openai"));
        expect(deleteResponse.status).toBe(200);
        expect(await deleteResponse.json()).toEqual({ status: "deleted" });

        const afterDelete = await GET();
        expect((await afterDelete.json()).configured.openai).toBe(false);
      } finally {
        await deleteTestUser(supabase, user.id);
      }
    });

    it("saving independent providers' keys never clobbers each other", async () => {
      const user = await freshUser("profile-credentials-independent");
      try {
        await POST(makePostRequest("gemini", `AIza-integration-${user.id}`));
        await POST(makePostRequest("anthropic", `sk-ant-integration-${user.id}`));

        const body = await (await GET()).json();
        expect(body.configured).toMatchObject({ gemini: true, anthropic: true, openai: false, voyage: false });
      } finally {
        await deleteTestUser(supabase, user.id);
      }
    });
  }
);
