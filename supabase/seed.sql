-- ============================================================================
-- WARNING -- LOCAL-ONLY SEED DATA. DO NOT REUSE THIS PASSWORD ON HOSTED.
-- ============================================================================
-- This file creates a demo auth user with a HARDCODED, COMMITTED password
-- (demo-password-123, see below) by inserting directly into
-- auth.users/auth.identities. That is a normal, accepted pattern for local
-- Supabase dev seeding -- it is NOT acceptable for the hosted project.
--
-- Verified behaviour (Supabase CLI 2.113.0, `supabase db push --help`,
-- checked against supabase/config.toml's [db.seed] sql_paths = ["./seed.sql"]):
-- BY DEFAULT `supabase db push` (bare, no flags) pushes ONLY the contents
-- of supabase/migrations/ -- it does not execute seed.sql, so a plain
-- `supabase db push` will NOT create this demo user on hosted.
--
-- HOWEVER: `supabase db push` has an explicit `--include-seed` flag ("
-- Include seed data from your config") that DOES run this exact file
-- (per [db.seed] sql_paths) against whatever project is targeted --
-- including a linked HOSTED project. This is a real, one-flag-away risk,
-- not just a hypothetical:
--   - NEVER run `supabase db push --include-seed` against the hosted/linked
--     project. If seeding hosted is ever genuinely needed, either strip the
--     demo-auth-user block from a hosted-specific copy of this file first,
--     or (preferred) create the demo account manually on hosted with a
--     freshly generated password that is NOT committed to this repo (e.g.
--     via the Supabase dashboard or `supabase auth` admin API), and store
--     that password only in your own secrets manager / Vercel env.
--   - Do not paste this file's contents into the hosted SQL editor either,
--     for the same reason.
--   - Before any `supabase db push`, double-check the exact command being
--     run has no `--include-seed` when the target is hosted (`--linked` or
--     an explicit `--db-url` pointing at hosted).
-- ============================================================================
--
-- Demo account: demo@example.com / demo-password-123
-- Gives the demo account one project ("Demo Project") with 2 pre-ingested
-- documents so a visitor can ask a question immediately without uploading
-- anything (see docs/spec.md). Documents/chunks are project-scoped (the
-- projects architecture pivot) -- everything below hangs off
-- v_demo_project_id, not the demo user directly.
--
-- Embeddings: document_chunks.embedding is left NULL below with an
-- explicit placeholder comment. There is no AI provider key available at
-- this stage of the project (db-architect works schema-only), so a real
-- 1024-dim vector cannot be produced here. rag-pipeline-specialist is
-- expected to re-run these two documents through the real ingestion
-- pipeline (chunk + embed) once an AI_PROVIDER key is configured -- the
-- chunk rows below exist so the shape of "a document has chunks" can be
-- exercised (RLS, joins, UI) before that happens; NULL embeddings are
-- correctly excluded by match_document_chunks (`where embedding is not
-- null`), so the demo account just won't return retrieval hits until
-- re-embedded. NOTE: scripts/seed-ai-credentials.ts (which does that
-- re-embed, plus sets an active AI provider) currently targets the old
-- user_settings table for the active-provider selection -- since that
-- table is dropped by this pivot (moved to projects.active_ai_provider),
-- that script needs a matching update in Stage B to keep working; flagged
-- here so it isn't missed, not fixed in this migration-only change (script
-- code is out of db-architect's scope).

do $$
declare
  v_demo_user_id uuid := '00000000-0000-0000-0000-000000000001';
  -- Fixed (not gen_random_uuid()), same idempotency convention as
  -- v_demo_user_id above: every id below is deterministic so `on conflict
  -- (id) do nothing` makes a manual re-run of this file (outside a full
  -- `supabase db reset`) a no-op instead of creating duplicate rows.
  v_demo_project_id uuid := '00000000-0000-0000-0000-000000000002';
  v_doc_returns_id uuid := '00000000-0000-0000-0000-000000000003';
  v_doc_onboarding_id uuid := '00000000-0000-0000-0000-000000000004';
begin

  -- Demo auth user -----------------------------------------------------
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at, confirmation_token, recovery_token,
    email_change_token_new, email_change
  )
  values (
    '00000000-0000-0000-0000-000000000000',
    v_demo_user_id,
    'authenticated',
    'authenticated',
    'demo@example.com',
    crypt('demo-password-123', gen_salt('bf')),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    '{"full_name":"Demo Account"}'::jsonb,
    now(),
    now(),
    '',
    '',
    '',
    ''
  )
  on conflict (id) do nothing;

  insert into auth.identities (
    id, provider_id, user_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  )
  values (
    gen_random_uuid(),
    v_demo_user_id::text,
    v_demo_user_id,
    jsonb_build_object('sub', v_demo_user_id::text, 'email', 'demo@example.com'),
    'email',
    now(),
    now(),
    now()
  )
  on conflict (provider_id, provider) do nothing;

  -- Demo project ---------------------------------------------------------
  -- One project per demo account is enough for the seeded walkthrough;
  -- active_ai_provider is left null here for the same reason embeddings
  -- are left null below (no provider key available at this stage) --
  -- scripts/seed-ai-credentials.ts sets it once a real key is configured.
  insert into public.projects (id, user_id, name, active_ai_provider, created_at, updated_at)
  values (
    v_demo_project_id,
    v_demo_user_id,
    'Demo Project',
    null,
    now(),
    now()
  )
  on conflict (id) do nothing;

  -- Demo document 1: manual upload -------------------------------------
  insert into public.documents (
    id, project_id, title, source_type, source_ref, storage_path,
    last_synced_at, processing_status, created_at, updated_at
  )
  values (
    v_doc_returns_id,
    v_demo_project_id,
    'Return & Refund Policy.pdf',
    'manual_upload',
    null,
    v_demo_project_id::text || '/' || v_doc_returns_id::text || '/original.pdf',
    null,
    'ready',
    now(),
    now()
  )
  on conflict (id) do nothing;

  insert into public.document_chunks (
    document_id, chunk_index, content, page_number, chunk_position, embedding, embedding_provider, embedding_model
  )
  values
    (
      v_doc_returns_id, 0,
      'Customers may return any unopened item within 30 days of delivery for a full refund. Items must be in their original packaging with proof of purchase.',
      1, 0,
      null, -- placeholder: no embedding yet, will be re-ingested by rag-pipeline-specialist
      null,
      null
    ),
    (
      v_doc_returns_id, 1,
      'Refunds are issued to the original payment method within 5-7 business days after we receive the returned item. Shipping costs are non-refundable unless the return is due to our error.',
      1, 1,
      null, -- placeholder: no embedding yet, will be re-ingested by rag-pipeline-specialist
      null,
      null
    ),
    (
      v_doc_returns_id, 2,
      'Sale items and gift cards are final sale and cannot be returned or exchanged. Defective items can be exchanged for the same product at no cost within 90 days.',
      2, 2,
      null, -- placeholder: no embedding yet, will be re-ingested by rag-pipeline-specialist
      null,
      null
    )
  on conflict (document_id, chunk_index) do nothing;

  -- Demo document 2: public URL source ----------------------------------
  insert into public.documents (
    id, project_id, title, source_type, source_ref, storage_path,
    last_synced_at, processing_status, created_at, updated_at
  )
  values (
    v_doc_onboarding_id,
    v_demo_project_id,
    'Employee Onboarding Guide',
    'url',
    'https://example.com/handbook/onboarding',
    v_demo_project_id::text || '/' || v_doc_onboarding_id::text || '/content.txt',
    now(),
    'ready',
    now(),
    now()
  )
  on conflict (id) do nothing;

  insert into public.document_chunks (
    document_id, chunk_index, content, page_number, chunk_position, embedding, embedding_provider, embedding_model
  )
  values
    (
      v_doc_onboarding_id, 0,
      'Welcome to the team! On your first day, IT will provide your laptop and set up your email and Slack accounts. HR will schedule a 30-minute orientation call to walk through benefits enrollment.',
      null, 0,
      null, -- placeholder: no embedding yet, will be re-ingested by rag-pipeline-specialist
      null,
      null
    ),
    (
      v_doc_onboarding_id, 1,
      'All new hires complete a mandatory security training within the first week, covering password policy, phishing awareness, and data handling. This is tracked in the LMS and required before repository access is granted.',
      null, 1,
      null, -- placeholder: no embedding yet, will be re-ingested by rag-pipeline-specialist
      null,
      null
    )
  on conflict (document_id, chunk_index) do nothing;

end $$;
