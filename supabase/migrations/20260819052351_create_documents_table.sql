-- documents: one row per document ingested, regardless of source.
--
-- Source-agnostic by design: `source_type` distinguishes where the document
-- came from, `source_ref` carries whatever identifier that source needs to
-- re-sync (a Notion page URL/ID, a public URL, a Google Drive file ID), and
-- `storage_path` always points at Supabase Storage — either the original
-- upload (manual_upload) or a cached extraction of the text (notion/url/
-- google_drive) — so chunking can be redone without re-fetching from the
-- external source. See CLAUDE.md "Источники документов".
--
-- Scoped to `projects`, not directly to a user (projects architecture
-- pivot): documents belong to a project ("бот1"), and a user can own
-- several projects, each with its own document set/AI provider/chat
-- history. Ownership is still ultimately a user (projects.user_id), just
-- one join away — see the RLS policies below.

create type public.document_source_type as enum (
  'manual_upload',
  'notion',
  'url',
  'google_drive'
);

create type public.document_processing_status as enum (
  'pending',
  'processing',
  'ready',
  'error'
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  source_type public.document_source_type not null,
  -- External locator for re-sync: Notion page/db URL or ID, the public URL,
  -- or the Google Drive file ID. Null for manual_upload, where the file
  -- itself (in Storage) is the only source of truth.
  source_ref text,
  -- Path to the object in the private `documents` Storage bucket: the
  -- original file for manual_upload, or a cached plain-text extraction for
  -- notion/url/google_drive. Always prefixed with `${project_id}/...` so
  -- the Storage RLS policies can enforce ownership from the path plus a
  -- join to projects.user_id (see the storage bucket migration).
  -- Nullable: the document row can exist (processing_status = 'pending')
  -- before the object actually lands in Storage -- e.g. a Notion/URL/Drive
  -- fetch that is still in flight, or a manual_upload row created ahead of
  -- the client's upload call completing.
  storage_path text,
  -- When this document was last (re-)fetched from its external source.
  -- Null for manual_upload (nothing to re-sync) and for other sources until
  -- the first successful ingest completes.
  last_synced_at timestamptz,
  processing_status public.document_processing_status not null default 'pending',
  processing_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- manual_upload has no external ref by definition; every other source
  -- must carry one so re-sync ("Refresh") has something to fetch again.
  constraint documents_source_ref_required_unless_manual check (
    source_type = 'manual_upload' or source_ref is not null
  ),
  -- DB-level enforcement of the "<project_id>/..." Storage path convention
  -- described above (previously "<user_id>/...", rescoped by the projects
  -- pivot). Allows NULL (see storage_path comment: the row may exist
  -- before the object is uploaded); only validates the prefix once a path
  -- is set, so it can never diverge from what the storage.objects RLS
  -- policies (documents_bucket_*_own, see the storage bucket migration)
  -- expect -- both read the same "${project_id}/..." convention off the
  -- same project_id. The app layer additionally namespaces by document_id
  -- under that prefix (see lib/sources/pipeline.ts), but only the leading
  -- project_id segment is what the RLS join actually needs to be sound, so
  -- that's all this CHECK validates.
  constraint documents_storage_path_prefixed_with_project_id check (
    storage_path is null or storage_path like (project_id::text || '/%')
  ),
  -- A 'ready' document must not carry a stale error from a previous failed
  -- attempt -- otherwise the UI/API could show a document as successfully
  -- ingested while processing_error still holds old failure text.
  -- The reverse (processing_error required when status = 'error') is
  -- deliberately NOT enforced: the ingestion pipeline may set 'error' from
  -- a generic catch-all path (e.g. an unexpected exception, a timeout, a
  -- crash before a message was captured) where there is genuinely no
  -- message to record yet, and forcing a non-null placeholder string there
  -- would just trade one lie ("no error") for another ("(unknown error)").
  -- rag-pipeline-specialist should still populate processing_error
  -- whenever a message is available, but the schema does not need to
  -- force that.
  constraint documents_ready_has_no_error check (
    processing_status <> 'ready' or processing_error is null
  )
);

comment on table public.documents is
  'One row per ingested document (any source: manual upload, Notion, public URL, Google Drive), scoped to a project. Original/cached text lives in the private "documents" Storage bucket at storage_path.';
comment on column public.documents.source_ref is
  'External identifier used to re-fetch the document: Notion page/db URL or ID, the public URL, or the Google Drive file ID. Null for manual_upload.';
comment on column public.documents.storage_path is
  'Object path in the "documents" Storage bucket. Nullable until the object is actually uploaded (e.g. processing_status = pending); when set, must start with "<project_id>/" (enforced by documents_storage_path_prefixed_with_project_id) so storage.objects RLS policies can enforce per-owner access from the path (joined to projects.user_id).';
comment on column public.documents.processing_status is
  'Ingestion pipeline status (chunking + embeddings), surfaced to the UI: pending -> processing -> ready | error. A ready document is guaranteed by documents_ready_has_no_error to have processing_error = null.';

create index documents_project_id_idx on public.documents (project_id);

-- public.set_updated_at() is defined once, in the projects migration
-- (20260819052349, the earliest table that needed it) and reused here.

create trigger set_documents_updated_at
  before update on public.documents
  for each row
  execute function public.set_updated_at();

-- Row Level Security -----------------------------------------------------
-- Deny by default: RLS is enabled and every operation gets its own
-- explicit policy. Ownership is derived one join away through the parent
-- project (projects.user_id = auth.uid()) rather than a denormalized
-- user_id column on documents itself -- documents belongs to a project,
-- not directly to a user, so this is the "derive via join, don't
-- denormalize" pattern already used by document_chunks -> documents,
-- applied one level up. The server also writes to this table using the
-- service_role key (e.g. flipping processing_status), which bypasses RLS
-- by design — these policies only govern direct client access.

alter table public.documents enable row level security;

create policy "documents_select_own"
  on public.documents for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = documents.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "documents_insert_own"
  on public.documents for insert
  to authenticated
  with check (
    exists (
      select 1 from public.projects p
      where p.id = documents.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "documents_update_own"
  on public.documents for update
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = documents.project_id
        and p.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = documents.project_id
        and p.user_id = auth.uid()
    )
  );

create policy "documents_delete_own"
  on public.documents for delete
  to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = documents.project_id
        and p.user_id = auth.uid()
    )
  );

-- Table-level grants -------------------------------------------------------
-- This project's Supabase CLI/local Postgres image defaults new tables to
-- NOT being auto-exposed to the Data API roles (only TRIGGER/REFERENCES/
-- TRUNCATE are granted out of the box; see `auto_expose_new_tables` in
-- supabase/config.toml). RLS policies alone are not enough: without an
-- explicit GRANT, Postgres rejects the query before RLS is even
-- evaluated. This also applies to service_role -- BYPASSRLS lets it skip
-- row filtering, but it still needs the base table privilege.
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.documents to service_role;
