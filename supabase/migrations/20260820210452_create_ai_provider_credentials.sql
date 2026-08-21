-- ai_provider_credentials: per-user bring-your-own-key AI provider
-- credentials.
--
-- Mirrors source_credentials' shape and reasoning (see that migration's
-- header) -- ciphertext + nonce + key version columns, one row per
-- (user, provider), RLS deny-by-default with explicit grants (this
-- Supabase image does not auto-expose new tables to Data API roles, see
-- the grant comment in the documents migration).
--
-- Encryption plan: same as source_credentials -- application-level
-- AES-256-GCM in lib/ai/crypto.ts (a deliberate near-duplicate of
-- lib/sources/crypto.ts, not a shared module -- keeps lib/ai/ and
-- lib/sources/ domain-isolated), not Supabase Vault, for the same
-- local-vs-hosted KMS-consistency reasoning already recorded in
-- source_credentials. This migration only guarantees the column shape
-- cannot be mistaken for a plaintext-friendly field (bytea, not
-- `api_key text`). Actual encrypt/decrypt code is Stage B
-- (rag-pipeline-specialist)'s responsibility.
--
-- Credentials stay account-level (per auth.users), NOT project-scoped,
-- under the projects architecture pivot -- see the projects migration's
-- header: "connect a provider" is a user (account) action, "which
-- connected provider a given project uses" is the per-project selection
-- (projects.active_ai_provider). public.ai_provider_type -- referenced by
-- both projects.active_ai_provider and this table's `provider` column --
-- is defined in the projects migration (20260819052349), not here: it had
-- to move earlier in migration order once projects needed it before this
-- migration runs (see that file's header comment for the full reasoning).
create table public.ai_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider public.ai_provider_type not null,
  -- Encrypted API key for this provider. AES-256-GCM ciphertext produced
  -- by lib/ai/crypto.ts; the plaintext key never touches this database.
  api_key_ciphertext bytea not null,
  -- Nonce/IV for the AEAD cipher, generated fresh per write.
  api_key_nonce bytea not null,
  -- Lets the app rotate the encryption key over time without a data
  -- migration: decrypt using the key identified by this version, encrypt
  -- new writes with the current one. Same pattern as
  -- source_credentials.encryption_key_version.
  encryption_key_version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- At most one stored key per provider per user -- saving a new key for
  -- a provider is an update (upsert), not a second row.
  constraint ai_provider_credentials_one_per_user_provider unique (user_id, provider)
);

comment on table public.ai_provider_credentials is
  'Encrypted per-user API keys for AI providers (openai/anthropic/gemini/voyage). Ciphertext only -- see migration header for the encryption plan. voyage is a full independent row, same shape as every other provider: Anthropic has no embeddings API of its own and always pairs with Voyage, but bolting a second nullable key column onto the anthropic row would make that row a different shape than the rest and duplicate the encrypt/decrypt call site. "Anthropic fully configured" is an application-level check that both an anthropic row and a voyage row exist for the user -- not enforced here. Stays account-level (per user_id) even though projects (which pick a per-project active_ai_provider) are otherwise the unit of scoping everywhere else in this schema -- see this migration''s header.';
comment on column public.ai_provider_credentials.api_key_ciphertext is
  'Application-level ciphertext (AES-256-GCM). Never store the raw API key here. Decryption key lives outside the database (CREDENTIALS_ENCRYPTION_KEY-style env var, see lib/ai/crypto.ts).';
comment on column public.ai_provider_credentials.api_key_nonce is
  'AEAD nonce/IV paired with api_key_ciphertext, generated fresh per write.';

create trigger set_ai_provider_credentials_updated_at
  before update on public.ai_provider_credentials
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
alter table public.ai_provider_credentials enable row level security;

create policy "ai_provider_credentials_select_own"
  on public.ai_provider_credentials for select
  to authenticated
  using (auth.uid() = user_id);

create policy "ai_provider_credentials_insert_own"
  on public.ai_provider_credentials for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "ai_provider_credentials_update_own"
  on public.ai_provider_credentials for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "ai_provider_credentials_delete_own"
  on public.ai_provider_credentials for delete
  to authenticated
  using (auth.uid() = user_id);

-- Table-level grants: required in addition to RLS on this Supabase/PG
-- image -- without an explicit GRANT, Postgres rejects the query before
-- RLS is even evaluated (see the equivalent comment in the documents
-- migration). Applies to service_role too: BYPASSRLS skips row filtering,
-- not the base table privilege check.
grant select, insert, update, delete on public.ai_provider_credentials to authenticated;
grant select, insert, update, delete on public.ai_provider_credentials to service_role;

-- user_settings has been removed by the projects architecture pivot: its
-- one meaningful column, active_ai_provider, moved to projects
-- (per-project instead of per-user -- see that migration). This file
-- previously created both public.ai_provider_type (used by
-- user_settings.active_ai_provider) and the user_settings table itself;
-- since this schema is local-only and not yet pushed to any hosted
-- Supabase project (see CLAUDE.md), that history is edited away in place
-- rather than reversed with a separate `drop table` migration --
-- public.ai_provider_type now lives in the projects migration
-- (20260819052349), needed earlier in migration order since
-- documents.project_id's referenced table (projects) must exist before
-- this migration runs.
