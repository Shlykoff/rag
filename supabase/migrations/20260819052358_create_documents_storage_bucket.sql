-- Private Storage bucket for document originals/cached text, created via
-- migration (not clicked together in Studio) so the same bucket + policies
-- apply identically on the hosted project via `supabase db push`.
-- Note: not adding a `comment on table storage.buckets` here -- that
-- table is owned by the supabase_storage_admin role, and migrations run
-- as `postgres`, which lacks privileges to COMMENT ON someone else's
-- table (fails identically on hosted Supabase).
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

-- Convention: every object in this bucket is stored at
-- "<project_id>/<document_id>/<suffix>", e.g.
-- "3fa2.../c91b.../original.pdf" or "3fa2.../c91b.../content.txt" (see
-- lib/sources/pipeline.ts). Storage ownership is checked by joining the
-- leading path segment (a project id) back to projects.user_id, rather
-- than comparing it to auth.uid() directly -- this lets the RLS policies
-- below authorize purely from the object path
-- (storage.foldername(objects.name)) plus one join, without a separate
-- ownership table for Storage objects.
--
-- Row Level Security -------------------------------------------------------
-- storage.objects already has RLS enabled by default on Supabase; we only
-- add explicit, bucket-scoped, per-operation policies here (deny by
-- default otherwise). Mirrors the documents table policies: a user can
-- read/write/delete only objects whose path's leading project_id segment
-- belongs to a project they own.
--
-- `storage.foldername(objects.name)` below is deliberately qualified as
-- `objects.name`, not bare `name`: `public.projects` has its own `name`
-- column (the project's display name), so inside the
-- `exists (select ... from public.projects p ...)` subquery, an
-- unqualified `name` would silently resolve to the inner `p.name` instead
-- of the outer `storage.objects` row -- breaking every policy below into
-- always-false.

create policy "documents_bucket_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );

create policy "documents_bucket_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );

create policy "documents_bucket_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'documents'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );

create policy "documents_bucket_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and exists (
      select 1 from public.projects p
      where p.id::text = (storage.foldername(objects.name))[1]
        and p.user_id = auth.uid()
    )
  );
