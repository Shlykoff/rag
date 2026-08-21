// scripts/seed-ai-credentials.ts
//
// Populates the seeded demo account's account-level AI-provider credentials
// (`ai_provider_credentials`) AND the seeded demo PROJECT's
// `projects.active_ai_provider` (projects architecture pivot -- that
// selection moved off the now-dropped `user_settings` table, see the
// projects migration's header) from whichever of OPENAI_API_KEY /
// ANTHROPIC_API_KEY / VOYAGE_API_KEY / GEMINI_API_KEY are set in
// .env.local -- the SAME env vars that used to drive the old
// process-global `AI_PROVIDER` selection (lib/ai/index.ts). Now that every
// account (including the demo account) reads its own encrypted credentials
// from the DB instead, those env vars' only remaining job is feeding THIS
// script.
//
// Why this has to be a companion script and can't just live in
// supabase/seed.sql: seed.sql is plain SQL, with no access to
// process.env or this project's AES-256-GCM encryption code
// (lib/ai/crypto.ts) -- it cannot itself read a real API key out of
// .env.local and encrypt it. This script is the Node-side half of seeding
// the demo account, run separately (`npm run seed:ai-keys`) after
// `supabase db reset` has (re-)created the demo user.
//
// **This is a REQUIRED step, not an optional one** (see README "Running
// locally"): without it, the demo account has zero configured AI
// providers and hits the exact same 422 { error: "no_credentials" }
// "add a key" response/modal as any other brand-new, not-yet-configured
// user the very first time it tries to chat -- silently regressing the
// "git clone && npm i && .env.local && npm run dev just works" experience
// this project had before bring-your-own-key.
//
// Idempotent (safe to re-run any number of times, e.g. every time
// `supabase db reset` recreates the demo user from supabase/seed.sql):
//   - saveAIProviderCredential() upserts by (user_id, provider), so
//     re-running with the same .env.local just re-encrypts and overwrites
//     the same rows, never accumulating duplicates.
//   - active_ai_provider is only ever set if it isn't ALREADY set -- this
//     script never overwrites a choice a human already made (e.g. by
//     visiting /profile and picking a different provider for the demo
//     account on purpose).
//
// **Second job, added after the above shipped**: supabase/seed.sql seeds
// the two demo documents' chunks with `embedding = NULL` (there was no real
// AI provider key anywhere in the project at the time db-architect wrote
// that file) and its own comment explicitly deferred re-embedding them to
// "once an AI_PROVIDER key is configured" -- which, for the actual demo
// account, only ever happens right here, right after the credential-saving
// loop above runs. So immediately after seeding credentials, this script
// also re-runs both demo documents through the real ingestion pipeline
// (`ingestDocumentWithDefaultProviders`, see `reembedDemoDocuments` below) so
// `npm run seed:ai-keys` alone is enough to make the seeded demo account's
// retrieval actually return sources, not just have its provider *keys*
// configured. This second job is best-effort: it never throws, and a
// missing/invalid/rate-limited key here logs a warning and leaves the demo
// documents as they were rather than failing the whole script (see
// `reembedDemoDocuments`'s own doc comment).
//
// Run via `npm run seed:ai-keys`, which loads .env.local (Node's
// `--env-file`, same mechanism `npm run test:integration` already uses)
// and executes this file through scripts/run-seed-ai-credentials.mjs -- see
// that file's header for why a plain `node scripts/seed-ai-credentials.ts`
// wouldn't work on its own (extensionless internal lib/ai/ imports +
// neutralizing the `server-only` guard).

import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  saveAIProviderCredential,
  getActiveProvider,
  setActiveProvider,
  hasAIProviderCredential,
  type AIProviderCredentialType,
} from "../lib/ai/credentials";
import { getServiceRoleClient } from "../lib/supabase/service-client";
import { ingestDocumentWithDefaultProviders } from "../lib/ingestion/ingest";

/** Fixed demo user id, created by supabase/seed.sql (demo@example.com) -- see that file's own comment block for the full local-dev-only rationale. */
const DEMO_USER_ID = "00000000-0000-0000-0000-000000000001";
/** Fixed demo project id ("Demo Project"), also created by supabase/seed.sql -- owned by DEMO_USER_ID. Every project-scoped call in this script (active_ai_provider, document re-embedding) targets this id, not the account directly -- see the projects migration's header for why active_ai_provider moved off the account level. */
const DEMO_PROJECT_ID = "00000000-0000-0000-0000-000000000002";

