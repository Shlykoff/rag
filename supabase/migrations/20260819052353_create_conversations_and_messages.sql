-- conversations: chat history container, one per thread, scoped to a
-- project (projects architecture pivot). Two ownership shapes share this
-- one table rather than being split into two:
--   - Owner test-chat: user_id is set (the project owner, via the app's
--     own in-project chat UI), channel/external_participant_id are null.
--   - External channel session: user_id is null (external participants,
--     e.g. someone messaging a project's Telegram bot, never get an
--     auth.users row at all), channel + external_participant_id identify
--     who's on the other end of that channel.
-- Splitting these into two tables would fork the chat pipeline's
-- persistence code path by caller type, defeating the point of it being
-- one shared code path (Stage B's handleChatRequest generator) -- so a
-- CHECK constraint enforces "exactly one shape" instead.
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  -- Nullable: null for every external-channel-shaped row (see table
  -- comment). Still references auth.users for the owner test-chat shape,
  -- same as before this table was project-scoped.
  user_id uuid references auth.users (id) on delete cascade,
  -- Null for the owner's own test chat; set (alongside
  -- external_participant_id) for an external channel session, e.g.
  -- 'telegram'. Free text, not an enum: kept loosely typed on purpose so
  -- adding a new lib/channels/ adapter (Slack, ...) never needs a schema
  -- migration here -- only channel_integrations.channel (a real enum) is
  -- meaningfully constrained.
  channel text,
  -- Opaque per-channel identifier for who's on the other end -- e.g. a
  -- Telegram chat_id as text. Null for the owner's own test chat.
  external_participant_id text,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one ownership shape per row -- never both set, never both
  -- null. NULL = uuid is never true in Postgres, so this also structurally
  -- guarantees an external-shaped row (user_id null) can never satisfy an
  -- `auth.uid() = user_id` RLS check -- that's what makes "only
  -- service_role writes external-channel conversations" (see RLS below)
  -- hold at the constraint level, not just by omitting a policy.
  constraint conversations_exactly_one_owner_shape check (
    (user_id is not null and channel is null and external_participant_id is null)
    or (user_id is null and channel is not null and external_participant_id is not null)
  )
);

comment on table public.conversations is
  'A chat thread scoped to a project: either the project owner''s own in-app test chat (user_id set) or an external channel participant''s session (channel + external_participant_id set, user_id null -- e.g. someone messaging the project''s Telegram bot). See conversations_exactly_one_owner_shape. title is optional (e.g. derived from the first message) so the UI has something to show in a history list.';
comment on column public.conversations.user_id is
  'The project owner, for the owner''s own test-chat conversations only. Null for external-channel sessions -- those participants never get an auth.users row (external channel users are the project''s audience, not app users).';
comment on column public.conversations.channel is
  'Which external channel this session came from (e.g. "telegram"), null for the owner''s own test chat. Free text, not the channel_integrations.channel enum, so a new channel type never needs a migration here.';
comment on column public.conversations.external_participant_id is
  'Opaque per-channel participant id (e.g. Telegram chat_id as text), null for the owner''s own test chat. Combined with project_id + channel, this is the find-or-create key an inbound external message resolves its conversation by (see conversations_external_participant_unique).';

create index conversations_project_id_idx on public.conversations (project_id);
create index conversations_user_id_idx on public.conversations (user_id);

-- Find-or-create key for external channel sessions: one conversation per
-- (project, channel, participant), so repeat messages from the same
-- Telegram user land in the same thread instead of spawning a new one each
-- time. Partial (where channel is not null) because the owner's own
-- test-chat rows have no such natural dedup key and can legitimately have
-- many rows with channel/external_participant_id both null -- a
-- non-partial unique index would rely on NULLs being treated as distinct
-- rather than documenting the intent explicitly.
create unique index conversations_external_participant_unique
  on public.conversations (project_id, channel, external_participant_id)
  where channel is not null;

-- public.set_updated_at() is defined once, in the projects migration
-- (20260819052349), and reused here.

