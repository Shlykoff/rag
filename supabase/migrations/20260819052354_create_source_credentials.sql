-- source_credentials: per-user secrets needed to talk to an external
-- document source that requires user-level auth (Notion Internal
-- Integration Secret; Google Drive Service Account JSON). Manual upload
-- and public URL need no stored credential and never get a row here.
--
-- Encryption plan (explicitly called out, not implemented here):
-- application-level encryption, done in the server-side source adapter
-- (lib/sources/) *before* the row is written, not Supabase Vault.
-- Rationale, for document-sources-specialist / qa-reviewer to confirm:
--   - Vault's secret encryption key is backed by pgsodium/KMS, and the key
--     management differs between local Docker Supabase and hosted Supabase
--     (hosted uses project-level KMS-backed keys; local uses a locally
--     generated key) -- that inconsistency makes "does decryption still
--     work after `supabase db push`" a real risk for a portfolio project
--     that must demo cleanly on hosted.
--   - Application-level encryption keeps the encryption key fully outside
--     the database (an env var / secret manager entry the app controls),
--     matching CLAUDE.md's rule that secrets never live in the DB in
--     plaintext and keeps the threat model simple: a DB dump alone is not
--     enough to recover tokens.
--   - This is a design decision, not yet implemented crypto -- the actual
--     encrypt/decrypt code belongs to document-sources-specialist. This
--     migration only guarantees the column cannot reasonably be mistaken
--     for a plaintext-friendly field (bytea ciphertext, not `token text`).
-- If this direction is not what's wanted, flag it before
-- document-sources-specialist builds against this shape.
create type public.source_credential_type as enum ('notion', 'google_drive');

create table public.source_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  source_type public.source_credential_type not null,
  -- Encrypted payload: for 'notion' this is the encrypted Internal
  -- Integration Secret string; for 'google_drive' it is the encrypted,
  -- minified Service Account JSON (client_email/private_key/project_id/
  -- token_uri/... all travel together as one blob since the app needs the
  -- whole document to build credentials).
  credential_ciphertext bytea not null,
  -- Nonce/IV for the AEAD cipher used at the application layer (e.g.
  -- AES-256-GCM). Required so the same plaintext never reuses a nonce.
  credential_nonce bytea not null,
  -- Lets the app rotate the encryption key over time without a data
  -- migration: decrypt using the key identified by this version, encrypt
  -- new writes with the current one.
  encryption_key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_credentials_one_per_user_source unique (user_id, source_type)
);

comment on table public.source_credentials is
  'Encrypted per-user secrets for sources that need user-level auth (Notion Internal Integration Secret, Google Drive Service Account JSON). Ciphertext only -- see migration header for the encryption plan that must be confirmed before use.';
comment on column public.source_credentials.credential_ciphertext is
  'Application-level ciphertext (e.g. AES-256-GCM). Never store the raw token/JSON here. Decryption key lives outside the database.';
comment on column public.source_credentials.credential_nonce is
  'AEAD nonce/IV paired with credential_ciphertext, generated fresh per write.';

create trigger set_source_credentials_updated_at
  before update on public.source_credentials
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
-- Even though decrypting requires a server-side key the client never has,
-- we still gate table access by RLS per CLAUDE.md rule 3 (explicit policy
-- on every table with user data), so a leaked anon-scoped client session
-- cannot even read another user's ciphertext/nonce. In practice the app
-- should still prefer a service_role-only path (or a narrow RPC exposing
-- just "is this source connected: true/false") over letting the client
-- read this table directly, but the deny-by-default RLS is the backstop.

alter table public.source_credentials enable row level security;

create policy "source_credentials_select_own"
  on public.source_credentials for select
  to authenticated
  using (auth.uid() = user_id);

create policy "source_credentials_insert_own"
  on public.source_credentials for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "source_credentials_update_own"
  on public.source_credentials for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "source_credentials_delete_own"
  on public.source_credentials for delete
  to authenticated
  using (auth.uid() = user_id);

-- Table-level grants: required in addition to RLS on this Supabase/PG
-- image (see the comment in the documents migration for why).
grant select, insert, update, delete on public.source_credentials to authenticated;
grant select, insert, update, delete on public.source_credentials to service_role;