const ENV_KEY_BY_PROVIDER: Record<AIProviderCredentialType, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  voyage: "VOYAGE_API_KEY",
  gemini: "GEMINI_API_KEY",
};

/**
 * The script's original job (adapted for the projects pivot): upsert
 * whichever `.env.local` provider keys are present as the demo ACCOUNT's
 * credentials (unchanged, account-level), then default the demo PROJECT's
 * `active_ai_provider` to 'gemini' if nothing has been chosen for it yet.
 * Split out from `main()` so the demo-document re-embed step below
 * (`reembedDemoDocuments`) can never prevent this part from completing --
 * see `main()`'s own comment for why that ordering matters.
 */
async function seedCredentialsAndActiveProvider(supabase: SupabaseClient): Promise<void> {
  const seededThisRun: AIProviderCredentialType[] = [];

  for (const provider of Object.keys(ENV_KEY_BY_PROVIDER) as AIProviderCredentialType[]) {
    const envKey = ENV_KEY_BY_PROVIDER[provider];
    const value = process.env[envKey];
    if (!value) {
      // Not an error -- CLAUDE.md/this script's own contract: skip
      // whichever provider(s) don't have a real key on hand rather than
      // failing the whole run. A demo environment with, say, only a Gemini
      // key still ends up fully usable.
      console.info(`seed-ai-credentials: ${envKey} not set in .env.local -- skipping '${provider}'.`);
      continue;
    }
    await saveAIProviderCredential(supabase, DEMO_USER_ID, provider, value);
    seededThisRun.push(provider);
    console.info(`seed-ai-credentials: stored an encrypted '${provider}' credential for the demo user.`);
  }

  const currentActive = await getActiveProvider(supabase, DEMO_PROJECT_ID);
  if (currentActive) {
    console.info(
      `seed-ai-credentials: the demo project's active_ai_provider is already '${currentActive}' -- leaving it as-is (this script never overrides a choice already made, e.g. via the project's model-selection UI).`
    );
    return;
  }

  // gemini preferred: as of the last live check (README "What's been
  // verified live"), it's the one provider with a real, working account
  // balance in this environment -- openai/anthropic are correctly wired
  // end-to-end but currently blocked on billing, so defaulting to either
  // of those would leave the demo project's very first chat message
  // failing with a real vendor error instead of a clean local success.
  const geminiIsConfigured =
    seededThisRun.includes("gemini") || (await hasAIProviderCredential(supabase, DEMO_USER_ID, "gemini"));
  if (!geminiIsConfigured) {
    console.warn(
      "seed-ai-credentials: GEMINI_API_KEY is not set (in this run or a previous one) -- cannot default " +
        "the demo project's active_ai_provider to 'gemini'. Set GEMINI_API_KEY in .env.local and re-run " +
        "`npm run seed:ai-keys`, or pick a provider manually for the demo project once its model-selection UI exists."
    );
    return;
  }
  await setActiveProvider(supabase, DEMO_PROJECT_ID, DEMO_USER_ID, "gemini");
  console.info("seed-ai-credentials: set active_ai_provider = 'gemini' for the demo project.");
}

// ---------------------------------------------------------------------------
// Demo document re-embedding
//
// supabase/seed.sql seeds the two demo documents ("Return & Refund
// Policy.pdf", "Employee Onboarding Guide") with hand-written chunk rows but
// `embedding = NULL` on every one of them -- see that file's own comment
// block: db-architect wrote them before any real AI provider key existed
// anywhere in this project, with an explicit "will be re-ingested by
// rag-pipeline-specialist" placeholder that was never followed up on until
// now. NULL embeddings are correctly excluded by match_document_chunks
// (`where embedding is not null`), so retrieval against the demo account
// silently returned zero sources for every question -- this step is what
// closes that loop, right after the demo user has real, usable credentials
// (this script's original job, above) to re-embed with.
// ---------------------------------------------------------------------------

interface DemoDocumentRow {
  id: string;
  title: string;
  storage_path: string | null;
}

