-- projects: the top-level scoping entity introduced by the "projects +
-- isolated chat-integrations" architecture pivot. A user can own several
-- projects ("бот1", "бот2", ...), each with its own document set, its own
-- active AI provider, its own in-app test chat, and its own external
-- channel integrations (Telegram etc). Documents/conversations/usage/
-- channel config all get rescoped to project_id instead of the old flat
-- per-user model -- see the documents, document_chunks, conversations,
-- usage_events, and channel_* migrations.
--
-- This migration is deliberately numbered to run BEFORE
-- 20260819052350_enable_pgvector.sql / 20260819052351_create_documents_table.sql
-- (rather than where "projects" conceptually sits, chronologically after
-- ai_provider_credentials) because documents.project_id is a NOT NULL
-- foreign key to projects(id): the referenced table must exist by the time
-- that constraint is created. This project is local-only and not yet
-- pushed to a hosted Supabase project, so per CLAUDE.md this is a clean
-- in-place rewrite of the existing migration files rather than a new
-- ALTER-based migration layered on top -- and the documents migration's
-- position in the file sequence is fixed (it's edited in place, not
-- moved), which is what pins this file's timestamp this early.
--
-- Two things that therefore also had to move to this earliest point, ahead
-- of where they used to be defined:
--   - public.set_updated_at(): previously defined inline in the documents
--     migration ("defined once here, reused by every table below").
--     projects is now the first table with an updated_at column, so the
--     function moves here; documents (and every later table) just reuses
--     it via `execute function public.set_updated_at()`, same as before.
--   - public.ai_provider_type: previously defined in
--     20260820210452 (the ai_provider_credentials migration, née
--     "..._and_user_settings"). projects.active_ai_provider needs the type
--     to exist earlier than that migration runs, so its `create type`
--     statement moves here; that later migration now just reuses the type
--     for ai_provider_credentials.provider without redefining it.

-- Shared updated_at trigger function, defined once here (the earliest
-- table that needs it) and reused by every other table in later
-- migrations that has an updated_at column. Avoids taking a dependency on
-- the optional moddatetime extension.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Moved here from the ai_provider_credentials migration (see header
-- comment above) so projects.active_ai_provider can reference it. 'voyage'
-- stays part of this one enum (not split into a separate type) because
-- ai_provider_credentials still stores it as a full independent credential
-- row alongside openai/anthropic/gemini -- see that migration's own table
-- comment for why. projects.active_ai_provider itself can never actually
-- be 'voyage' (enforced below by projects_active_provider_not_voyage):
-- Anthropic always pairs with Voyage for embeddings, but Voyage is never
-- independently selectable as "the" active provider for a project.
create type public.ai_provider_type as enum ('openai', 'anthropic', 'gemini', 'voyage');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Which AI provider (lib/ai/) this project's chat + embeddings use.
  -- Per-project now, not per-user (this replaces the old
  -- user_settings.active_ai_provider column -- that table is dropped
  -- entirely by this pivot, see the ai_provider_credentials migration's
  -- closing comment): a user can run one project on OpenAI and another on
  -- Gemini, each pointing at that provider's already-connected
  -- ai_provider_credentials row (which stays account-level -- "connect a
  -- provider" is a user action; "which connected provider a given project
  -- uses" is this per-project selection). Nullable: a freshly created
  -- project has no active provider until the owner picks one.
  active_ai_provider public.ai_provider_type
    constraint projects_active_provider_not_voyage
    check (active_ai_provider is distinct from 'voyage'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.projects is
  'Top-level scoping entity: a user-owned "bot" with its own documents, active AI provider, test chat, and channel integrations. documents/conversations/usage_events/channel_integrations all reference project_id (conversations.user_id is additionally kept, nullable, for the owner''s own test-chat rows -- see that migration). Deleting a project cascades to all of the above via each table''s own FK. NOTE for the app layer, not enforced by this schema: ON DELETE CASCADE only removes DB rows -- it does NOT remove the project''s objects from the "documents" Storage bucket (everything under "<project_id>/"). A project-delete action must list()+remove() that Storage prefix itself, or objects orphan in the bucket permanently (mirrors the per-document delete route''s existing manual Storage cleanup, just one level up).';
comment on column public.projects.active_ai_provider is
  'Which provider lib/ai/ uses for this project''s chat + embeddings calls. Can never be voyage (projects_active_provider_not_voyage) -- voyage is always a paired embeddings-only credential for anthropic, never independently selectable. Whether a matching ai_provider_credentials row actually exists for this project''s owner (and, for anthropic, that BOTH anthropic and voyage rows exist) is validated in application code when this is set, not by a DB constraint -- same app-level-over-cross-table-constraint tradeoff this project already made for the old user_settings.active_ai_provider.';

create index projects_user_id_idx on public.projects (user_id);

create trigger set_projects_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
-- Deny by default: RLS enabled, explicit policy per operation. Owner-only,
-- same shape as ai_provider_credentials -- a project is squarely
-- account-owned data. No external-participant read/write path exists for
-- this table at all: channel participants never get a projects row, they
-- only ever reach a project's content through the gateway/RPC layer
-- (Stage B), never through a direct Supabase session.

alter table public.projects enable row level security;

create policy "projects_select_own"
  on public.projects for select
  to authenticated
  using (auth.uid() = user_id);

create policy "projects_insert_own"
  on public.projects for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "projects_update_own"
  on public.projects for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "projects_delete_own"
  on public.projects for delete
  to authenticated
  using (auth.uid() = user_id);

-- Table-level grants -------------------------------------------------------
-- This project's Supabase CLI/local Postgres image defaults new tables to
-- NOT being auto-exposed to the Data API roles -- RLS alone is not enough,
-- an explicit GRANT is required too (Postgres checks table privilege
-- before RLS is even evaluated). Applies to service_role as well:
-- BYPASSRLS only skips row filtering, not the base table privilege check.
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.projects to service_role;
