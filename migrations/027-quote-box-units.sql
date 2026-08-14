-- ============================================================================
-- Migration 027 — Quotation: Box & Shutters (cutlist units)
-- ============================================================================
--
-- Run ONCE, after 026 was reverted (so the latest applied is 025). If you ran
-- the labour-tasks 026 and cleaned it up, that's fine — this is independent.
--
-- Box & Shutters pricing is cutlist-driven. Each unit imports a CSV of panels
-- (Designation; Quantity; Length; Width; Thickness), which the backend groups
-- by thickness and prices against the Products database.
--
--   * products.area_sqft — a GENERATED column, std_width * std_height (both in
--     feet), so it stays correct automatically. Read-only.
--
--   * turnkey_quote_box_units  — one row per unit: the inputs (space, name, the
--     raw CSV, the chosen material/laminate categories) + the computed total.
--
--   * turnkey_quote_box_groups — one row per thickness group within a unit: the
--     chosen material + laminate (inputs) and the computed area, sheet
--     quantities and prices.
--
-- Inputs are stored so a unit can be reopened and modified; the computed values
-- are stored so the quotation can be shown/compared without recomputing.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Products: auto-computed area in sqft (std_width * std_height, feet)
-- ---------------------------------------------------------------------------
alter table turnkey_products
  add column if not exists area_sqft numeric
    generated always as (std_width * std_height) stored;

comment on column turnkey_products.area_sqft is
  'Standard sheet area in sqft = std_width * std_height (both feet). Generated.';

-- ---------------------------------------------------------------------------
-- Box & Shutters units
-- ---------------------------------------------------------------------------
create table if not exists turnkey_quote_box_units (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references turnkey_projects(id) on delete cascade,
  space                 text,          -- the "area" dropdown (project space)
  unit_name             text,
  csv_text              text,          -- raw imported cutlist (input, for reopen)
  material_category     text,          -- product category chosen for boards
  laminate_category     text,          -- product category chosen for laminate
  total_material_price  numeric,       -- computed
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table turnkey_quote_box_units is
  'One Box & Shutters unit in a project quotation: cutlist inputs + computed
   material total. Working data; a saved quotation version snapshots it later.';

create index if not exists turnkey_quote_box_units_project_idx
  on turnkey_quote_box_units (project_id, created_at);

drop trigger if exists turnkey_quote_box_units_touch on turnkey_quote_box_units;
create trigger turnkey_quote_box_units_touch
  before update on turnkey_quote_box_units
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Per-thickness groups within a unit
-- ---------------------------------------------------------------------------
create table if not exists turnkey_quote_box_groups (
  id                   uuid primary key default gen_random_uuid(),
  unit_id              uuid not null references turnkey_quote_box_units(id) on delete cascade,
  thickness            numeric,
  panel_count          integer,
  group_area_sqft      numeric,        -- computed: sum of (L+2)(W+2)*qty, sqft
  material_product_id  uuid references turnkey_products(id) on delete set null,
  laminate_product_id  uuid references turnkey_products(id) on delete set null,
  plywood_qty          integer,        -- computed
  laminate_qty         integer,        -- computed (x2 for both faces)
  plywood_price        numeric,        -- computed
  laminate_price       numeric,        -- computed
  created_at           timestamptz not null default now()
);

create index if not exists turnkey_quote_box_groups_unit_idx
  on turnkey_quote_box_groups (unit_id);

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_quote_box_units enable row level security;
alter table turnkey_quote_box_groups enable row level security;

grant select, insert, update, delete on turnkey_quote_box_units to authenticated;
grant select, insert, update, delete on turnkey_quote_box_groups to authenticated;

drop policy if exists turnkey_quote_box_units_admin_all on turnkey_quote_box_units;
create policy turnkey_quote_box_units_admin_all on turnkey_quote_box_units
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists turnkey_quote_box_groups_admin_all on turnkey_quote_box_groups;
create policy turnkey_quote_box_groups_admin_all on turnkey_quote_box_groups
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