create trigger set_conversations_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
-- The owner can SELECT every conversation under a project they own -- both
-- their own test-chat rows AND every external session. This is
-- intentional: it's how the project owner gets visibility into what the
-- bot told external channel participants (surfaced in a
-- /projects/[projectId]/channels-style UI, Stage C). But the owner can
-- only INSERT/UPDATE/DELETE rows shaped as their own test chat
-- (auth.uid() = user_id); an external-shaped row (user_id null) can never
-- satisfy that check (see conversations_exactly_one_owner_shape comment),
-- so only service_role (the gateway/webhook path, which runs with no
-- Supabase session at all) can ever write one.

alter table public.conversations enable row level security;

create policy "conversations_select_own"
  on public.conversations for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = conversations.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "conversations_insert_own"
  on public.conversations for insert
  to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.projects p
      where p.id = conversations.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "conversations_update_own"
  on public.conversations for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "conversations_delete_own"
  on public.conversations for delete
  to authenticated
  using (auth.uid() = user_id);

-- Table-level grants: required in addition to RLS on this Supabase/PG
-- image (see the comment in the documents migration for why). service_role
-- gets full CRUD -- it's the only role that ever writes external-channel
-- conversations (find-or-create from lib/gateway/, Stage B), and may also
-- update rows on the owner's behalf (e.g. auto-titling).
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.conversations to service_role;

-- messages: individual turns within a conversation. -----------------------
-- Shape unchanged by the projects pivot -- ownership is still derived
-- entirely through the parent conversation, which is itself now
-- project-scoped and may be either owner-test-chat or external-channel
-- shaped.
create type public.message_role as enum ('user', 'assistant');

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role public.message_role not null,
  content text not null,
  -- Citations backing this message: an array of objects referencing the
  -- document_chunks/documents used to compose the answer, e.g.
  -- [{"document_id": "...", "chunk_id": "...", "title": "...", "page_number": 3}].
  -- Shape is owned by rag-pipeline-specialist/nextjs-frontend; stored as
  -- jsonb here so it can evolve without a migration. Only meaningful for
  -- assistant messages; empty array for user messages.
  sources jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.messages is
  'One row per chat turn. sources is a jsonb array of {document/chunk, citation info} used to render "based on document X" under assistant answers.';
comment on column public.messages.sources is
  'jsonb array of source citations (document_id/chunk_id/title/page or position). Empty for user messages. Schema intentionally loose, owned by the retrieval layer.';

create index messages_conversation_id_idx on public.messages (conversation_id);
create index messages_conversation_id_created_at_idx on public.messages (conversation_id, created_at);

-- Row Level Security -----------------------------------------------------
-- messages has no project_id/user_id column of its own; ownership is
-- derived through the parent conversation, same pattern as
-- document_chunks -> documents (-> projects).

alter table public.messages enable row level security;

-- Read access mirrors conversations_select_own: the project owner can read
-- every message under every conversation of a project they own, including
-- external-channel sessions -- same "visibility into what the bot told
-- people" requirement, one level down.
create policy "messages_select_own"
  on public.messages for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversations c
      join public.projects p on p.id = c.project_id
      where c.id = messages.conversation_id
        and p.user_id = auth.uid()
    )
  );

-- Insert access is deliberately narrower than select: an authenticated
-- client may only insert messages into their OWN test-chat conversations
-- (c.user_id = auth.uid(), which -- per
-- conversations_exactly_one_owner_shape -- can never match an
-- external-shaped conversation row, since that row's user_id is null).
-- Only service_role inserts messages into external-channel conversations.
create policy "messages_insert_own"
  on public.messages for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

-- No update/delete policies: chat history is append-only from the client's
-- perspective (deny by default covers both operations). The server may
-- still correct/redact rows via service_role if ever needed.

-- Table-level grants: required in addition to RLS on this Supabase/PG
-- image (see the comment in the documents migration for why).
-- authenticated: SELECT + INSERT only, matching the two policies above.
grant select, insert on public.messages to authenticated;
-- service_role: full CRUD -- the server inserts assistant messages (with
-- retrieved sources) after streaming completes, for BOTH owner test-chat
-- and external-channel conversations, and may need to correct/redact rows.
grant select, insert, update, delete on public.messages to service_role;
