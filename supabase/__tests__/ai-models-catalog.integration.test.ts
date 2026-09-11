// supabase/__tests__/ai-models-catalog.integration.test.ts
//
// Runs against a real local Supabase (`npm run test:integration`). Covers
// the ai_models catalog (grants, RLS, constraints, seeded contents), the
// kind-pinned model references on projects, and match_document_chunks over
// embeddings of different dimensions.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  createAuthenticatedTestUser,
  createTestProject,
  deleteTestUser,
  deterministicVector,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
  requireIntegrationAnonEnv,
  runPrivilegedSql,
} from "@/lib/testing/integration-helpers";

interface CatalogRow {
  id: string;
  provider: string;
  model_id: string;
  kind: "chat" | "embedding";
  dimensions: number | null;
  is_recommended: boolean;
  is_active: boolean;
}

interface MatchRow {
  chunk_id: string;
  document_id: string;
  content: string;
  similarity: number;
}

const CATALOG_COLUMNS = "id, provider, model_id, kind, dimensions, is_recommended, is_active";

const MODEL_1024 = "integration-emb-1024";
const MODEL_1536 = "integration-emb-1536";
const MODEL_3072 = "integration-emb-3072";

/**
 * Tries to insert one ai_models row as `postgres`. The DO block always
 * raises afterwards, so nothing is ever committed: P0001 "inserted" means
 * every constraint passed.
 */
function tryInsertCatalogRow(values: string) {
  return runPrivilegedSql(`
    do $$
    begin
      insert into public.ai_models (
        provider, model_id, kind, display_name, dimensions, context_window, max_output_tokens,
        input_price_usd_per_mtok, output_price_usd_per_mtok, pricing_as_of, is_recommended
      )
      values (${values});
      raise exception 'inserted' using errcode = 'P0001';
    end $$;
  `);
}

function blend(dimensions: number, otherWeight: number): number[] {
  const vector = deterministicVector(0, dimensions);
  vector[1] = otherWeight;
  return vector;
}

