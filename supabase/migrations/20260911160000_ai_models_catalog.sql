-- Catalog of concrete chat/embedding models a project can pick, per-project
-- model references, and variable-dimension embeddings.
--
-- Compatible with the code that is live while this runs: projects.
-- active_ai_provider / embedding_provider are left untouched, 1024-dim
-- chunks still insert and index, and match_document_chunks keeps its
-- 4-argument signature.

-- ai_models ----------------------------------------------------------------

create type public.ai_model_kind as enum ('chat', 'embedding');

create table public.ai_models (
  id uuid primary key default gen_random_uuid(),
  provider public.ai_provider_type not null,
  model_id text not null,
  kind public.ai_model_kind not null,
  display_name text not null,
  dimensions int,
  context_window int not null constraint ai_models_context_window_positive check (context_window > 0),
  max_output_tokens int,
  input_price_usd_per_mtok numeric(10, 4) not null
    constraint ai_models_input_price_non_negative check (input_price_usd_per_mtok >= 0),
  output_price_usd_per_mtok numeric(10, 4)
    constraint ai_models_output_price_non_negative check (output_price_usd_per_mtok >= 0),
  pricing_as_of date not null,
  is_recommended boolean not null default false,
  is_active boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_models_provider_model_id_unique unique (provider, model_id),
  -- Target of the composite FKs from projects that pin the referenced kind.
  constraint ai_models_id_kind_unique unique (id, kind),
  constraint ai_models_fields_match_kind check (
    (
      kind = 'chat'
      and dimensions is null
      and max_output_tokens is not null and max_output_tokens > 0
      and output_price_usd_per_mtok is not null
    )
    or (
      kind = 'embedding'
      and dimensions is not null and dimensions > 0
      and max_output_tokens is null
      and output_price_usd_per_mtok is null
    )
  ),
  constraint ai_models_anthropic_is_chat_only check (provider <> 'anthropic' or kind = 'chat'),
  constraint ai_models_voyage_is_embedding_only check (provider <> 'voyage' or kind = 'embedding'),
  -- The recommended model is the default for new projects and backfills, so
  -- it can't point at a retired one.
  constraint ai_models_recommended_is_active check (is_active or not is_recommended)
);

create unique index ai_models_one_recommended_per_provider_kind
  on public.ai_models (provider, kind)
  where is_recommended;

comment on table public.ai_models is
  'Catalog of concrete chat and embedding models a project can select. Changed only through migrations (no write grants for any API role). Retired models are hidden with is_active = false, never deleted: projects keep referencing them.';
comment on column public.ai_models.model_id is
  'Model identifier as the provider API expects it (e.g. gpt-5.6-luna, voyage-4-large).';
comment on column public.ai_models.dimensions is
  'Embedding models only: vector length stored in document_chunks.embedding. A dimension not yet present in this table needs a new partial HNSW index on document_chunks in the same migration that adds the model.';
comment on column public.ai_models.context_window is
  'Maximum input tokens.';
comment on column public.ai_models.max_output_tokens is
  'Chat models only.';
comment on column public.ai_models.input_price_usd_per_mtok is
  'USD per million input tokens, as of pricing_as_of.';
comment on column public.ai_models.output_price_usd_per_mtok is
  'Chat models only: USD per million output tokens, as of pricing_as_of.';
comment on column public.ai_models.is_recommended is
  'Default choice for its (provider, kind); at most one per pair.';
comment on column public.ai_models.is_active is
  'False = retired: not offered for new selections, still readable for projects that reference it.';

create trigger set_ai_models_updated_at
  before update on public.ai_models
  for each row
  execute function public.set_updated_at();

-- Inactive rows stay readable so a project pointing at a retired model can
-- still display it.
alter table public.ai_models enable row level security;

create policy "ai_models_select_all"
  on public.ai_models for select
  to authenticated
  using (true);

-- Revoke by role name before granting -- see the projects migration
-- (20260819052349, "Table-level grants").
revoke all on public.ai_models from anon, authenticated, service_role;
grant select on public.ai_models to authenticated;
grant select on public.ai_models to service_role;

