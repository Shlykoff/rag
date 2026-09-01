-- channel_integrations: per-project external chat-channel configuration
-- (Telegram first; Slack/others later, one new channel_type value each).
-- Owned by a project, not a user directly -- a project's bot is reachable
-- through whichever channels its owner has connected for it.
--
-- Encrypted credentials mirror ai_provider_credentials'/source_credentials'
-- exact column shape (ciphertext + nonce + key version) -- same
-- application-level AES-256-GCM plan, via a domain-isolated
-- lib/channels/telegram/crypto.ts, same CREDENTIALS_ENCRYPTION_KEY env
-- var, same local-vs-hosted-KMS reasoning already recorded on
-- source_credentials/ai_provider_credentials. This migration only
-- guarantees the column shape cannot be mistaken for a plaintext-friendly
-- field (bytea, not `bot_token text`).
create type public.channel_type as enum ('telegram');

create table public.channel_integrations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  channel public.channel_type not null,
  -- Encrypted channel credential (e.g. the Telegram Bot API token).
  -- AES-256-GCM ciphertext produced by lib/channels/telegram/crypto.ts;
  -- the plaintext token never touches this database.
  credential_ciphertext bytea not null,
  -- Nonce/IV for the AEAD cipher, generated fresh per write.
  credential_nonce bytea not null,
  -- Lets the app rotate the encryption key over time without a data
  -- migration: decrypt using the key identified by this version, encrypt
  -- new writes with the current one. Same pattern as
  -- ai_provider_credentials.encryption_key_version /
  -- source_credentials.encryption_key_version.
  encryption_key_version integer not null default 1,
  -- Human-readable label for the config UI (e.g. a bot username), never
  -- used for auth/matching -- purely cosmetic.
  display_label text,
  -- Lets the owner pause a channel without deleting/re-creating its
  -- config (and losing the encrypted credential + processed-update
  -- history tied to it via channel_processed_updates.integration_id).
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One config per (project, channel) -- connecting a second Telegram bot
  -- to the same project is a credential *update* on the existing row, not
  -- a second row (mirrors ai_provider_credentials_one_per_user_provider).
  constraint channel_integrations_one_per_project_channel unique (project_id, channel)
);

comment on table public.channel_integrations is
  'Per-project external chat-channel configuration (Telegram first). Ciphertext only -- see migration header for the encryption plan. The webhook path that actually receives inbound messages for a channel always reads this table via a service_role client with no Supabase session at all -- RLS below protects the project owner''s config UI, not the webhook, which is why grants below include full service_role CRUD alongside owner CRUD.';
comment on column public.channel_integrations.credential_ciphertext is
  'Application-level ciphertext (AES-256-GCM) of the channel credential (e.g. Telegram Bot API token). Never store the raw token here. Decryption key lives outside the database.';
comment on column public.channel_integrations.credential_nonce is
  'AEAD nonce/IV paired with credential_ciphertext, generated fresh per write.';

create index channel_integrations_project_id_idx on public.channel_integrations (project_id);

-- public.set_updated_at() is defined once, in the projects migration
-- (20260819052349), and reused here.

create trigger set_channel_integrations_updated_at
  before update on public.channel_integrations
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
-- Owner full CRUD via a join to projects.user_id, same "derive via join,
-- don't denormalize" pattern documents/document_chunks already use. This
-- protects the config UI only: the webhook path itself has no Supabase
-- session and always reads/writes this table via service_role -- the real
-- trust boundary for inbound webhooks is a per-integration secret token,
-- not RLS. RLS here is still enabled and explicit per CLAUDE.md rule 3
-- (deny by default on every table with user data), it just isn't what's
-- standing between an attacker and the webhook.

alter table public.channel_integrations enable row level security;

create policy "channel_integrations_select_own"
  on public.channel_integrations for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = channel_integrations.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "channel_integrations_insert_own"
  on public.channel_integrations for insert
  to authenticated
  with check (
    exists (
      select 1 from public.projects p
      where p.id = channel_integrations.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "channel_integrations_update_own"
  on public.channel_integrations for update
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = channel_integrations.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = channel_integrations.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "channel_integrations_delete_own"
  on public.channel_integrations for delete
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = channel_integrations.project_id
        and p.user_id = auth.uid()
    )
  );

-- Table-level grants: required in addition to RLS (see the projects
-- migration, 20260819052349, "Table-level grants" section, for the full
-- explanation of why an explicit REVOKE naming roles directly must precede
-- these GRANTs -- especially important here given this table holds
-- encrypted channel credentials). service_role gets full CRUD -- the
-- webhook route looks up the integration by id and may update it (e.g.
-- disabling on repeated auth failures from the channel platform).
revoke all on public.channel_integrations from anon, authenticated, service_role;
grant select, insert, update, delete on public.channel_integrations to authenticated;
grant select, insert, update, delete on public.channel_integrations to service_role;
