// lib/retrieval/__tests__/chunking-quality.integration.test.ts
//
// Demonstrates, end to end against a real Postgres/pgvector instance, that
// the chunking (lib/ingestion/chunk.ts) + retrieval ranking
// (match_document_chunks, called via lib/retrieval/search.ts) pipeline
// retrieves the *correct* source document for a set of realistic
// questions. Backing content is the same text as the two demo documents
// in supabase/seed.sql (Return & Refund Policy, Employee Onboarding
// Guide), run through the real ingestion pipeline (ingestDocument).
//
// IMPORTANT CAVEAT (see README "Chunking parameters" / "What hasn't been
// tested live"): no real AI provider API key is available yet, so this
// uses lib/testing/keyword-embeddings.ts -- a deterministic bag-of-words
// hashing "embedding" that captures keyword overlap, not real semantic
// similarity. It is good enough to prove the ranking *mechanics* (chunk
// boundaries + cosine similarity ordering + per-user scoping) work
// correctly end to end, but is NOT a substitute for validating actual
// retrieval quality with a real embedding model -- that still needs to
// happen once OPENAI_API_KEY/ANTHROPIC_API_KEY+VOYAGE_API_KEY/GEMINI_API_KEY
// are available.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestDocument } from "../../ingestion/ingest";
import { runRetrieval } from "../search";
import { createKeywordEmbeddingsProvider } from "../../testing/keyword-embeddings";
import {
  createTestProject,
  createTestUser,
  deleteTestUser,
  hasIntegrationEnv,
  makeIntegrationSupabaseClient,
} from "../../testing/integration-helpers";

// Same content as supabase/seed.sql's two demo documents, reassembled into
// the flat "normalized document text" shape the ingestion pipeline
// actually receives (see CLAUDE.md's DocumentSource contract).
const RETURN_POLICY_TEXT = [
  "Customers may return any unopened item within 30 days of delivery for a full refund. Items must be in their original packaging with proof of purchase.",
  "Refunds are issued to the original payment method within 5-7 business days after we receive the returned item. Shipping costs are non-refundable unless the return is due to our error.",
  "Sale items and gift cards are final sale and cannot be returned or exchanged. Defective items can be exchanged for the same product at no cost within 90 days.",
].join("\n\n");

const ONBOARDING_TEXT = [
  "Welcome to the team! On your first day, IT will provide your laptop and set up your email and Slack accounts. HR will schedule a 30-minute orientation call to walk through benefits enrollment.",
  "All new hires complete a mandatory security training within the first week, covering password policy, phishing awareness, and data handling. This is tracked in the LMS and required before repository access is granted.",
].join("\n\n");

describe.skipIf(!hasIntegrationEnv())("chunking + retrieval quality (integration, real Supabase)", () => {
  let supabase: SupabaseClient;
  let userId: string;
  let projectId: string;
  let returnsDocId: string;
  let onboardingDocId: string;

  beforeAll(async () => {
    supabase = makeIntegrationSupabaseClient();
    const user = await createTestUser(supabase, "chunk-quality");
    userId = user.id;
    projectId = (await createTestProject(supabase, userId)).id;

    const embeddingsProvider = createKeywordEmbeddingsProvider();

    const { data: returnsDoc, error: returnsErr } = await supabase
      .from("documents")
      .insert({ project_id: projectId, title: "Return & Refund Policy.pdf", source_type: "manual_upload" })
      .select("id")
      .single();
    if (returnsErr) throw new Error(returnsErr.message);
    returnsDocId = returnsDoc.id as string;

    const { data: onboardingDoc, error: onboardingErr } = await supabase
      .from("documents")
      .insert({ project_id: projectId, title: "Employee Onboarding Guide", source_type: "url", source_ref: "https://example.com/handbook/onboarding" })
      .select("id")
      .single();
    if (onboardingErr) throw new Error(onboardingErr.message);
    onboardingDocId = onboardingDoc.id as string;

    await ingestDocument(
      { documentId: returnsDocId, projectId, ownerUserId: userId, title: "Return & Refund Policy.pdf", text: RETURN_POLICY_TEXT },
      { supabase, embeddingsProvider }
    );
    await ingestDocument(
      { documentId: onboardingDocId, projectId, ownerUserId: userId, title: "Employee Onboarding Guide", text: ONBOARDING_TEXT },
      { supabase, embeddingsProvider }
    );
  });

  afterAll(async () => {
    if (userId) await deleteTestUser(supabase, userId);
  });

  it.each([
    {
      question: "How many days do I have to return an item for a refund?",
      expectedDocumentId: () => returnsDocId,
      expectedSubstring: "30 days",
    },
    {
      question: "What happens on my first day as a new employee?",
      expectedDocumentId: () => onboardingDocId,
      expectedSubstring: "first day",
    },
    {
      question: "Is security training mandatory for new hires?",
      expectedDocumentId: () => onboardingDocId,
      expectedSubstring: "security training",
    },
  ])(
    "retrieves the correct document as the top match for: $question",
    async ({ question, expectedDocumentId, expectedSubstring }) => {
      const result = await runRetrieval(question, projectId, {
        supabase,
        embeddingsProvider: createKeywordEmbeddingsProvider(),
      });

      expect(result.sources.length).toBeGreaterThan(0);
      expect(result.sources[0].documentId).toBe(expectedDocumentId());
      expect(result.sources[0].similarity).toBeGreaterThan(0);
      expect(result.contextText.toLowerCase()).toContain(expectedSubstring.toLowerCase());
    }
  );
});
