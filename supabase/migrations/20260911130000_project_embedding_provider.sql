-- Decouples a project's embedding model from its chat model.
--
-- Vectors from different embedding models live in different spaces and
-- can't be compared, even at the same dimensionality. Until now a project's
-- single active_ai_provider drove both chat and embeddings, so switching the
-- chat model silently made every stored vector incomparable with new
-- questions. Now:
--   - projects.active_ai_provider = the chat model, switchable at any time;
--   - projects.embedding_provider = the embedding model (openai | gemini |
--     voyage, all pinned to 1024 dims), chosen once and fixed once the
--     project has documents (enforced in lib/ai/credentials.ts).
alter table public.projects
  add column embedding_provider public.ai_provider_type
    constraint projects_embedding_provider_not_anthropic
    check (embedding_provider is distinct from 'anthropic');

comment on column public.projects.embedding_provider is
  'Which provider embeds this project''s documents and questions (openai | gemini | voyage -- Anthropic has no embeddings API). Independent of active_ai_provider (the chat model). Can only change while the project has no documents; enforced in application code.';

-- Existing projects keep the embedding model they were implicitly using
-- (anthropic always paired with voyage).
update public.projects
set embedding_provider = case active_ai_provider
  when 'anthropic' then 'voyage'::public.ai_provider_type
  else active_ai_provider
end
where active_ai_provider is not null
  and embedding_provider is null;

-- Retrieval now only compares against chunks embedded by the same model as
-- the question. Added as an overload next to the 3-argument version so the
-- deployment that is live while this migration runs keeps working; the old
-- version can be dropped in a later migration.
create function public.match_document_chunks(
  query_embedding extensions.vector(1024),
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
language sql
stable
security definer
set search_path = public, extensions
as $$
  select
    dc.id as chunk_id,
    dc.document_id,
    dc.content,
    dc.chunk_index,
    dc.page_number,
    dc.chunk_position,
    1 - (dc.embedding <=> query_embedding) as similarity,
    d.title as document_title,
    d.source_type as document_source_type,
    d.source_ref as document_source_ref
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where d.project_id = p_project_id
    and dc.embedding is not null
    and dc.embedding_model = p_embedding_model
  order by dc.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;

comment on function public.match_document_chunks(extensions.vector, int, uuid, text) is
  'Top-k cosine similarity search over one project''s chunks that were embedded by p_embedding_model. security definer: trusts p_project_id, so the caller must verify project ownership first (same contract as the 3-argument version).';

-- Same lockdown as the 3-argument version (see its migration): revoke by
-- role name, not just from public, then grant EXECUTE to service_role only.
revoke all on function public.match_document_chunks(extensions.vector, int, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.match_document_chunks(extensions.vector, int, uuid, text) to service_role;
