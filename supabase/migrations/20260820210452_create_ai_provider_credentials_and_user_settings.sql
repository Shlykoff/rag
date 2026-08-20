-- ai_provider_credentials / user_settings: per-user bring-your-own-key AI
-- provider credentials and the per-user active-provider selection.
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
create type public.ai_provider_type as enum ('openai', 'anthropic', 'gemini', 'voyage');

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
  'Encrypted per-user API keys for AI providers (openai/anthropic/gemini/voyage). Ciphertext only -- see migration header for the encryption plan. voyage is a full independent row, same shape as every other provider: Anthropic has no embeddings API of its own and always pairs with Voyage, but bolting a second nullable key column onto the anthropic row would make that row a different shape than the rest and duplicate the encrypt/decrypt call site. "Anthropic fully configured" is an application-level check that both an anthropic row and a voyage row exist for the user -- not enforced here (see user_settings comment on why cross-row/cross-table provider-readiness checks are deliberately app-level, not DB-level, in this project).';
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

-- user_settings: one row per user holding their currently active AI
-- provider. Only the *selection*, not the credentials themselves.
create table public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  active_ai_provider public.ai_provider_type
    constraint user_settings_active_provider_not_voyage
    check (active_ai_provider is distinct from 'voyage'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_settings is
  'Per-user application settings; today just the active AI provider for chat/embeddings. Row is created lazily (upserted) only when a user actually sets an active provider -- mirrors saveSourceCredential''s upsert(..., {onConflict: "user_id,source_type"}) pattern already used for source_credentials. Deliberately NO trigger on auth.users insert to auto-create this row: the chat path must already tolerate "no active provider configured" (that state is exactly what drives the add-a-key modal), so "row missing" and "row present with active_ai_provider = null" are not a distinction worth a trigger plus the RLS-bypass complexity a trigger on auth.users would need. A brand-new user (including a fresh Google OAuth signup) simply has no row here until they choose a provider.';
comment on column public.user_settings.active_ai_provider is
  'Which provider lib/ai/ uses for this user''s chat + embeddings calls. Can never be voyage -- enforced by the single CHECK constraint above (voyage is always a paired embeddings-only credential for anthropic, never independently selectable), deliberately not by carving voyage out of a second enum, to keep provider validation in one place. Whether this value actually has a matching row in ai_provider_credentials (and, for anthropic, that BOTH anthropic and voyage rows exist) is validated in the API route that sets it (Stage B), not by a DB constraint -- this project already prefers application-level ownership/readiness checks over exotic cross-table constraints (see source_credentials'' migration comment on the same tradeoff for a related case), since the DB would otherwise need a deferred/cross-table check that fires correctly on both credential deletion and provider-selection order.';

create trigger set_user_settings_updated_at
  before update on public.user_settings
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
alter table public.user_settings enable row level security;

create policy "user_settings_select_own"
  on public.user_settings for select
  to authenticated
  using (auth.uid() = user_id);

create policy "user_settings_insert_own"
  on public.user_settings for insert
  to authenticated
  with check (auth.uid() = user_id);

create policy "user_settings_update_own"
  on public.user_settings for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_settings_delete_own"
  on public.user_settings for delete
  to authenticated
  using (auth.uid() = user_id);

-- Table-level grants: same reasoning as ai_provider_credentials above.
grant select, insert, update, delete on public.user_settings to authenticated;
grant select, insert, update, delete on public.user_settings to service_role;
