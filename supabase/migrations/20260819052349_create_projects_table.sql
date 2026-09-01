-- projects: top-level scoping entity. A user can own several projects
-- ("бот1", "бот2", ...), each with its own document set, active AI
-- provider, in-app test chat, and external channel integrations
-- (Telegram etc). documents, document_chunks, conversations,
-- usage_events, and channel_integrations all reference project_id.
--
-- Ordered first among the schema migrations (ahead of pgvector/documents)
-- because documents.project_id is a NOT NULL FK to projects(id) -- the
-- referenced table must exist first. public.set_updated_at() and
-- public.ai_provider_type are also defined here rather than alongside
-- the tables that first use them, since projects needs both.

-- Shared updated_at trigger function, reused by every table below that has
-- an updated_at column. Avoids a dependency on the optional moddatetime
-- extension.
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Trigger-only function (`returns trigger`): Postgres itself refuses to
-- invoke a trigger function outside of a trigger context ("trigger functions
-- can only be called as triggers" -- there is no NEW/OLD record otherwise),
-- so even if EXECUTE were ever granted to anon/authenticated this could not
-- be called directly as an RPC with any effect. Revoked anyway, for defense
-- in depth and so this function needs no special-case reasoning the next
-- time someone audits grants in this schema -- see the fuller explanation
-- of why every object here gets an explicit revoke, below the RLS section
-- of this same migration. Revoking EXECUTE does not stop triggers from
-- firing: trigger invocation does not go through the firing statement's own
-- EXECUTE privilege check.
revoke all on function public.set_updated_at() from public, anon, authenticated, service_role;

-- Referenced by projects.active_ai_provider and (later)
-- ai_provider_credentials.provider. Includes 'voyage' as a full enum value
-- because ai_provider_credentials stores it as an independent credential
-- row alongside openai/anthropic/gemini -- see that migration's table
-- comment. projects.active_ai_provider itself can never be 'voyage'
-- (enforced below by projects_active_provider_not_voyage): Anthropic
-- always pairs with Voyage for embeddings, but Voyage is never
-- independently selectable as a project's active provider.
create type public.ai_provider_type as enum ('openai', 'anthropic', 'gemini', 'voyage');

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- Which AI provider (lib/ai/) this project's chat + embeddings use,
  -- per-project rather than per-user: a user can run one project on
  -- OpenAI and another on Gemini, each pointing at that provider's
  -- already-connected ai_provider_credentials row (which stays
  -- account-level -- connecting a provider is a user action, choosing
  -- which connected provider a given project uses is per-project).
  -- Nullable: a freshly created project has no active provider until the
  -- owner picks one.
  active_ai_provider public.ai_provider_type
    constraint projects_active_provider_not_voyage
    check (active_ai_provider is distinct from 'voyage'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.projects is
  'Top-level scoping entity: a user-owned "bot" with its own documents, active AI provider, test chat, and channel integrations. documents/conversations/usage_events/channel_integrations all reference project_id (conversations.user_id is additionally kept, nullable, for the owner''s own test-chat rows -- see that migration). Deleting a project cascades to all of the above via each table''s own FK. NOTE for the app layer, not enforced by this schema: ON DELETE CASCADE only removes DB rows -- it does NOT remove the project''s objects from the "documents" Storage bucket (everything under "<project_id>/"). A project-delete action must list()+remove() that Storage prefix itself, or objects orphan in the bucket permanently.';
comment on column public.projects.active_ai_provider is
  'Which provider lib/ai/ uses for this project''s chat + embeddings calls. Can never be voyage (projects_active_provider_not_voyage) -- voyage is always a paired embeddings-only credential for anthropic, never independently selectable. Whether a matching ai_provider_credentials row actually exists for this project''s owner (and, for anthropic, that both anthropic and voyage rows exist) is validated in application code when this is set, not by a DB constraint.';

create index projects_user_id_idx on public.projects (user_id);

create trigger set_projects_updated_at
  before update on public.projects
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
-- Deny by default: RLS enabled, explicit policy per operation. Owner-only
-- -- a project is squarely account-owned data. No external-participant
-- read/write path exists here: channel participants never get a projects
-- row, they only ever reach a project's content through the gateway/RPC
-- layer, never through a direct Supabase session.

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
-- RLS alone is not enough: Postgres checks table-level privilege before RLS
-- is even evaluated, so every table needs an explicit GRANT too. Applies to
-- service_role as well -- BYPASSRLS only skips row filtering, not the base
-- table privilege check.
--
-- Every grant below is preceded by an explicit REVOKE, naming
-- anon/authenticated/service_role directly (never `from public` alone).
-- This is not defensive boilerplate -- it fixes a real, verified gap:
--
-- Which Postgres role actually executes `CREATE TABLE`/`CREATE FUNCTION`
-- determines the DEFAULT privileges Postgres attaches to that object for
-- other roles (see `pg_default_acl`). On this project's Supabase Postgres
-- image there are two different default-ACL entries registered for the
-- `public` schema, and which one applies depends on the creating role:
--   - objects created as `postgres` (how local `supabase start`/`db reset`
--     runs migrations -- confirmed via `pg_class.relowner`/`pg_proc.proowner`
--     on this project's own tables/functions): anon/authenticated/
--     service_role automatically get TRUNCATE/REFERENCES/TRIGGER on tables
--     and nothing on functions. This is the behavior `auto_expose_new_tables`
--     in supabase/config.toml documents, and what this repo has always
--     developed and tested against locally.
--   - objects created as `supabase_admin`: anon/authenticated/service_role
--     automatically get FULL SELECT/INSERT/UPDATE/DELETE on tables and
--     EXECUTE on functions, granted directly BY ROLE NAME rather than via
--     the `public` pseudo-role -- so a later `revoke ... from public` does
--     NOT remove it, only naming the roles explicitly does.
-- "No explicit GRANT was written for anon/authenticated" is therefore not
-- the same thing as "inaccessible" -- it silently depends on which of those
-- two roles happens to create the object on a given environment, which a
-- migration file neither controls nor should have to trust. Every table in
-- this schema (and the match_document_chunks RPC -- see that migration)
-- explicitly revokes from anon/authenticated/service_role BY NAME
-- immediately before granting back exactly the intended privileges, so the
-- end state is deterministic no matter which role created the object. Do
-- not remove these REVOKE statements or "simplify" them back to relying on
-- an ungranted-by-default assumption.
revoke all on public.projects from anon, authenticated, service_role;
grant select, insert, update, delete on public.projects to authenticated;
grant select, insert, update, delete on public.projects to service_role;