insert into public.ai_models (
  provider, model_id, kind, display_name, dimensions, context_window, max_output_tokens,
  input_price_usd_per_mtok, output_price_usd_per_mtok, pricing_as_of, is_recommended, sort_order
)
values
  ('openai',    'gpt-5.6-luna',           'chat',      'GPT-5.6 Luna',           null, 1050000, 128000, 0.20, 1.20,  '2026-09-11', true,  10),
  ('openai',    'gpt-5.6-terra',          'chat',      'GPT-5.6 Terra',          null, 1050000, 128000, 2.00, 12.00, '2026-09-11', false, 20),
  ('openai',    'gpt-5.6-sol',            'chat',      'GPT-5.6 Sol',            null, 1050000, 128000, 4.00, 20.00, '2026-09-11', false, 30),
  ('openai',    'gpt-4.1-mini',           'chat',      'GPT-4.1 mini',           null, 1047576, 32768,  0.40, 1.60,  '2026-09-11', false, 40),
  ('anthropic', 'claude-opus-5',          'chat',      'Claude Opus 5',          null, 1000000, 128000, 5.00, 25.00, '2026-09-11', true,  50),
  ('anthropic', 'claude-sonnet-5',        'chat',      'Claude Sonnet 5',        null, 1000000, 128000, 2.00, 10.00, '2026-09-11', false, 60),
  ('anthropic', 'claude-haiku-4-5',       'chat',      'Claude Haiku 4.5',       null, 200000,  64000,  1.00, 5.00,  '2026-09-11', false, 70),
  ('gemini',    'gemini-3.8-flash',       'chat',      'Gemini 3.8 Flash',       null, 1048576, 65536,  0.75, 3.75,  '2026-09-11', true,  80),
  ('gemini',    'gemini-3.6-flash',       'chat',      'Gemini 3.6 Flash',       null, 1048576, 65536,  0.75, 3.75,  '2026-09-11', false, 90),
  ('gemini',    'gemini-3.5-flash-lite',  'chat',      'Gemini 3.5 Flash-Lite',  null, 1048576, 65536,  0.30, 2.50,  '2026-09-11', false, 100),
  ('openai',    'text-embedding-3-small', 'embedding', 'text-embedding-3-small', 1536, 8191,    null,   0.02, null,  '2026-09-11', true,  110),
  ('openai',    'text-embedding-3-large', 'embedding', 'text-embedding-3-large', 3072, 8191,    null,   0.13, null,  '2026-09-11', false, 120),
  ('gemini',    'gemini-embedding-001',   'embedding', 'Gemini Embedding 001',   3072, 2048,    null,   0.15, null,  '2026-09-11', true,  130),
  ('gemini',    'gemini-embedding-2',     'embedding', 'Gemini Embedding 2',     3072, 8192,    null,   0.20, null,  '2026-09-11', false, 140),
  ('voyage',    'voyage-4-large',         'embedding', 'Voyage 4 Large',         1024, 32000,   null,   0.12, null,  '2026-09-11', true,  150),
  ('voyage',    'voyage-4',               'embedding', 'Voyage 4',               1024, 32000,   null,   0.06, null,  '2026-09-11', false, 160),
  ('voyage',    'voyage-4-lite',          'embedding', 'Voyage 4 Lite',          1024, 32000,   null,   0.02, null,  '2026-09-11', false, 170);

-- projects -> ai_models ----------------------------------------------------
-- The kind is enforced by a composite FK onto ai_models (id, kind): each
-- reference is paired with a generated constant column, so a chat slot can
-- only match a 'chat' row. Unlike a trigger, this also blocks changing the
-- kind of a catalog row that a project already references (the FK rejects
-- the ai_models update). MATCH SIMPLE: a null model id skips the check.

alter table public.projects
  add column chat_model_id uuid,
  add column chat_model_kind public.ai_model_kind
    generated always as ('chat'::public.ai_model_kind) stored,
  add column embedding_model_id uuid,
  add column embedding_model_kind public.ai_model_kind
    generated always as ('embedding'::public.ai_model_kind) stored,
  add constraint projects_chat_model_fkey
    foreign key (chat_model_id, chat_model_kind)
    references public.ai_models (id, kind)
    on delete restrict,
  add constraint projects_embedding_model_fkey
    foreign key (embedding_model_id, embedding_model_kind)
    references public.ai_models (id, kind)
    on delete restrict;

comment on column public.projects.chat_model_id is
  'Catalog chat model this project answers with. Null until chosen.';
comment on column public.projects.embedding_model_id is
  'Catalog embedding model for this project''s documents and questions. Null until chosen. Chunks embedded by a different model or dimension are skipped by match_document_chunks until re-indexed.';
comment on column public.projects.chat_model_kind is
  'Always ''chat''. Exists only so projects_chat_model_fkey can pin the referenced ai_models row to kind = chat.';
comment on column public.projects.embedding_model_kind is
  'Always ''embedding''. Exists only so projects_embedding_model_fkey can pin the referenced ai_models row to kind = embedding.';

-- Backfill from the provider columns. updated_at tracks user edits, so the
-- trigger is paused for this statement.
alter table public.projects disable trigger set_projects_updated_at;

update public.projects p
set chat_model_id = m.id
from public.ai_models m
where p.chat_model_id is null
  and m.provider = p.active_ai_provider
  and m.kind = 'chat'
  and m.is_recommended;

update public.projects p
set embedding_model_id = m.id
from public.ai_models m
where p.embedding_model_id is null
  and m.provider = p.embedding_provider
  and m.kind = 'embedding'
  and m.is_recommended;

alter table public.projects enable trigger set_projects_updated_at;

-- document_chunks.embedding: any dimension -------------------------------
-- HNSW needs a fixed dimension, so the single index on vector(1024) is
-- replaced by one partial expression index per dimension in the catalog.
-- Dropping the typmod is a catalog-only change (no table rewrite), and
-- index expressions are only evaluated for rows matching the predicate, so
-- the casts below never see a vector of another length.

drop index public.document_chunks_embedding_hnsw_idx;

