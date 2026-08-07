-- ============================================================================
-- Migration 020 — Turnkey Solutions documents
-- ============================================================================
--
-- Run ONCE, after 019-turnkey-crm.sql.
--
-- Adds the signed-document register to the Turnkey project management system:
--
--   turnkey_documents — one row per signed document uploaded against a project
--                       (Client engagement letter, Design Sign Off contract,
--                       Handover letter, ...). A Design Sign Off contract can be
--                       signed several times (revisions / annexures), so each
--                       row also carries an optional annexure_name to tell them
--                       apart, plus a manually-entered document number and the
--                       date of signing. Client/project details are SNAPSHOT on
--                       the row, like receipts.
--
-- The uploaded files live in a private Storage bucket, 'turnkey-documents',
-- created and locked to admins below. The dashboard uploads to it; an Edge
-- Function (service_role) reads from it to email the document to the client.
--
-- Access: staff only. Every policy is gated on is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- turnkey_documents — the signed-document register
-- ---------------------------------------------------------------------------
create table if not exists turnkey_documents (
  id             uuid primary key default gen_random_uuid(),

  project_id     uuid not null references turnkey_projects(id) on delete restrict,

  -- What was signed. Free text (like receipt_name) so a new document type can
  -- be offered from the dashboard without a migration; the dashboard presents
  -- the standard three (engagement letter / design sign-off / handover).
  document_type  text not null,

  -- A Design Sign Off contract may be signed more than once. This optional name
  -- (e.g. 'Annexure A — kitchen revision') distinguishes repeat signings.
  annexure_name  text,

  -- Filled in by staff on upload; both are shown on the document view + email.
  document_number text,
  signed_date     date,

  -- The uploaded file in the 'turnkey-documents' bucket.
  storage_path   text not null,
  file_name      text,
  mime_type      text,
  file_size      bigint,

  -- Snapshot of who/what this document is for, frozen at upload time.
  client_name    text not null,
  client_phone   text,
  client_email   text,
  project_name   text,

  notes          text,
  emailed_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table turnkey_documents is
  'One row per signed document uploaded against a turnkey project. Client/project
   fields are snapshot at upload; the file lives in the turnkey-documents bucket.';

create index if not exists turnkey_documents_project_idx
  on turnkey_documents (project_id, created_at desc);


-- ---------------------------------------------------------------------------
-- updated_at trigger (touch_updated_at() already exists)
-- ---------------------------------------------------------------------------
drop trigger if exists turnkey_documents_touch on turnkey_documents;
create trigger turnkey_documents_touch
  before update on turnkey_documents
  for each row execute function touch_updated_at();


-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_documents enable row level security;

grant select, insert, update, delete on turnkey_documents to authenticated;

drop policy if exists turnkey_documents_admin_all on turnkey_documents;
create policy turnkey_documents_admin_all on turnkey_documents
  for all to authenticated
  using (is_admin()) with check (is_admin());


-- ---------------------------------------------------------------------------
-- Storage bucket for the uploaded files — private, admins only
-- ---------------------------------------------------------------------------
-- Private bucket: files are reachable only via a short-lived signed URL (the
-- dashboard mints one to preview) or the service_role (the email function).
insert into storage.buckets (id, name, public)
values ('turnkey-documents', 'turnkey-documents', false)
on conflict (id) do nothing;

-- RLS on storage.objects is on by default. Admins get full access to objects in
-- this bucket only; service_role bypasses RLS for the email function.
drop policy if exists turnkey_documents_objects_admin on storage.objects;
create policy turnkey_documents_objects_admin on storage.objects
  for all to authenticated
  using (bucket_id = 'turnkey-documents' and is_admin())
  with check (bucket_id = 'turnkey-documents' and is_admin());

commit;


-- Checks, signed in as an admin from the browser console:
--   await sb.storage.from('turnkey-documents')
--     .upload('test.txt', new Blob(['hi']))          -> { data: { path } }, no error
--   await sb.from('turnkey_documents').insert({
--          project_id: '<id>', document_type: 'Handover letter',
--          storage_path: 'test.txt', client_name: 'Test' }).select()
--     -> row comes back
--
-- As a non-admin (or logged out) the upload and the insert must both be denied.
