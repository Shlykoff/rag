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
-- lib/sources/pipeline.ts). Rescoped from "<user_id>/..." to
-- "<project_id>/..." by the projects architecture pivot -- documents now
-- belong to a project, not directly to a user, so Storage ownership has to
-- be checked by joining the leading path segment (a project id) back to
-- projects.user_id, rather than comparing it to auth.uid() directly. This
-- lets the RLS policies below authorize purely from the object path
-- (storage.foldername(objects.name)) plus one join, without needing a
-- separate ownership table for Storage objects.
--
-- Row Level Security -------------------------------------------------------
-- storage.objects already has RLS enabled by default on Supabase; we only
-- add explicit, bucket-scoped, per-operation policies here (deny by
-- default otherwise). Mirrors the documents table policies: a user can
-- read/write/delete only objects whose path's leading project_id segment
-- belongs to a project they own.
--
-- `storage.foldername(objects.name)` below is deliberately qualified as
-- `objects.name`, NOT the bare `name` the pre-pivot version of this file
-- used: `public.projects` has its own `name` column (the project's display
-- name), and inside the `exists (select ... from public.projects p ...)`
-- subquery, an unqualified `name` resolves to the closer/inner `p.name`
-- (silently -- no ambiguity error) instead of the outer `storage.objects`
-- row actually being checked, which breaks every policy below into either
-- always-false (select/update/delete: no project happens to have a `name`
-- matching a path's first segment) or always-false likewise for insert.
-- Verified live: this exact shadowing broke `documents_bucket_insert_own`
-- (owner uploads to their own path rejected) until this qualification was
-- added -- see supabase/__tests__/projects-pivot-rls.integration.test.ts.



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
