-- ============================================================================
-- Migration 022 — Turnkey database: suppliers
-- ============================================================================
--
-- Run ONCE, after 021-quotation-project-setup.sql.
--
-- The first reference table behind the quotation builder: the supplier list.
-- It's maintained from the new Turnkey database window (an editable grid).
-- More reference tables (labour, rate databases per category) will follow as
-- their own migrations.
--
-- Every column is free text and nullable — the grid lets staff fill rows in
-- as they go and add/delete rows freely.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_suppliers (
  id                     uuid primary key default gen_random_uuid(),
  supplier_company_name  text,
  spoc                   text,   -- single point of contact (person)
  spoc_contact           text,
  spoc_mail              text,
  address                text,
  gst_number             text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table turnkey_suppliers is
  'Vendor/supplier reference list for the quotation builder. Maintained as an
   editable grid in the Turnkey database window.';

create index if not exists turnkey_suppliers_created_idx
  on turnkey_suppliers (created_at);

drop trigger if exists turnkey_suppliers_touch on turnkey_suppliers;
create trigger turnkey_suppliers_touch
  before update on turnkey_suppliers
  for each row execute function touch_updated_at();

alter table turnkey_suppliers enable row level security;
grant select, insert, update, delete on turnkey_suppliers to authenticated;

drop policy if exists turnkey_suppliers_admin_all on turnkey_suppliers;
create policy turnkey_suppliers_admin_all on turnkey_suppliers
  for all to authenticated
  using (is_admin()) with check (is_admin());

commit;
