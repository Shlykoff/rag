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
-- "<user_id>/<...>", e.g. "3fa2.../my-file.pdf" or
-- "3fa2.../notion-page-abc123.txt". This lets the RLS policies below
-- authorize purely from the object path (storage.foldername(name))
-- without needing a separate ownership table for Storage objects.
--
-- Row Level Security -------------------------------------------------------
-- storage.objects already has RLS enabled by default on Supabase; we only
-- add explicit, bucket-scoped, per-operation policies here (deny by
-- default otherwise). Mirrors the documents table policies: a user can
-- read/write/delete only objects whose path is prefixed with their own
-- user id.

create policy "documents_bucket_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "documents_bucket_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "documents_bucket_update_own"
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "documents_bucket_delete_own"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
