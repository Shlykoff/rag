-- 1. conversations_update_own only checked auth.uid() = user_id, so an owner
--    could UPDATE their own test-chat conversation's project_id to someone
--    else's project and have it show up in that project's chat history.
--    WITH CHECK now also requires the (new) project to be owned by the caller.
drop policy if exists "conversations_update_own" on public.conversations;

create policy "conversations_update_own"
  on public.conversations for update
  to authenticated
  using (auth.uid() = user_id)
  with check (
    auth.uid() = user_id
    and exists (
      select 1 from public.projects p
      where p.id = conversations.project_id
        and p.user_id = auth.uid()
    )
  );

-- 2. conversations.updated_at only changed when the conversation row itself
--    was updated, which never happens on a normal chat turn -- so history
--    lists ordered by updated_at were really ordered by creation time.
--    Bump it on every new message.
create function public.touch_conversation_on_message()
returns trigger
language plpgsql
as $$
begin
  update public.conversations set updated_at = now() where id = new.conversation_id;
  return new;
end;
$$;

revoke all on function public.touch_conversation_on_message() from public, anon, authenticated, service_role;

create trigger touch_conversation_on_message
  after insert on public.messages
  for each row
  execute function public.touch_conversation_on_message();

-- Backfill existing rows to their latest message time. set_updated_at would
-- otherwise overwrite the value with now(), so it's disabled for this one
-- statement.
alter table public.conversations disable trigger set_conversations_updated_at;

update public.conversations c
set updated_at = m.last_message_at
from (
  select conversation_id, max(created_at) as last_message_at
  from public.messages
  group by conversation_id
) m
where m.conversation_id = c.id
  and m.last_message_at > c.updated_at;

alter table public.conversations enable trigger set_conversations_updated_at;
