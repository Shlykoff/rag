-- match_document_chunks: top-k cosine-similarity search over
-- document_chunks, scoped to a single project.
--
-- Implemented as security definer, NOT security invoker, because the
-- retrieval call is made server-side with the service_role client (so it
-- can search across the embedding column efficiently without per-row RLS
-- overhead) -- but that means Postgres RLS is not what's protecting
-- ownership here. The function therefore takes an explicit `p_project_id`
-- and filters on it itself (`d.project_id = p_project_id`) rather than
-- relying on the caller's RLS context.
--
-- Because of that explicit-parameter design, EXECUTE is granted ONLY to
-- service_role below (see the grant statement), not to `authenticated`.
-- If this were callable by a logged-in client directly, that client could
-- pass an arbitrary p_project_id and read another project's (or another
-- user's) chunks -- security definer bypasses RLS, so nothing else would
-- stop it. rag-pipeline-specialist must call this from a server route/
-- action using the service_role client, with p_project_id independently
-- verified by the caller before ever reaching this RPC -- never taken
-- from a client-supplied request body/query parameter as-is:
--   - web test-chat: verified via the RLS-scoped session client
--     (projects.user_id = auth.uid()), 404 not 403 on mismatch.
--   - gateway/channels path (Stage B): verified via the
--     channel_integrations row that received the inbound webhook --
--     project_id never comes from anything in the inbound platform
--     payload itself.
create function public.match_document_chunks(
  query_embedding extensions.vector(1024),
  match_count int,
  p_project_id uuid
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
    -- pgvector's <=> is cosine *distance* (0 = identical, 2 = opposite);
    -- convert to a similarity score in (roughly) [-1, 1], higher = closer,
    -- which is the more intuitive shape for callers/UI ("0.92 match").
    1 - (dc.embedding <=> query_embedding) as similarity,
    d.title as document_title,
    d.source_type as document_source_type,
    d.source_ref as document_source_ref
  from public.document_chunks dc
  join public.documents d on d.id = dc.document_id
  where d.project_id = p_project_id
    and dc.embedding is not null
  order by dc.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;

comment on function public.match_document_chunks(extensions.vector, int, uuid) is
  'Top-k cosine similarity search over document_chunks for a single project. security definer: enforces scoping itself via p_project_id (do not trust a client-supplied value; the caller must independently verify project ownership before calling), used by the RAG retrieval step server-side.';

-- security definer functions are not covered by the invoker's RLS, and by
-- default Postgres grants EXECUTE on new functions broadly -- lock this
-- down explicitly: only service_role (i.e. the server, per CLAUDE.md rule
-- 2) may call it. Neither anon nor authenticated get EXECUTE, precisely
-- because p_project_id is trusted input and this function does not derive
-- it from the caller's own JWT (auth.uid()) -- granting it to authenticated
-- would let any logged-in client pass someone else's project id and read
-- their chunks.
revoke all on function public.match_document_chunks(extensions.vector, int, uuid) from public;
grant execute on function public.match_document_chunks(extensions.vector, int, uuid) to service_role;