/**
 * Finds every document under the demo project that still has at least one
 * chunk with `embedding IS NULL` -- i.e. has never been successfully run
 * through the real ingestion pipeline. This is what makes re-running this
 * step idempotent for free, with no extra bookkeeping: once
 * ingestDocumentWithDefaultProviders() below replaces a document's chunks,
 * every remaining chunk row has a non-null embedding (ingest.ts never
 * inserts a chunk row without one -- see its embed-then-insert ordering),
 * so a second run of this script finds nothing left to do for that
 * document and leaves it untouched (no duplicate ingest call, no
 * duplicate chunks).
 */
async function findDemoDocumentsNeedingEmbeddings(supabase: SupabaseClient): Promise<DemoDocumentRow[]> {
  const { data: documents, error: documentsError } = await supabase
    .from("documents")
    .select("id, title, storage_path")
    .eq("project_id", DEMO_PROJECT_ID)
    .returns<DemoDocumentRow[]>();
  if (documentsError) {
    throw new Error(`findDemoDocumentsNeedingEmbeddings: failed to load demo documents: ${documentsError.message}`);
  }
  if (!documents || documents.length === 0) return [];

  const { data: unembeddedChunks, error: chunksError } = await supabase
    .from("document_chunks")
    .select("document_id")
    .in(
      "document_id",
      documents.map((d) => d.id)
    )
    .is("embedding", null)
    .returns<{ document_id: string }[]>();
  if (chunksError) {
    throw new Error(`findDemoDocumentsNeedingEmbeddings: failed to check for un-embedded chunks: ${chunksError.message}`);
  }

  const staleDocumentIds = new Set((unembeddedChunks ?? []).map((c) => c.document_id));
  return documents.filter((d) => staleDocumentIds.has(d.id));
}

/**
 * Reconstructs a document's full text from its already-chunked
 * `document_chunks.content` rows, ordered by `chunk_index`. Fallback path
 * used only when the Storage "cached text" object at `storage_path` isn't
 * actually readable (see getDocumentText below) -- true for both seeded
 * demo documents today, since supabase/seed.sql inserts `documents` rows
 * with a `storage_path` string but never uploads a matching object into
 * Supabase Storage (that upload only happens via lib/sources/pipeline.ts,
 * which seed.sql -- plain SQL, no Storage API access -- can't call).
 *
 * Naive concatenation would double up text at chunk boundaries for chunks
 * produced by the real chunker (lib/ingestion/chunk.ts), which
 * deliberately carries ~12% overlapping sentences into the next chunk.
 * That does NOT apply here: the seed data's chunk rows are hand-written,
 * non-overlapping paragraph-sized pieces (see supabase/seed.sql -- each
 * chunk's content is a disjoint slice of the source policy/handbook text,
 * not the output of chunkText()), so a plain paragraph-break join
 * reconstitutes the original text exactly, with no de-duplication needed.
 * A general-purpose overlap-aware reassembly is intentionally not
 * implemented here since it would have nothing to prove itself against in
 * this codebase's only caller of this function.
 */
async function reconstructTextFromChunks(supabase: SupabaseClient, documentId: string, title: string): Promise<string> {
  const { data, error } = await supabase
    .from("document_chunks")
    .select("chunk_index, content")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true })
    .returns<{ chunk_index: number; content: string }[]>();
  if (error) {
    throw new Error(`reconstructTextFromChunks: failed to load chunks for document ${documentId}: ${error.message}`);
  }
  if (!data || data.length === 0) {
    throw new Error(`reconstructTextFromChunks: document ${documentId} ("${title}") has no chunks to reconstruct text from`);
  }
  return data.map((c) => c.content).join("\n\n");
}

/**
 * Returns the full text to re-ingest a demo document with: the Storage
 * "cached text" object at `storage_path` when it's actually present and
 * non-empty (the more faithful source -- see CLAUDE.md's ingestion
 * principles), falling back to reconstructTextFromChunks() otherwise. Live
 * checked against this project's actual local Supabase instance: neither
 * seeded demo document has a real Storage object at its `storage_path`
 * (confirmed via `select * from storage.objects` -- zero rows for either
 * path), so both fall through to the chunk-reconstruction path today; the
 * Storage-first attempt is kept anyway so this keeps working correctly,
 * unchanged, if a future seed.sql revision (or a one-off manual upload)
 * ever does populate real objects at these paths.
 */
