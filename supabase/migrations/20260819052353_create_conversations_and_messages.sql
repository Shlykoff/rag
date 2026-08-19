-- conversations: chat history container, one per thread, owned by a user.
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.conversations is
  'A chat thread. title is optional (e.g. derived from the first message) so the UI has something to show in a history list.';

create index conversations_user_id_idx on public.conversations (user_id);

create trigger set_conversations_updated_at
  before update on public.conversations
  for each row
  execute function public.set_updated_at();

alter table public.conversations enable row level security;

create policy "conversations_select_own"
  on public.conversations for select
  to authenticated
  using (auth.uid() = user_id);

create policy "conversations_insert_own"
  on public.conversations for insert
  to authenticated
  with check (auth.uid() = user_id);

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
-- gets full CRUD since the server may create/update conversations
-- (e.g. auto-titling) on the user's behalf.
grant select, insert, update, delete on public.conversations to authenticated;
grant select, insert, update, delete on public.conversations to service_role;

-- messages: individual turns within a conversation. -----------------------
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
-- messages has no user_id column of its own; ownership is derived through
-- the parent conversation, same pattern as document_chunks -> documents.

alter table public.messages enable row level security;

create policy "messages_select_own"
  on public.messages for select
  to authenticated
  using (
    exists (
      select 1
      from public.conversations c
      where c.id = messages.conversation_id
        and c.user_id = auth.uid()
    )
  );

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
-- retrieved sources) after streaming completes, and may need to
-- correct/redact rows.
grant select, insert, update, delete on public.messages to service_role;
