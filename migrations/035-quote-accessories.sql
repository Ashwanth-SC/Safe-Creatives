-- ============================================================================
-- Migration 035 — Quotation: Accessories
-- ============================================================================
--
-- Run ONCE, after 034.
--
-- Accessories are manual entry, like Furniture (no material computation). Each
-- row is a bought item: supplier, unit (item name), specification, quantity and
-- unit price. Line total = quantity * unit_price; the project margin, discount
-- and GST cascade over it (stored as a snapshot).
--
-- Supplier / unit / specification / quantity / price are the vendor BOQ fields,
-- so this table IS the accessories section of the BOQ. Saved straight from the
-- client (RLS admin) — no edge function.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_quote_accessories (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references turnkey_projects(id) on delete cascade,
  supplier        text,
  unit_name       text,          -- the item / unit name
  specification   text,
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

comment on table turnkey_quote_accessories is
  'Accessories quotation lines (manual entry). One bought item per row; also the
   accessories section of the vendor BOQ (supplier/unit/spec/qty/price).';

create index if not exists turnkey_quote_accessories_project_idx
  on turnkey_quote_accessories (project_id, sort_order);

drop trigger if exists turnkey_quote_accessories_touch on turnkey_quote_accessories;
create trigger turnkey_quote_accessories_touch
  before update on turnkey_quote_accessories
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_quote_accessories enable row level security;

grant select, insert, update, delete on turnkey_quote_accessories to authenticated;

drop policy if exists turnkey_quote_accessories_admin_all on turnkey_quote_accessories;
create policy turnkey_quote_accessories_admin_all on turnkey_quote_accessories
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