async function getDocumentText(supabase: SupabaseClient, doc: DemoDocumentRow): Promise<string> {
  if (doc.storage_path) {
    const { data, error } = await supabase.storage.from("documents").download(doc.storage_path);
    if (!error && data) {
      const text = await data.text();
      if (text.trim().length > 0) return text;
    }
    console.warn(
      `seed-ai-credentials: no readable Storage object at "${doc.storage_path}" for "${doc.title}" ` +
        `(${error?.message ?? "empty content"}) -- falling back to reconstructing text from document_chunks.content.`
    );
  }
  return reconstructTextFromChunks(supabase, doc.id, doc.title);
}

/**
 * Re-runs the two seeded demo documents through the real ingestion
 * pipeline (lib/ingestion/ingest.ts, via the exact same
 * ingestDocumentWithDefaultProviders() entry point app/api/sources/upload
 * and every other source adapter uses) now that the demo user has real
 * credentials from seedCredentialsAndActiveProvider() above. Never throws:
 * every failure mode here (no active provider configured at all, a lookup
 * query failing, a single document's embed call failing because its
 * provider key is invalid/expired/rate-limited) is caught and logged as a
 * warning instead, per this task's explicit "safe at absent/broken keys"
 * requirement -- this is a best-effort step layered on top of the script's
 * main, always-must-succeed job (saving credentials), not a second
 * required step.
 */
async function reembedDemoDocuments(supabase: SupabaseClient): Promise<void> {
  const activeProvider = await getActiveProvider(supabase, DEMO_PROJECT_ID);
  if (!activeProvider) {
    console.warn(
      "seed-ai-credentials: no active_ai_provider configured for the demo project -- skipping demo document " +
        "re-embedding. Re-run `npm run seed:ai-keys` once at least one working provider key is available."
    );
    return;
  }

  let staleDocuments: DemoDocumentRow[];
  try {
    staleDocuments = await findDemoDocumentsNeedingEmbeddings(supabase);
  } catch (err) {
    console.warn(
      `seed-ai-credentials: failed to look up demo documents needing embeddings -- skipping re-embed step: ${
        err instanceof Error ? err.message : err
      }`
    );
    return;
  }

  if (staleDocuments.length === 0) {
    console.info("seed-ai-credentials: demo documents already have embeddings -- nothing to re-embed.");
    return;
  }

  for (const doc of staleDocuments) {
    try {
      const text = await getDocumentText(supabase, doc);
      const result = await ingestDocumentWithDefaultProviders({
        documentId: doc.id,
        projectId: DEMO_PROJECT_ID,
        ownerUserId: DEMO_USER_ID,
        title: doc.title,
        text,
      });
      console.info(
        `seed-ai-credentials: re-embedded demo document "${doc.title}" (${result.chunkCount} chunks) using ` +
          `${result.embeddingProvider}/${result.embeddingModel}.`
      );
    } catch (err) {
      // A demo document that can't be re-embedded right now (invalid/
      // expired key, vendor outage, insufficient balance -- see README
      // "What's been verified live" for a real example of the latter)
      // must not crash the rest of this loop or the script's exit code --
      // ingestDocumentWithDefaultProviders() has already flipped this
      // document's processing_status to 'error' with a processing_error
      // message on its own, so this is just a console warning on top, not
      // the only record of the failure.
      console.warn(
        `seed-ai-credentials: failed to re-embed demo document "${doc.title}" (${doc.id}) -- leaving it as-is: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }
}

async function main(): Promise<void> {
  const supabase = getServiceRoleClient();

  // Required step: must complete (or throw, failing the whole script) on
  // every run -- see this function's own doc comment.
  await seedCredentialsAndActiveProvider(supabase);

  // Best-effort step layered on top, per this task's requirement: never
  // let a re-embed failure (missing/invalid keys, a vendor outage, ...)
  // turn into an uncaught rejection that fails `npm run seed:ai-keys`
  // itself -- reembedDemoDocuments() already catches everything it can
  // usefully attribute to a specific document/cause internally and logs a
  // warning; this outer catch is only a backstop for anything that
  // slips past that (e.g. the initial getActiveProvider() call itself
  // failing).
  await reembedDemoDocuments(supabase).catch((err: unknown) => {
    console.warn(
      `seed-ai-credentials: unexpected error while re-embedding demo documents -- continuing: ${
        err instanceof Error ? err.message : err
      }`
    );
  });
}

main()
  .then(() => {
    console.info("seed-ai-credentials: done.");
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error("seed-ai-credentials: failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
