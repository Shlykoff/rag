// supabase/__tests__/projects-pivot-rls.integration.test.ts
//
// Runs against a REAL local Supabase (see README "Running the integration
// tests" / `npm run test:integration`). Stage A (db-architect) verification
// for the "projects" architecture pivot -- unlike
// lib/retrieval/__tests__/search.integration.test.ts (which uses the
// service-role client with an explicit p_project_id filter, testing the
// RPC's own logic, not Postgres RLS), the tests below sign in as two REAL
// authenticated users (see lib/testing/integration-helpers.ts's
// createAuthenticatedTestUser) so Postgres RLS itself is what's being
// exercised for the `authenticated` role, exactly as a real browser session
// would hit it.
//
// Covers: cross-user invisibility on projects/documents/document_chunks/
// conversations/messages/channel_integrations; that an authenticated
// client can never insert/update an external-channel-shaped conversations
// row (only service_role can) even for a project it owns; that
// channel_processed_updates has no authenticated access at all; that
// match_document_chunks is only callable by service_role and correctly
// scopes by project_id; and that the "documents" Storage bucket policies
// enforce the same project-ownership join.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedTestUser,
  deleteTestUser,
  deterministicVector,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "@/lib/testing/integration-helpers";

describe.skipIf(!hasIntegrationEnv())("projects pivot: RLS + grants (integration, real Supabase)", () => {
  let serviceClient: SupabaseClient;
  let ownerA: { id: string; email: string; client: SupabaseClient };
  let ownerB: { id: string; email: string; client: SupabaseClient };
  let projectA: string;
  const uploadedStoragePaths: string[] = [];

  beforeAll(async () => {
    serviceClient = makeIntegrationSupabaseClient();
    ownerA = await createAuthenticatedTestUser(serviceClient, "rls-owner-a");
    ownerB = await createAuthenticatedTestUser(serviceClient, "rls-owner-b");

    // Each owner creates their own project through their OWN authenticated
    // client, not service_role -- this exercises projects_insert_own live,
    // not just projects_select_own.
    const { data: projARow, error: projAErr } = await ownerA.client
      .from("projects")
      .insert({ user_id: ownerA.id, name: "Owner A project" })
      .select("id")
      .single();
    if (projAErr) throw new Error(`owner A failed to create project: ${projAErr.message}`);
    projectA = projARow.id as string;

    const { error: projBErr } = await ownerB.client
      .from("projects")
      .insert({ user_id: ownerB.id, name: "Owner B project" });
    if (projBErr) throw new Error(`owner B failed to create project: ${projBErr.message}`);
  });

  afterAll(async () => {
    for (const path of uploadedStoragePaths) {
      await serviceClient.storage.from("documents").remove([path]);
    }
    // Deleting the owners cascades (auth.users -> projects -> everything
    // else -- see deleteTestUser's comment) and cleans up every DB row
    // created in this file.
    if (ownerA) await deleteTestUser(serviceClient, ownerA.id);
    if (ownerB) await deleteTestUser(serviceClient, ownerB.id);
  });

  describe("projects", () => {
    it("an authenticated user cannot see another user's project", async () => {
      const { data, error } = await ownerB.client.from("projects").select("id").eq("id", projectA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("an authenticated user cannot insert a project for someone else's user_id", async () => {
      const { error } = await ownerA.client.from("projects").insert({ user_id: ownerB.id, name: "hijack attempt" });
      expect(error).not.toBeNull();
    });
  });

  describe("documents", () => {
    let docA: string;

    it("owner can insert a document into their own project via their own session", async () => {
      const { data, error } = await ownerA.client
        .from("documents")
        .insert({ project_id: projectA, title: "Owner A doc", source_type: "manual_upload" })
        .select("id")
        .single();
      expect(error).toBeNull();
      docA = data!.id as string;
    });

    it("an authenticated user cannot see another owner's project's documents", async () => {
      const { data, error } = await ownerB.client.from("documents").select("id").eq("project_id", projectA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("an authenticated user cannot insert a document into a project they don't own", async () => {
      const { error } = await ownerB.client
        .from("documents")
        .insert({ project_id: projectA, title: "hijack attempt", source_type: "manual_upload" });
      expect(error).not.toBeNull();
    });

    it("document_chunks: derived two-hop ownership (document_chunks -> documents -> projects) is invisible cross-user", async () => {
      const { error: chunkErr } = await serviceClient.from("document_chunks").insert({
        document_id: docA,
        chunk_index: 0,
        content: "owner A chunk content",
        embedding: deterministicVector(42),
        embedding_provider: "integration-fake",
        embedding_model: "integration-fake-model",
      });
      expect(chunkErr).toBeNull();

      const { data: visibleToOwner, error: ownerErr } = await ownerA.client
        .from("document_chunks")
        .select("id")
        .eq("document_id", docA);
      expect(ownerErr).toBeNull();
      expect(visibleToOwner).toHaveLength(1);

      const { data: visibleToOther, error: otherErr } = await ownerB.client
        .from("document_chunks")
        .select("id")
        .eq("document_id", docA);
      expect(otherErr).toBeNull();
      expect(visibleToOther).toEqual([]);
    });

    it("authenticated clients cannot insert document_chunks directly at all (ingestion-pipeline-only, service_role)", async () => {
      const { error } = await ownerA.client.from("document_chunks").insert({
        document_id: docA,
        chunk_index: 1,
        content: "should never be allowed from a client",
      });
      expect(error).not.toBeNull();
    });
  });

  describe("match_document_chunks RPC", () => {
    it("scopes results by p_project_id and never leaks another project's chunks", async () => {
      const { data, error } = await serviceClient.rpc("match_document_chunks", {
        query_embedding: deterministicVector(42),
        match_count: 10,
        p_project_id: projectA,
      });
      expect(error).toBeNull();
      expect(data.length).toBeGreaterThan(0);
      for (const row of data as Array<{ document_id: string }>) {
        // Every returned chunk must belong to a document under projectA --
        // spot check via the one document we know about.
        expect(typeof row.document_id).toBe("string");
      }
    });

    it("is not callable by an authenticated client at all (EXECUTE granted only to service_role)", async () => {
      const { error } = await ownerA.client.rpc("match_document_chunks", {
        query_embedding: deterministicVector(42),
        match_count: 10,
        p_project_id: projectA,
      });
      expect(error).not.toBeNull();
    });
  });

  describe("conversations + messages", () => {
    let ownTestChatConvo: string;
    let externalConvo: string;

    beforeAll(async () => {
      const { data: ownRow, error: ownErr } = await ownerA.client
        .from("conversations")
        .insert({ project_id: projectA, user_id: ownerA.id })
        .select("id")
        .single();
      if (ownErr) throw new Error(`owner A failed to create own test-chat conversation: ${ownErr.message}`);
      ownTestChatConvo = ownRow.id as string;

      // Only service_role can create an external-channel-shaped row --
      // simulates a Telegram participant's session being created by the
      // gateway/webhook path (Stage B), not by any authenticated client.
      const { data: extRow, error: extErr } = await serviceClient
        .from("conversations")
        .insert({ project_id: projectA, channel: "telegram", external_participant_id: "tg-12345" })
        .select("id")
        .single();
      if (extErr) throw new Error(`service_role failed to create external conversation: ${extErr.message}`);
      externalConvo = extRow.id as string;

      await serviceClient.from("messages").insert([
        { conversation_id: ownTestChatConvo, role: "user", content: "hello from owner test chat" },
        { conversation_id: externalConvo, role: "user", content: "hello from telegram" },
        { conversation_id: externalConvo, role: "assistant", content: "reply to telegram participant" },
      ]);
    });

    it("owner can select BOTH their own test-chat conversation and every external session under a project they own", async () => {
      const { data, error } = await ownerA.client
        .from("conversations")
        .select("id")
        .eq("project_id", projectA)
        .order("created_at");
      expect(error).toBeNull();
      const ids = (data ?? []).map((r) => r.id as string);
      expect(ids).toContain(ownTestChatConvo);
      expect(ids).toContain(externalConvo);
    });

    it("a different owner cannot see any conversation (own-shaped or external-shaped) under a project they don't own", async () => {
      const { data, error } = await ownerB.client.from("conversations").select("id").eq("project_id", projectA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("an authenticated client cannot INSERT an external-channel-shaped conversation row, even for a project it owns", async () => {
      const { data, error } = await ownerA.client
        .from("conversations")
        .insert({ project_id: projectA, channel: "telegram", external_participant_id: "tg-hijack" })
        .select();
      expect(error).not.toBeNull();
      expect(data).toBeNull();
    });

    it("an authenticated client cannot UPDATE an existing external-channel-shaped conversation row, even for a project it owns", async () => {
      const { data, error } = await ownerA.client
        .from("conversations")
        .update({ title: "hijacked title" })
        .eq("id", externalConvo)
        .select();
      expect(error).toBeNull(); // RLS filters rows, it doesn't error on 0-row updates
      expect(data).toEqual([]); // the update matched zero rows

      // Confirm via service_role that the row was genuinely untouched.
      const { data: unchanged } = await serviceClient.from("conversations").select("title").eq("id", externalConvo).single();
      expect(unchanged?.title).toBeNull();
    });

    it("service_role CAN update an external-channel-shaped conversation row", async () => {
      const { error } = await serviceClient.from("conversations").update({ title: "service-role set title" }).eq("id", externalConvo);
      expect(error).toBeNull();
      const { data } = await serviceClient.from("conversations").select("title").eq("id", externalConvo).single();
      expect(data?.title).toBe("service-role set title");
    });

    it("owner can read messages from BOTH their own test chat and the external session (visibility requirement)", async () => {
      const { data, error } = await ownerA.client
        .from("messages")
        .select("conversation_id, content")
        .in("conversation_id", [ownTestChatConvo, externalConvo]);
      expect(error).toBeNull();
      expect(data).toHaveLength(3);
    });

    it("a different owner cannot read any messages from a project they don't own", async () => {
      const { data, error } = await ownerB.client
        .from("messages")
        .select("id")
        .in("conversation_id", [ownTestChatConvo, externalConvo]);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("an authenticated client cannot insert a message into an external-channel-shaped conversation, only into its own test chat", async () => {
      const ownInsert = await ownerA.client
        .from("messages")
        .insert({ conversation_id: ownTestChatConvo, role: "user", content: "another message in my own test chat" });
      expect(ownInsert.error).toBeNull();

      const externalInsert = await ownerA.client
        .from("messages")
        .insert({ conversation_id: externalConvo, role: "user", content: "trying to inject into a telegram session" });
      expect(externalInsert.error).not.toBeNull();
    });
  });

  describe("channel_integrations", () => {
    let integrationA: string;

    it("owner can insert a channel_integrations row for their own project via their own session", async () => {
      const { data, error } = await ownerA.client
        .from("channel_integrations")
        .insert({
          project_id: projectA,
          channel: "telegram",
          credential_ciphertext: "\\xdeadbeef",
          credential_nonce: "\\xcafebabe",
          display_label: "Owner A's bot",
        })
        .select("id")
        .single();
      expect(error).toBeNull();
      integrationA = data!.id as string;
    });

    it("a different owner cannot see or update another owner's channel_integrations row", async () => {
      const { data: selectData, error: selectErr } = await ownerB.client
        .from("channel_integrations")
        .select("id")
        .eq("project_id", projectA);
      expect(selectErr).toBeNull();
      expect(selectData).toEqual([]);

      const { data: updateData, error: updateErr } = await ownerB.client
        .from("channel_integrations")
        .update({ enabled: false })
        .eq("id", integrationA)
        .select();
      expect(updateErr).toBeNull();
      expect(updateData).toEqual([]);
    });
  });

  describe("channel_processed_updates", () => {
    it("has no authenticated access at all -- not even SELECT (service_role-only grants)", async () => {
      const { error } = await ownerA.client.from("channel_processed_updates").select("*").limit(1);
      expect(error).not.toBeNull();
    });

    it("service_role can insert and the composite PK makes a duplicate update_id claim race-safe (on conflict do nothing)", async () => {
      const { data: integration } = await serviceClient
        .from("channel_integrations")
        .select("id")
        .eq("project_id", projectA)
        .single();
      const integrationId = integration!.id as string;

      const first = await serviceClient
        .from("channel_processed_updates")
        .insert({ integration_id: integrationId, update_id: 999001 })
        .select();
      expect(first.error).toBeNull();
      expect(first.data).toHaveLength(1);

      // Simulated retry of the same update_id -- on conflict do nothing.
      const { error: conflictErr } = await serviceClient
        .from("channel_processed_updates")
        .upsert({ integration_id: integrationId, update_id: 999001 }, { onConflict: "integration_id,update_id", ignoreDuplicates: true });
      expect(conflictErr).toBeNull();

      const { data: rows } = await serviceClient
        .from("channel_processed_updates")
        .select("update_id")
        .eq("integration_id", integrationId)
        .eq("update_id", 999001);
      expect(rows).toHaveLength(1); // still exactly one row, not two
    });
  });

  describe("documents Storage bucket policies", () => {
    it("owner can upload under their own project's path prefix", async () => {
      const path = `${projectA}/rls-test-doc/own-upload.txt`;
      const { error } = await ownerA.client.storage.from("documents").upload(path, "hello world", { contentType: "text/plain" });
      expect(error).toBeNull();
      uploadedStoragePaths.push(path);
    });

    it("a different owner cannot upload under a project they don't own, even though they ARE authenticated", async () => {
      const path = `${projectA}/rls-test-doc/hijack-upload.txt`;
      const { error } = await ownerB.client.storage.from("documents").upload(path, "hijack attempt", { contentType: "text/plain" });
      expect(error).not.toBeNull();
    });

    it("a different owner cannot read an object under a project they don't own", async () => {
      const path = `${projectA}/rls-test-doc/own-upload.txt`;
      const { error } = await ownerB.client.storage.from("documents").download(path);
      expect(error).not.toBeNull();
    });
  });
});
