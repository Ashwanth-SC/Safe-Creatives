-- ============================================================================
-- Migration 045 — Project Tracking
-- ============================================================================
--
-- Run ONCE, after 044.
--
-- Per-line construction tracking for a turnkey project. One row per quotation
-- line (Box & Shutters / Wall Panels / Furniture / Accessories / Paint / Civil /
-- Electrical), linked back to its source line by (source_table, source_id).
-- Category / area / product / price are SNAPSHOT from the quotation; the admin
-- adds a phase (build order), up to 3 progress photos, a completion date and a
-- status (not_started | in_progress | completed, default in_progress).
--
-- Progress photos live in a PUBLIC Storage bucket 'turnkey-tracking' so the same
-- URLs work on the customer's tracking view later (admin-write; public-read).
--
-- Admin-only for now; a customer-read policy is added when the customer-facing
-- tracking view is built (gated on the project's advance being paid).
-- ============================================================================

begin;

create table if not exists turnkey_project_tracking (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references turnkey_projects(id) on delete cascade,

  -- Link back to the quotation line this tracks.
  source_table    text not null,      -- e.g. 'turnkey_quote_box_units'
  source_id       uuid not null,      -- the quotation line id

  -- Snapshot from the quotation (kept current on each save).
  category        text,               -- segment title, e.g. 'Box & Shutters'
  area            text,               -- the project space
  product         text,               -- unit name / description
  price           numeric,            -- price with discount (per project pick)

  -- Tracking inputs.
  phase           integer,            -- build order; rows sort ascending by this
  photos          jsonb not null default '[]'::jsonb,  -- up to 3 storage paths
  completion_date date,
  status          text not null default 'in_progress'
                    check (status in ('not_started', 'in_progress', 'completed')),
  sort_order      integer,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  unique (project_id, source_table, source_id)
);

comment on table turnkey_project_tracking is
  'Per-line construction tracking for a turnkey project: one row per quotation
   line with phase, progress photos, completion date and status.';

create index if not exists turnkey_project_tracking_project_idx
  on turnkey_project_tracking (project_id, sort_order);

drop trigger if exists turnkey_project_tracking_touch on turnkey_project_tracking;
create trigger turnkey_project_tracking_touch
  before update on turnkey_project_tracking
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only (customer read added with the customer view)
-- ---------------------------------------------------------------------------
alter table turnkey_project_tracking enable row level security;

grant select, insert, update, delete on turnkey_project_tracking to authenticated;

drop policy if exists turnkey_project_tracking_admin_all on turnkey_project_tracking;
create policy turnkey_project_tracking_admin_all on turnkey_project_tracking
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Storage bucket for progress photos — PUBLIC read, admin write
-- ---------------------------------------------------------------------------
-- Public bucket: objects are served over the public CDN URL (so the customer
-- view can show them without auth). Writing still needs an admin.
insert into storage.buckets (id, name, public)
values ('turnkey-tracking', 'turnkey-tracking', true)
on conflict (id) do nothing;

drop policy if exists turnkey_tracking_objects_admin_write on storage.objects;
create policy turnkey_tracking_objects_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'turnkey-tracking' and is_admin())
  with check (bucket_id = 'turnkey-tracking' and is_admin());

commit;
