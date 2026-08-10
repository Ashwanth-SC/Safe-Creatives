-- ============================================================================
-- Migration 021 — Quotation project setup (margin/GST/discount + spaces)
-- ============================================================================
--
-- Run ONCE, after 020-turnkey-documents.sql.
--
-- The first step of the quotation builder: per-project settings.
--
--   * Margin, GST and discount are properties of the PROJECT (they sit next to
--     the client name / address on turnkey_projects), so they're added as
--     columns there.
--
--   * The applicable SPACES for a project are a separate base table
--     (turnkey_project_spaces) — each project keeps its own tickable list
--     (Living Area, Dining Area, ...), independent of everything else.
--
-- All percentages are stored as entered (e.g. 25 means 25%, 18 means 18%).
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Project-level quotation settings
-- ---------------------------------------------------------------------------
alter table turnkey_projects
  add column if not exists margin_percent   numeric
    check (margin_percent is null or margin_percent >= 0),
  add column if not exists gst_percent      numeric
    check (gst_percent is null or gst_percent >= 0),
  add column if not exists discount_percent numeric
    check (discount_percent is null or discount_percent >= 0);

comment on column turnkey_projects.margin_percent is
  'Quotation margin for this project, as a percentage (25 = 25%).';

-- ---------------------------------------------------------------------------
-- turnkey_project_spaces — the tickable list of spaces per project
-- ---------------------------------------------------------------------------
create table if not exists turnkey_project_spaces (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references turnkey_projects(id) on delete cascade,
  name         text not null,
  is_selected  boolean not null default false,   -- ticked = applies to this project
  created_at   timestamptz not null default now(),
  unique (project_id, name)
);

comment on table turnkey_project_spaces is
  'The spaces available/selected for a project''s quotation. One row per space
   per project; is_selected marks the ones that apply. Managed from the
   Quotations tab (tick / add / delete).';

create index if not exists turnkey_project_spaces_project_idx
  on turnkey_project_spaces (project_id, created_at);

alter table turnkey_project_spaces enable row level security;
grant select, insert, update, delete on turnkey_project_spaces to authenticated;

drop policy if exists turnkey_project_spaces_admin_all on turnkey_project_spaces;
create policy turnkey_project_spaces_admin_all on turnkey_project_spaces
  for all to authenticated
  using (is_admin()) with check (is_admin());

commit;
