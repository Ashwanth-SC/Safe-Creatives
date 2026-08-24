-- ============================================================================
-- Migration 044 — Quotation: saved versions (for comparison)
-- ============================================================================
--
-- Run ONCE, after 043.
--
-- Freezes the computed customer quotation as a numbered "version" so a previous
-- quote can be compared against the current one. The full computed quotation
-- (per-segment lines + totals + the margin/discount/GST used) is stored as a
-- JSON snapshot; grand totals and the percentages are denormalised for the list
-- and the totals-level comparison. One row per saved version, per project.
--
-- Snapshotting (rather than recomputing) is deliberate: catalog prices, saved
-- units and the project percentages all drift over time, so a version must
-- capture exactly what was quoted at that moment.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_quote_versions (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references turnkey_projects(id) on delete cascade,
  version_no        integer not null,        -- per project, incrementing
  label             text,                    -- optional, e.g. "Sent to client"
  margin_percent    numeric,
  discount_percent  numeric,
  gst_percent       numeric,
  grand_price       numeric,                 -- grand total with margin
  grand_disc        numeric,                 -- grand total with discount
  grand_gst         numeric,                 -- grand total with GST
  snapshot          jsonb,                   -- { pct, grand, segments:[{title,totals,rows}] }
  created_at        timestamptz not null default now(),
  created_by        uuid default auth.uid()
);

comment on table turnkey_quote_versions is
  'Frozen snapshots of a project quotation, numbered per project, for comparing
   a previous quote against the current one.';

create unique index if not exists turnkey_quote_versions_no_idx
  on turnkey_quote_versions (project_id, version_no);

create index if not exists turnkey_quote_versions_project_idx
  on turnkey_quote_versions (project_id, created_at);

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_quote_versions enable row level security;

grant select, insert, update, delete on turnkey_quote_versions to authenticated;

drop policy if exists turnkey_quote_versions_admin_all on turnkey_quote_versions;
create policy turnkey_quote_versions_admin_all on turnkey_quote_versions
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
