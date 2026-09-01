-- channel_processed_updates: durable dedup log for inbound webhook
-- update_ids (e.g. Telegram's `update_id`). An in-memory set is NOT
-- sufficient here -- a channel platform's own retry window can outlast a
-- single serverless invocation, so "have I seen this update_id before"
-- has to survive across invocations/instances, which means it has to live
-- in the database, not process memory.
--
-- Claimed via `insert ... on conflict (integration_id, update_id) do
-- nothing` before processing starts -- the composite primary key itself
-- is what makes two concurrent retries of the same update_id race-safe
-- without an extra advisory lock: at most one of two concurrent inserts
-- for the same key can win, and the loser's "0 rows inserted" result is
-- exactly the "already processed/processing, skip" signal.
create table public.channel_processed_updates (
  integration_id uuid not null references public.channel_integrations (id) on delete cascade,
  update_id bigint not null,
  processed_at timestamptz not null default now(),
  primary key (integration_id, update_id)
);

comment on table public.channel_processed_updates is
  'Durable claim/dedup log of inbound webhook update_ids per channel_integrations row, so a channel platform''s delivery retries never produce a duplicate reply. No authenticated/anon grant exists at all, and both are explicitly REVOKEd by name before the service_role grant below is issued -- this table has no legitimate client-side use, it exists purely for the service-role webhook path''s own idempotency.';
comment on column public.channel_processed_updates.update_id is
  'The channel platform''s own update identifier (e.g. Telegram''s update_id). bigint, not uuid/text, since Telegram''s update_id is a plain incrementing integer, not a string/UUID -- keeping its native type avoids a lossy/ambiguous text comparison.';

-- Row Level Security -----------------------------------------------------
-- No authenticated/anon policies exist at all (see grants below: neither
-- role gets any table privilege, so the query is rejected before RLS
-- would even be evaluated for them). RLS is still enabled here per
-- CLAUDE.md rule 3's deny-by-default stance, as defense in depth: if a
-- grant to authenticated/anon were ever mistakenly added later, the
-- absence of any policy here means that mistake would still deny all
-- access by default rather than silently exposing this table.

alter table public.channel_processed_updates enable row level security;

-- Table-level grants -------------------------------------------------------
-- service_role only -- deliberately no grant to authenticated or anon at
-- all. Only SELECT + INSERT: this is an append-only claim log (same
-- reasoning as usage_events -- see that migration's grant comment), and
-- not granting UPDATE/DELETE to anyone removes any accidental code path
-- that could un-claim an update_id and let a duplicate reply through.
--
-- The REVOKE below is not optional boilerplate for this table in
-- particular: "no grant statement was ever written for anon/authenticated"
-- does NOT by itself guarantee they have no access -- see the projects
-- migration (20260819052349, "Table-level grants" section) for the
-- verified mechanism (default privileges depend on which role creates the
-- table). This table has zero legitimate client-side use, so closing that
-- gap explicitly here matters more than almost anywhere else in this
-- schema.
revoke all on public.channel_processed_updates from anon, authenticated, service_role;
grant select, insert on public.channel_processed_updates to service_role;
