-- ============================================================================
-- Migration 030 — Box & Shutters editable logic + project BOQ
-- ============================================================================
--
-- Run ONCE, after 029.
--
--   * turnkey_box_part_logic — the editable per-part-category quantity table
--     (plywood / outer / inner laminate multipliers, hinge type, handles,
--     channel flag). Seeded with the 11 canonical designations.
--
--   * turnkey_project_boq — the aggregated bill of quantities per project.
--     Rebuilt from all a project's units whenever a unit is saved or deleted.
--
--   * box units gain the hinge / channel / handle product selections + the
--     margin amount, for the reworked pricing engine.
--
-- All product/hardware dimensions & prices are now treated as mm / per-piece;
-- that's a UI/label + calculator change (no column changes needed here).
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Editable part-category logic
-- ---------------------------------------------------------------------------
create table if not exists turnkey_box_part_logic (
  id             uuid primary key default gen_random_uuid(),
  part_category  text not null unique,
  ply_qty        numeric not null default 1,
  outer_lam      numeric not null default 0,
  inner_lam      numeric not null default 0,
  hinge_type     text not null default 'None',   -- None | Edge | Inner
  handles        numeric not null default 0,
  channel        text not null default 'No',      -- No | Yes
  sort_order     integer,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table turnkey_box_part_logic is
  'Editable per-part-category quantity logic for Box & Shutters pricing.';

insert into turnkey_box_part_logic (part_category, ply_qty, outer_lam, inner_lam, hinge_type, handles, channel, sort_order) values
  ('Carcass outer',  1, 1, 1, 'None',  0, 'No',  1),
  ('Back ply',       1, 0, 2, 'None',  0, 'No',  2),
  ('Skirting',       1, 1, 1, 'None',  0, 'No',  3),
  ('Partition',      1, 2, 0, 'None',  0, 'No',  4),
  ('Shelf',          1, 2, 0, 'None',  0, 'No',  5),
  ('Drawer side',    1, 0, 2, 'None',  0, 'Yes', 6),
  ('Drawer outer',   1, 0, 2, 'None',  0, 'No',  7),
  ('Drawer Shutter', 1, 1, 1, 'None',  1, 'No',  8),
  ('Edge Shutter',   1, 1, 1, 'Edge',  1, 'No',  9),
  ('Inner Shutter',  1, 1, 1, 'Inner', 1, 'No', 10),
  ('Special shutter',1, 1, 1, 'None',  1, 'No', 11)
  on conflict (part_category) do nothing;

drop trigger if exists turnkey_box_part_logic_touch on turnkey_box_part_logic;
create trigger turnkey_box_part_logic_touch
  before update on turnkey_box_part_logic
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Project BOQ (aggregated across all box units)
-- ---------------------------------------------------------------------------
create table if not exists turnkey_project_boq (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references turnkey_projects(id) on delete cascade,
  product_name  text,
  category      text,
  quantity      numeric,
  created_at    timestamptz not null default now()
);

comment on table turnkey_project_boq is
  'Aggregated bill of quantities per project; rebuilt from all units on save/delete.';

create index if not exists turnkey_project_boq_project_idx on turnkey_project_boq (project_id);

-- ---------------------------------------------------------------------------
-- Box unit selections for the reworked engine
-- ---------------------------------------------------------------------------
alter table turnkey_quote_box_units
  add column if not exists edge_hinge_id  uuid references turnkey_hardwares(id) on delete set null,
  add column if not exists inner_hinge_id uuid references turnkey_hardwares(id) on delete set null,
  add column if not exists channel_id     uuid references turnkey_hardwares(id) on delete set null,
  add column if not exists handle_id      uuid references turnkey_hardwares(id) on delete set null,
  add column if not exists margin_amount  numeric;

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_box_part_logic enable row level security;
alter table turnkey_project_boq enable row level security;

grant select, insert, update, delete on turnkey_box_part_logic to authenticated;
grant select, insert, update, delete on turnkey_project_boq to authenticated;

drop policy if exists turnkey_box_part_logic_admin_all on turnkey_box_part_logic;
create policy turnkey_box_part_logic_admin_all on turnkey_box_part_logic
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists turnkey_project_boq_admin_all on turnkey_project_boq;
create policy turnkey_project_boq_admin_all on turnkey_project_boq
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