alter table public.document_chunks
  alter column embedding type extensions.vector;

comment on column public.document_chunks.embedding is
  'Embedding of any dimension, produced by embedding_model. Searched only against queries from the same model and dimension. Each dimension needs its own partial HNSW index (document_chunks_embedding_<N>_hnsw_idx): adding a catalog model with a new dimension requires a migration that also adds that index.';
comment on column public.document_chunks.embedding_provider is
  'Provider that generated this row''s embedding.';
comment on column public.document_chunks.embedding_model is
  'Model that generated this row''s embedding (ai_models.model_id). match_document_chunks only compares a query against chunks from the same model.';

-- HNSW over vector is limited to 2000 dimensions; above that the index is
-- built on a halfvec cast (up to 4000). Cosine, as before.
create index document_chunks_embedding_1024_hnsw_idx
  on public.document_chunks
  using hnsw ((embedding::extensions.vector(1024)) extensions.vector_cosine_ops)
  where extensions.vector_dims(embedding) = 1024;

create index document_chunks_embedding_1536_hnsw_idx
  on public.document_chunks
  using hnsw ((embedding::extensions.vector(1536)) extensions.vector_cosine_ops)
  where extensions.vector_dims(embedding) = 1536;

create index document_chunks_embedding_3072_hnsw_idx
  on public.document_chunks
  using hnsw ((embedding::extensions.halfvec(3072)) extensions.halfvec_cosine_ops)
  where extensions.vector_dims(embedding) = 3072;

-- match_document_chunks ------------------------------------------------------
-- Same identity as the existing 4-argument function (typmods on arguments
-- are not part of it), so this replaces it in place and keeps working for
-- the 1024-dim calls of the currently deployed code.
--
-- Dynamic SQL because the ORDER BY expression and the dimension predicate
-- must match a per-dimension partial index literally for the planner to use
-- it. Only the integer dimension is formatted into the text; every value is
-- passed via USING. The inner query picks top-k by the (possibly halfvec)
-- index distance; the outer query re-sorts by full-precision similarity,
-- which also restores exact order after a relaxed iterative index scan.
create or replace function public.match_document_chunks(
  query_embedding extensions.vector,
  match_count int,
  p_project_id uuid,
  p_embedding_model text
)
returns table (
  chunk_id uuid,
  document_id uuid,
  content text,
  chunk_index int,
  page_number int,
  chunk_position int,
  similarity float8,
  document_title text,
  document_source_type public.document_source_type,
  document_source_ref text
)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_dims int := extensions.vector_dims(query_embedding);
  v_index_type text;
begin
  if v_dims is null then
    return;
  end if;

  v_index_type := case
    when v_dims <= 2000 then format('extensions.vector(%s)', v_dims)
    when v_dims <= 4000 then format('extensions.halfvec(%s)', v_dims)
    -- Too large for any HNSW index: exact scan.
    else 'extensions.vector'
  end;

  return query execute format(
    $query$
      with candidates as materialized (
        select
          dc.id as chunk_id,
          dc.document_id,
          dc.content,
          dc.chunk_index,
          dc.page_number,
          dc.chunk_position,
          1 - (dc.embedding <=> $1) as similarity,
          d.title as document_title,
          d.source_type as document_source_type,
          d.source_ref as document_source_ref
        from public.document_chunks dc
        join public.documents d on d.id = dc.document_id
        where d.project_id = $2
          and dc.embedding is not null
          and dc.embedding_model = $3
          and extensions.vector_dims(dc.embedding) = %2$s
        order by dc.embedding::%1$s <=> $1::%1$s
        limit $4
      )
      select *
      from candidates
      order by similarity desc, chunk_id
    $query$,
    v_index_type,
    v_dims
  )
  using query_embedding, p_project_id, p_embedding_model, greatest(match_count, 0);
end;
$$;

-- With project/model filters applied after the index scan, a plain HNSW
-- scan stops after hnsw.ef_search candidates and can return fewer than
-- match_count rows. Iterative scans (pgvector >= 0.8) keep scanning until
-- enough rows pass the filters. Set conditionally: on an older pgvector the
-- parameter doesn't exist and would make every call fail.
do $$
begin
  if (
    select string_to_array(extversion, '.')::int[] >= array[0, 8, 0]
    from pg_extension
    where extname = 'vector'
  ) then
    alter function public.match_document_chunks(extensions.vector, int, uuid, text)
      set hnsw.iterative_scan = relaxed_order;
  end if;
end $$;

comment on function public.match_document_chunks(extensions.vector, int, uuid, text) is
  'Top-k cosine similarity search over one project''s chunks embedded by p_embedding_model with the same dimension as query_embedding; chunks of another model or dimension are skipped, never an error. security definer: trusts p_project_id, so the caller must verify project ownership first.';

-- Same lockdown as before: revoke by role name, EXECUTE for service_role only.
revoke all on function public.match_document_chunks(extensions.vector, int, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.match_document_chunks(extensions.vector, int, uuid, text) to service_role;

-- The 3-argument version ignores the embedding model; nothing calls it.
drop function public.match_document_chunks(extensions.vector, int, uuid);
