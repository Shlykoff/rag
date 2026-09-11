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

    it("saving a key auto-fills empty model slots of all the user's projects, never a chosen one", async () => {
      const user = await freshUser("profile-credentials-autofill");
      try {
        const { data: models, error: modelsError } = await supabase.from("ai_models").select("id, model_id");
        if (modelsError) throw new Error(modelsError.message);
        const idOf = (modelId: string) => (models as { id: string; model_id: string }[]).find((m) => m.model_id === modelId)!.id;

        const { data: projects, error: projectsError } = await supabase
          .from("projects")
          .insert([
            { user_id: user.id, name: "empty" },
            { user_id: user.id, name: "chosen", chat_model_id: idOf("gpt-4.1-mini"), active_ai_provider: "openai" },
          ])
          .select("id, name");
        if (projectsError) throw new Error(projectsError.message);
        const idByName = Object.fromEntries((projects as { id: string; name: string }[]).map((p) => [p.name, p.id]));

        const readModels = async (projectId: string) => {
          const { data, error } = await supabase
            .from("projects")
            .select("chat_model_id, embedding_model_id")
            .eq("id", projectId)
            .single();
          if (error) throw new Error(error.message);
          return data;
        };

        expect((await POST(makePostRequest("openai", `sk-integration-${user.id}`))).status).toBe(200);

        expect(await readModels(idByName.empty)).toEqual({
          chat_model_id: idOf("gpt-5.6-luna"),
          embedding_model_id: idOf("text-embedding-3-small"),
        });
        expect(await readModels(idByName.chosen)).toEqual({
          chat_model_id: idOf("gpt-4.1-mini"),
          embedding_model_id: idOf("text-embedding-3-small"),
        });

        // A second chat-capable key makes chat ambiguous: nothing new is filled, nothing is cleared.
        const { error: resetError } = await supabase
          .from("projects")
          .update({ chat_model_id: null, active_ai_provider: null })
          .eq("id", idByName.empty);
        if (resetError) throw new Error(resetError.message);
        expect((await POST(makePostRequest("anthropic", `sk-ant-integration-${user.id}`))).status).toBe(200);
        expect((await readModels(idByName.empty)).chat_model_id).toBeNull();
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
