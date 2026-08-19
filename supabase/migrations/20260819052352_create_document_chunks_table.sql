-- document_chunks: the retrieval unit. One row per chunk of a document,
-- each with its own embedding.
--
-- embedding is fixed at vector(1024) regardless of which AI provider is
-- active (OpenAI / Anthropic+Voyage / Gemini) — every provider is
-- configured by rag-pipeline-specialist to output 1024 dimensions via its
-- `dimensions`/`output_dimension`/`output_dimensionality` parameter, so the
-- schema never needs to change on provider switch. 1024 (not 1536) is the
-- only value that works natively across all three: Voyage's
-- `output_dimension` accepts only {256, 512, 1024, 2048} (1024 is its
-- default) and does not support 1536 at all, while OpenAI's `dimensions`
-- and Gemini's `output_dimensionality` both support arbitrary truncation
-- down to 1024 (Matryoshka-style). embedding_provider and
-- embedding_model record which provider/model actually produced *this*
-- row's vector, so stale rows (from a previous AI_PROVIDER) can be found
-- and re-embedded after a switch — different models produce incompatible
-- vector spaces even at the same dimensionality, so mixing them in one
-- similarity search would silently return garbage.
create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  -- Position for citation ("page 3", "paragraph 12", ...). Free-form on
  -- purpose: PDFs cite a page number, Notion/URL sources may only have an
  -- ordinal position. rag-pipeline-specialist decides the exact value.
  page_number integer,
  chunk_position integer,
  embedding extensions.vector(1024),
  embedding_provider text,
  embedding_model text,
  created_at timestamptz not null default now(),
  constraint document_chunks_document_chunk_index_unique unique (document_id, chunk_index),
  -- If a vector is present, we must know which provider/model produced it
  -- -- that's what lets a later AI_PROVIDER switch find and re-embed stale
  -- rows (see the column comments below and CLAUDE.md). Without this
  -- constraint, code could write an embedding while leaving provider/model
  -- null (e.g. a bug in the ingestion pipeline), silently breaking that
  -- staleness check. Rows with no embedding yet are unaffected: all three
  -- columns are allowed to be null together (chunk created, not yet
  -- embedded).
  constraint document_chunks_embedding_requires_provider_and_model check (
    embedding is null or (embedding_provider is not null and embedding_model is not null)
  )
);

comment on table public.document_chunks is
  'Chunked text + embedding for retrieval. embedding is nullable so a chunk row can exist mid-pipeline before the embedding step runs; NULL rows must be excluded from similarity search. Contract for re-sync ("Refresh"): the ingestion pipeline MUST delete all existing chunk rows for a document_id before inserting the new set (delete-before-insert), never insert-or-update by chunk_index alone -- otherwise a document that shrinks from e.g. 10 chunks to 6 on re-ingest leaves chunk_index 6-9 behind from the previous version, and match_document_chunks would keep returning stale/orphaned content for that document. This is not enforced by the schema (no trigger deletes on your behalf) -- it is a hard requirement on whatever code performs re-ingestion (rag-pipeline-specialist).';
comment on column public.document_chunks.embedding is
  'vector(1024): fixed size across all supported providers. 1024 is Voyage''s native default and the only output_dimension it supports that OpenAI/Gemini can also truncate down to (Voyage does not support 1536 at all), see CLAUDE.md. Switching AI_PROVIDER requires re-embedding, not a schema change.';
comment on column public.document_chunks.embedding_provider is
  'Provider that generated this row''s embedding (openai|anthropic|gemini), used to find rows that need re-embedding after an AI_PROVIDER switch.';
comment on column public.document_chunks.embedding_model is
  'Concrete model name (e.g. text-embedding-3-small, voyage-4, gemini-embedding-001) for the same staleness check at finer grain than the provider.';
comment on column public.document_chunks.page_number is
  'Source page number for citation, when the source format has pages (PDF). Null otherwise.';
comment on column public.document_chunks.chunk_position is
  'Ordinal position of the chunk within the document, used for citation when there is no page concept (Notion/URL/plain text). Named chunk_position rather than the reserved word "position".';

create index document_chunks_document_id_idx on public.document_chunks (document_id);

-- Vector index for approximate nearest-neighbor search -------------------
-- HNSW, not IVFFlat: this is a portfolio/demo project with a small,
-- slowly-growing corpus (a handful of documents, at most low thousands of
-- chunks). IVFFlat's `lists` parameter has to be sized against the
-- expected row count (roughly rows/1000, or sqrt(rows)) and gives poor
-- recall until the table is actually populated close to that estimate —
-- exactly wrong for a demo that starts at 2 seed documents and grows
-- unpredictably as a client uploads their own files. HNSW has no such
-- row-count-dependent tuning parameter, gives better recall/speed at these
-- data sizes, and the local Postgres image ships pgvector 0.8.2 which
-- supports it. Trade-off (more expensive index build, more memory) is
-- irrelevant at this scale.
-- Cosine distance (vector_cosine_ops) is used because embeddings from all
-- three supported providers are compared for direction/similarity, not
-- magnitude, and cosine is what OpenAI/Voyage/Gemini embeddings are tuned
-- for.
create index document_chunks_embedding_hnsw_idx
  on public.document_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- Row Level Security -----------------------------------------------------
-- Chunks are never written by the end user directly — the ingestion
-- pipeline (server-side, using SUPABASE_SERVICE_ROLE_KEY, which bypasses
-- RLS) creates them after chunking + embedding. So the only client-facing
-- policy is SELECT, scoped to chunks whose parent document belongs to the
-- caller. No insert/update/delete policies exist for authenticated users
-- at all (deny by default covers those operations).

alter table public.document_chunks enable row level security;

create policy "document_chunks_select_own"
  on public.document_chunks for select
  to authenticated
  using (
    exists (
      select 1
      from public.documents d
      where d.id = document_chunks.document_id
        and d.user_id = auth.uid()
    )
  );

-- Table-level grants -------------------------------------------------------
-- See the equivalent comment in the documents migration: new tables are
-- not auto-exposed to Data API roles here, so explicit GRANTs are
-- required in addition to RLS/policies, for both authenticated and
-- service_role (BYPASSRLS does not imply table privileges).
-- authenticated: SELECT only, matching the single policy above -- end
-- users never write chunks directly, only the ingestion pipeline does.
grant select on public.document_chunks to authenticated;
-- service_role: full CRUD -- the ingestion pipeline (server-side) creates,
-- rewrites and deletes chunks around chunking/(re-)embedding.
grant select, insert, update, delete on public.document_chunks to service_role;
