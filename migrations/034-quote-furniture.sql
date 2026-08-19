-- ============================================================================
-- Migration 034 — Quotation: Furniture
-- ============================================================================
--
-- Run ONCE, after 033.
--
-- Furniture is manual entry — no material computation. Each row is a bought
-- item: space, supplier, unit (item name), material & design specs, quantity
-- and unit price. The line total is quantity * unit_price; the project margin,
-- discount and GST cascade over it (stored as a snapshot, like Box & Shutters).
--
-- Supplier / unit / quantity / specs / price are exactly the fields the vendor
-- BOQ needs, so this table IS the furniture section of the BOQ (read from here
-- when the Vendor BOQ view is built). Saved straight from the client (RLS
-- admin) — no edge function.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_quote_furniture (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references turnkey_projects(id) on delete cascade,
  space           text,
  supplier        text,
  unit_name       text,          -- the item / unit name
  material_spec   text,
  design_spec     text,
  quantity        numeric,
  unit_price      numeric,       -- "Price" (per unit)
  total_price     numeric,       -- quantity * unit_price
  margin_price    numeric,
  margin_amount   numeric,
  discount_price  numeric,
  gst_price       numeric,
  sort_order      integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table turnkey_quote_furniture is
  'Furniture quotation lines (manual entry). One bought item per row; also the
   furniture section of the vendor BOQ (supplier/unit/qty/specs/price).';

create index if not exists turnkey_quote_furniture_project_idx
  on turnkey_quote_furniture (project_id, sort_order);

drop trigger if exists turnkey_quote_furniture_touch on turnkey_quote_furniture;
create trigger turnkey_quote_furniture_touch
  before update on turnkey_quote_furniture
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_quote_furniture enable row level security;

grant select, insert, update, delete on turnkey_quote_furniture to authenticated;

drop policy if exists turnkey_quote_furniture_admin_all on turnkey_quote_furniture;
create policy turnkey_quote_furniture_admin_all on turnkey_quote_furniture
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
