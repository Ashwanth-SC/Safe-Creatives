-- ============================================================================
-- Migration 041 — Accessories database + per-row margin on quote accessories
-- ============================================================================
--
-- Run ONCE, after 040.
--
--   * turnkey_accessories — a reference list of accessories (supplier, product
--     name, category [default 'Accessories'], price per piece). Maintained as an
--     editable grid in the Turnkey database window (Accessories tab).
--
--   * turnkey_quote_accessories gains margin_percent (a per-line margin the user
--     sets manually — accessories can override the project margin) and
--     accessory_id (the picked reference accessory).
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_accessories (
  id                uuid primary key default gen_random_uuid(),
  supplier          text,          -- value from turnkey_suppliers
  product_name      text,
  product_category  text not null default 'Accessories',
  price_per_piece   numeric check (price_per_piece is null or price_per_piece >= 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table turnkey_accessories is
  'Accessories reference list (supplier / product / price per piece) for the
   quotation Accessories segment. Editable grid in the Turnkey database window.';

create index if not exists turnkey_accessories_created_idx on turnkey_accessories (created_at);
create index if not exists turnkey_accessories_supplier_idx on turnkey_accessories (supplier);

drop trigger if exists turnkey_accessories_touch on turnkey_accessories;
create trigger turnkey_accessories_touch
  before update on turnkey_accessories
  for each row execute function touch_updated_at();

alter table turnkey_accessories enable row level security;
grant select, insert, update, delete on turnkey_accessories to authenticated;
drop policy if exists turnkey_accessories_admin_all on turnkey_accessories;
create policy turnkey_accessories_admin_all on turnkey_accessories
  for all to authenticated using (is_admin()) with check (is_admin());

-- Per-line margin override + the picked reference accessory.
alter table turnkey_quote_accessories
  add column if not exists margin_percent numeric,
  add column if not exists accessory_id   uuid references turnkey_accessories(id) on delete set null;

commit;
