-- ============================================================================
-- Migration 051 — Turnkey consultation (per-project consultation document)
-- ============================================================================
--
-- Run ONCE, after 050.
--
-- A consultation is prepared per project from the dashboard's new Consultation
-- tab and exported as a single PDF emailed to the client. One row per project
-- (upserted on project_id). It stores:
--   * quotation_rows — the tentative quotation table
--       [{ space, unit, spec, cost }]  (cost is approx, excl. GST, in rupees)
--   * timeline_rows  — the tentative timeline table
--       [{ task, start_date }]  (start_date is 'YYYY-MM-DD')
--   * gallery_ids    — which turnkey_gallery items to show in the doc (ordered)
--   * moodboard      — ordered storage paths in the public turnkey-consultation
--                      bucket (up to 4 images)
--
-- The scope-of-work / design pillars / T&Cs content is fixed copy rendered by
-- the client, so it is not stored here.
--
-- Admin-only (the whole thing is internal). Moodboard images live in a PUBLIC
-- 'turnkey-consultation' Storage bucket (admin-write, public-read) so the
-- generated PDF can load them by URL.
-- ============================================================================

begin;

create table if not exists turnkey_consultations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null unique references turnkey_projects (id) on delete cascade,
  quotation_rows jsonb not null default '[]'::jsonb,
  timeline_rows  jsonb not null default '[]'::jsonb,
  gallery_ids    jsonb not null default '[]'::jsonb,
  moodboard      jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table turnkey_consultations is
  'Per-project consultation document (tentative quotation + timeline + selected
   gallery projects + moodboard) exported as a PDF and emailed to the client.';

drop trigger if exists turnkey_consultations_touch on turnkey_consultations;
create trigger turnkey_consultations_touch
  before update on turnkey_consultations
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — admins only
-- ---------------------------------------------------------------------------
alter table turnkey_consultations enable row level security;

grant select, insert, update, delete on turnkey_consultations to authenticated;

drop policy if exists turnkey_consultations_admin_all on turnkey_consultations;
create policy turnkey_consultations_admin_all on turnkey_consultations
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Storage bucket for moodboard images — PUBLIC read, admin write
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('turnkey-consultation', 'turnkey-consultation', true)
on conflict (id) do nothing;

drop policy if exists turnkey_consultation_objects_admin_write on storage.objects;
create policy turnkey_consultation_objects_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'turnkey-consultation' and is_admin())
  with check (bucket_id = 'turnkey-consultation' and is_admin());

commit;