describe.skipIf(!hasIntegrationEnv())("ai_models catalog + project models + variable-dimension search (integration)", () => {
  let service: SupabaseClient;
  let anon: SupabaseClient;
  let owner: { id: string; email: string; client: SupabaseClient };
  let catalog: CatalogRow[];

  beforeAll(async () => {
    service = makeIntegrationSupabaseClient();
    const { url, anonKey } = requireIntegrationAnonEnv();
    anon = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    owner = await createAuthenticatedTestUser(service, "catalog-owner");

    const { data, error } = await service.from("ai_models").select(CATALOG_COLUMNS).order("sort_order");
    if (error) throw new Error(`failed to load ai_models: ${error.message}`);
    catalog = data as CatalogRow[];
  });

  afterAll(async () => {
    if (owner) await deleteTestUser(service, owner.id);
  });

  function catalogModel(provider: string, modelId: string): CatalogRow {
    const row = catalog.find((m) => m.provider === provider && m.model_id === modelId);
    if (!row) throw new Error(`catalog is missing ${provider}/${modelId}`);
    return row;
  }

  describe("ai_models access", () => {
    it("authenticated can read the whole catalog", async () => {
      const { data, error } = await owner.client.from("ai_models").select("id");
      expect(error).toBeNull();
      expect(data).toHaveLength(catalog.length);
    });

    it("authenticated cannot insert, update or delete", async () => {
      const target = catalogModel("openai", "gpt-5.6-luna");

      const insert = await owner.client.from("ai_models").insert({
        provider: "openai",
        model_id: "client-insert-attempt",
        kind: "chat",
        display_name: "x",
        context_window: 1,
        max_output_tokens: 1,
        input_price_usd_per_mtok: 0,
        output_price_usd_per_mtok: 0,
        pricing_as_of: "2026-09-11",
      });
      expect(insert.error).not.toBeNull();

      const update = await owner.client.from("ai_models").update({ display_name: "hijacked" }).eq("id", target.id).select();
      expect(update.error).not.toBeNull();

      const del = await owner.client.from("ai_models").delete().eq("id", target.id).select();
      expect(del.error).not.toBeNull();

      const { data: unchanged } = await service.from("ai_models").select("display_name").eq("id", target.id).single();
      expect(unchanged?.display_name).toBe("GPT-5.6 Luna");
    });

    it("service_role can read but not write", async () => {
      const { error } = await service.from("ai_models").update({ display_name: "x" }).eq("id", catalog[0].id).select();
      expect(error).not.toBeNull();
    });

    it("anon cannot read", async () => {
      const { error } = await anon.from("ai_models").select("id");
      expect(error).not.toBeNull();
    });
  });

  describe("seeded catalog", () => {
    it("has exactly one recommended, active model per (provider, kind)", () => {
      const recommended = new Map<string, CatalogRow[]>();
      for (const row of catalog) {
        const key = `${row.provider}/${row.kind}`;
        if (!recommended.has(key)) recommended.set(key, []);
        if (row.is_recommended) recommended.get(key)!.push(row);
      }
      expect([...recommended.keys()].sort()).toEqual([
        "anthropic/chat",
        "gemini/chat",
        "gemini/embedding",
        "openai/chat",
        "openai/embedding",
        "voyage/embedding",
      ]);
      for (const [key, rows] of recommended) {
        expect(rows, key).toHaveLength(1);
        expect(rows[0].is_active, key).toBe(true);
      }
    });

    it("has a partial HNSW index on document_chunks for every embedding dimension in the catalog", async () => {
      const { rows, error } = await runPrivilegedSql<{ indexdef: string }>(
        "select indexdef from pg_indexes where schemaname = 'public' and tablename = 'document_chunks'"
      );
      expect(error).toBeNull();
      const indexedDimensions = new Set(
        (rows ?? [])
          .filter((r) => r.indexdef.includes("USING hnsw"))
          .map((r) => /vector_dims\(embedding\) = (\d+)/.exec(r.indexdef)?.[1])
          .filter((d): d is string => d !== undefined)
          .map(Number)
      );
      const catalogDimensions = new Set(catalog.filter((m) => m.kind === "embedding").map((m) => m.dimensions));
      expect(catalogDimensions.size).toBeGreaterThan(0);
      for (const dimensions of catalogDimensions) {
        expect(indexedDimensions.has(dimensions!), `missing index for ${dimensions} dims`).toBe(true);
      }
    });
  });

  describe("ai_models constraints", () => {
    it("accepts a well-formed row (control for the rejections below)", async () => {
      const { error } = await tryInsertCatalogRow(
        "'openai', 'integration-valid-chat', 'chat', 'x', null, 1000, 100, 1, 2, '2026-09-11', false"
      );
      expect(error?.code).toBe("P0001");
    });

    it("rejects an anthropic embedding model", async () => {
      const { error } = await tryInsertCatalogRow(
        "'anthropic', 'integration-anthropic-emb', 'embedding', 'x', 1024, 1000, null, 1, null, '2026-09-11', false"
      );
      expect(error?.code).toBe("23514");
      expect(error?.message).toContain("ai_models_anthropic_is_chat_only");
    });

    it("rejects a voyage chat model", async () => {
      const { error } = await tryInsertCatalogRow(
        "'voyage', 'integration-voyage-chat', 'chat', 'x', null, 1000, 100, 1, 2, '2026-09-11', false"
      );
      expect(error?.code).toBe("23514");
      expect(error?.message).toContain("ai_models_voyage_is_embedding_only");
    });

    it("rejects an embedding model without dimensions", async () => {
      const { error } = await tryInsertCatalogRow(
        "'openai', 'integration-no-dims', 'embedding', 'x', null, 1000, null, 1, null, '2026-09-11', false"
      );
      expect(error?.code).toBe("23514");
      expect(error?.message).toContain("ai_models_fields_match_kind");
    });

    it("rejects a second recommended model for the same (provider, kind)", async () => {
      const { error } = await tryInsertCatalogRow(
        "'openai', 'integration-second-recommended', 'chat', 'x', null, 1000, 100, 1, 2, '2026-09-11', true"
      );
      expect(error?.code).toBe("23505");
      expect(error?.message).toContain("ai_models_one_recommended_per_provider_kind");
    });
  });

  describe("projects model references", () => {
    let projectId: string;

    beforeAll(async () => {
      const { data, error } = await owner.client
        .from("projects")
        .insert({ user_id: owner.id, name: "Catalog refs project" })
        .select("id")
        .single();
      if (error) throw new Error(`failed to create project: ${error.message}`);
      projectId = data.id as string;
    });

    it("chat_model_id rejects an embedding model", async () => {
      const { error } = await owner.client
        .from("projects")
        .update({ chat_model_id: catalogModel("openai", "text-embedding-3-small").id })
        .eq("id", projectId)
        .select();
      expect(error?.code).toBe("23503");
    });

    it("embedding_model_id rejects a chat model", async () => {
      const { error } = await owner.client
        .from("projects")
        .update({ embedding_model_id: catalogModel("openai", "gpt-5.6-luna").id })
        .eq("id", projectId)
        .select();
      expect(error?.code).toBe("23503");
    });

    it("accepts models of the matching kind", async () => {
      const chat = catalogModel("anthropic", "claude-sonnet-5");
      const embedding = catalogModel("voyage", "voyage-4");
      const { data, error } = await owner.client
        .from("projects")
        .update({ chat_model_id: chat.id, embedding_model_id: embedding.id })
        .eq("id", projectId)
        .select("chat_model_id, embedding_model_id")
        .single();
      expect(error).toBeNull();
      expect(data).toEqual({ chat_model_id: chat.id, embedding_model_id: embedding.id });
    });

    it("blocks changing the kind of a catalog model a project references", async () => {
      const terra = catalogModel("openai", "gpt-5.6-terra");
      const { id } = await createTestProject(service, owner.id, "Kind lock project");
      const { error: refError } = await service.from("projects").update({ chat_model_id: terra.id }).eq("id", id);
      expect(refError).toBeNull();

      // Every other constraint is satisfied, so only the FK can reject this.
      const { error } = await runPrivilegedSql(`
        do $$
        begin
          update public.ai_models
          set kind = 'embedding', dimensions = 1536, max_output_tokens = null, output_price_usd_per_mtok = null
          where id = '${terra.id}';
          raise exception 'updated' using errcode = 'P0001';
        end $$;
      `);
      expect(error?.code).toBe("23503");
    });
  });

  describe("match_document_chunks with variable dimensions", () => {
    let projectA: string;
    let projectB: string;
    let docA: string;
    let docB: string;

    function match(queryEmbedding: number[], model: string, projectId: string, matchCount = 10) {
      return service.rpc("match_document_chunks", {
        query_embedding: queryEmbedding,
        match_count: matchCount,
        p_project_id: projectId,
        p_embedding_model: model,
      });
    }

    function contents(data: unknown): string[] {
      return ((data ?? []) as MatchRow[]).map((row) => row.content);
    }

    beforeAll(async () => {
      projectA = (await createTestProject(service, owner.id, "Dims project A")).id;
      projectB = (await createTestProject(service, owner.id, "Dims project B")).id;

      const { data: docs, error: docsErr } = await service
        .from("documents")
        .insert([
          { project_id: projectA, title: "Dims doc A", source_type: "manual_upload" },
          { project_id: projectB, title: "Dims doc B", source_type: "manual_upload" },
        ])
        .select("id, project_id");
      if (docsErr) throw new Error(docsErr.message);
      docA = docs.find((d) => d.project_id === projectA)!.id as string;
      docB = docs.find((d) => d.project_id === projectB)!.id as string;

      const chunk = (documentId: string, chunkIndex: number, content: string, embedding: number[], model: string) => ({
        document_id: documentId,
        chunk_index: chunkIndex,
        content,
        embedding,
        embedding_provider: "integration-fake",
        embedding_model: model,
      });

      const { error } = await service.from("document_chunks").insert([
        chunk(docA, 0, "A 1536 exact", deterministicVector(0, 1536), MODEL_1536),
        chunk(docA, 1, "A 1536 blended", blend(1536, 0.8), MODEL_1536),
        chunk(docA, 2, "A 1536 other model", deterministicVector(0, 1536), "integration-other-model"),
        chunk(docA, 3, "A 1024 under the 1536 model name", deterministicVector(0, 1024), MODEL_1536),
        chunk(docA, 4, "A 3072 exact", deterministicVector(0, 3072), MODEL_3072),
        chunk(docA, 5, "A 3072 blended", blend(3072, 0.8), MODEL_3072),
        chunk(docA, 6, "A 1024 exact", deterministicVector(0, 1024), MODEL_1024),
        chunk(docB, 0, "B 1536 exact", deterministicVector(0, 1536), MODEL_1536),
        chunk(docB, 1, "B 3072 exact", deterministicVector(0, 3072), MODEL_3072),
      ]);
      if (error) throw new Error(`failed to insert chunks: ${error.message}`);
    });

    it("finds 1536-dim chunks of the same model, ordered by similarity", async () => {
      const { data, error } = await match(deterministicVector(0, 1536), MODEL_1536, projectA);
      expect(error).toBeNull();
      expect(contents(data)).toEqual(["A 1536 exact", "A 1536 blended"]);
      const rows = data as MatchRow[];
      expect(rows[0].similarity).toBeCloseTo(1, 5);
      expect(rows[0].similarity).toBeGreaterThan(rows[1].similarity);
    });

    it("finds 3072-dim chunks of the same model, ordered by similarity", async () => {
      const { data, error } = await match(deterministicVector(0, 3072), MODEL_3072, projectA);
      expect(error).toBeNull();
      expect(contents(data)).toEqual(["A 3072 exact", "A 3072 blended"]);
      const rows = data as MatchRow[];
      expect(rows[0].similarity).toBeCloseTo(1, 5);
      expect(rows[0].similarity).toBeGreaterThan(rows[1].similarity);
    });

    it("still serves 1024-dim queries", async () => {
      const { data, error } = await match(deterministicVector(0, 1024), MODEL_1024, projectA);
      expect(error).toBeNull();
      expect(contents(data)).toEqual(["A 1024 exact"]);
    });

    it("skips chunks of the same model name but another dimension, without error", async () => {
      const { data, error } = await match(deterministicVector(0, 1024), MODEL_1536, projectA);
      expect(error).toBeNull();
      expect(contents(data)).toEqual(["A 1024 under the 1536 model name"]);
    });

    it("returns nothing, without error, when no chunk has the query's model and dimension", async () => {
      const { data, error } = await match(deterministicVector(0, 1536), MODEL_3072, projectA);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    });

    it("respects match_count", async () => {
      const { data, error } = await match(deterministicVector(0, 1536), MODEL_1536, projectA, 1);
      expect(error).toBeNull();
      expect(contents(data)).toEqual(["A 1536 exact"]);
    });

    it("never returns another project's chunks", async () => {
      for (const [dimensions, model] of [
        [1536, MODEL_1536],
        [3072, MODEL_3072],
      ] as const) {
        const { data: forA } = await match(deterministicVector(0, dimensions), model, projectA);
        expect((forA as MatchRow[]).every((row) => row.document_id === docA)).toBe(true);

        const { data: forB, error } = await match(deterministicVector(0, dimensions), model, projectB);
        expect(error).toBeNull();
        expect((forB as MatchRow[]).map((row) => row.document_id)).toEqual([docB]);
      }
    });

    it("is not executable by an authenticated client", async () => {
      const { error } = await owner.client.rpc("match_document_chunks", {
        query_embedding: deterministicVector(0, 1536),
        match_count: 10,
        p_project_id: projectA,
        p_embedding_model: MODEL_1536,
      });
      expect(error).not.toBeNull();
    });

    it("runs with iterative HNSW scans so filtering can't starve top-k", async () => {
      const { rows, error } = await runPrivilegedSql<{ proconfig: string[] | null }>(
        "select proconfig from pg_proc where proname = 'match_document_chunks' and pronamespace = 'public'::regnamespace"
      );
      expect(error).toBeNull();
      expect(rows).toHaveLength(1);
      expect(rows![0].proconfig).toEqual(expect.arrayContaining(["hnsw.iterative_scan=relaxed_order"]));
    });

    it("no longer has the 3-argument overload", async () => {
      const { error } = await service.rpc("match_document_chunks", {
        query_embedding: deterministicVector(0, 1024),
        match_count: 10,
        p_project_id: projectA,
      });
      expect(error).not.toBeNull();
    });
  });
});
