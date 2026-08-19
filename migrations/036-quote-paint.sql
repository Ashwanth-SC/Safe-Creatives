-- ============================================================================
-- Migration 036 — Quotation: Paint work
-- ============================================================================
--
-- Run ONCE, after 035.
--
-- Paint work is a thin computation: pick a supplier, then a paint from the
-- products database (category 'paint', that supplier), and enter the total
-- applicable sqft. Price = sqft * the product's price_per_sqft; the project
-- margin, discount and GST cascade over it (stored as a snapshot).
--
-- Supplier / description / sqft / price are the vendor BOQ fields, so this table
-- IS the paint section of the BOQ. Saved from the client (RLS admin).
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_quote_paint (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references turnkey_projects(id) on delete cascade,
  supplier        text,
  product_id      uuid references turnkey_products(id) on delete set null,
  description     text,          -- product name snapshot
  sqft            numeric,
  unit_price      numeric,       -- price_per_sqft snapshot (the rate)
  total_price     numeric,       -- sqft * unit_price
  margin_price    numeric,
  margin_amount   numeric,
  discount_price  numeric,
  gst_price       numeric,
  sort_order      integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table turnkey_quote_paint is
  'Paint work quotation lines. Price = sqft * product price_per_sqft; also the
   paint section of the vendor BOQ (supplier/description/sqft/price).';

create index if not exists turnkey_quote_paint_project_idx
  on turnkey_quote_paint (project_id, sort_order);

drop trigger if exists turnkey_quote_paint_touch on turnkey_quote_paint;
create trigger turnkey_quote_paint_touch
  before update on turnkey_quote_paint
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_quote_paint enable row level security;

grant select, insert, update, delete on turnkey_quote_paint to authenticated;

drop policy if exists turnkey_quote_paint_admin_all on turnkey_quote_paint;
create policy turnkey_quote_paint_admin_all on turnkey_quote_paint
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
