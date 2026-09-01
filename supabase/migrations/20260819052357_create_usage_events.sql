-- usage_events: append-only log of billable AI calls, used by
-- rag-pipeline-specialist for per-user rate limiting ("N requests/minute")
-- and cost tracking.
--
-- Atomicity note: this is deliberately an event log, not a running counter
-- column that gets `UPDATE ... SET count = count + 1`. A shared counter
-- updated by concurrent requests needs explicit locking (or
-- `ON CONFLICT ... DO UPDATE`) to avoid lost updates; an append-only log
-- has no such race by construction -- each request is its own INSERT, and
-- "how many requests in the last minute" is a COUNT(*) range query over
-- created_at. The index below is what keeps that query fast.
create type public.usage_event_type as enum ('chat_request', 'embedding_request');

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Which project this call was made for/through (the owner's own test
  -- chat, or an external channel session -- either way, billed against
  -- the project owner's user_id above; external participants have no
  -- account of their own to bill). Lets rate limiting/cost tracking be
  -- scoped per-project (lib/rate-limit/'s "layer 1" budget), not just
  -- per-account.
  project_id uuid not null references public.projects (id) on delete cascade,
  event_type public.usage_event_type not null,
  provider text not null,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  -- Total is stored explicitly (not just prompt+completion) because
  -- embedding_request events only ever populate one side (input token
  -- count), and providers report token usage under different labels.
  total_tokens integer,
  created_at timestamptz not null default now()
);

comment on table public.usage_events is
  'Append-only log of AI provider calls per user/project, for rate limiting (count rows in a trailing time window) and cost/token accounting. Written server-side only, after/around each provider call. user_id stays the project owner (for account-level rollups across a user''s multiple projects); project_id scopes the per-project rate-limit budget shared by that project''s owner test chat and all its external channel sessions.';
comment on column public.usage_events.total_tokens is
  'Total tokens billed for this event (prompt+completion for chat, input tokens for embeddings). Nullable to tolerate providers/errors where usage was not reported.';
comment on column public.usage_events.project_id is
  'The project this AI call was made for. Every insert happens inside handleChatRequest/the ingestion pipeline, which always has a project_id in scope under the projects-scoped contract -- never nullable.';

-- Supports "count this user's events in the last N minutes" (rate limit
-- check) as an index-only range scan: user_id equality + created_at range.
create index usage_events_user_id_created_at_idx
  on public.usage_events (user_id, created_at desc);
-- Same shape, keyed by project_id -- supports the per-project rate-limit
-- budget query ("how many requests has this project made in the last N
-- minutes", across owner test-chat + all external channel sessions of
-- that project combined).
create index usage_events_project_id_created_at_idx
  on public.usage_events (project_id, created_at desc);

-- Row Level Security -----------------------------------------------------
-- This table backs a security control (rate limiting), so client writes
-- must not be possible at all -- an authenticated user who could insert or
-- delete their own usage_events rows could fabricate a clean history and
-- bypass the limiter. Only the server (service_role, bypasses RLS) writes
-- here. Authenticated users get read-only access to their own rows (e.g.
-- for a "your usage" panel); no insert/update/delete policy exists for
-- them, so those operations are denied by default.

alter table public.usage_events enable row level security;

create policy "usage_events_select_own"
  on public.usage_events for select
  to authenticated
  using (auth.uid() = user_id);

-- Table-level grants: required in addition to RLS (see the projects
-- migration, 20260819052349, "Table-level grants" section, for the full
-- explanation of why an explicit REVOKE naming roles directly must precede
-- these GRANTs).
revoke all on public.usage_events from anon, authenticated, service_role;
-- authenticated: SELECT only, matching the single read-only policy above.
grant select on public.usage_events to authenticated;
-- service_role: SELECT + INSERT to record events; no UPDATE/DELETE
-- granted at all (not even for service_role) -- this is an append-only
-- log by design (see the atomicity note at the top of this file), and not
-- granting UPDATE/DELETE to anyone removes any accidental code path that
-- could mutate/erase rate-limit history.
grant select, insert on public.usage_events to service_role;
