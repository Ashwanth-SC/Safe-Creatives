-- ============================================================================
-- Migration 023 — Suppliers: merge supplier + company_name into one column
-- ============================================================================
--
-- Run ONCE, ONLY IF you already ran the earlier two-column version of
-- migration 022 (with separate `supplier` and `company_name` columns).
--
-- If you ran the current 022 (single `supplier_company_name` column) or haven't
-- run 022 at all, this migration is a safe no-op — but you can skip it.
--
-- It adds `supplier_company_name`, merges any existing data from the two old
-- columns into it, then drops them. Fully guarded, so it can't error on a table
-- that is already in the new shape.
-- ============================================================================

begin;

alter table turnkey_suppliers add column if not exists supplier_company_name text;

-- Merge only if the old columns are actually present (dynamic SQL so the
-- statement isn't even parsed when they aren't).
do $$
begin
  if exists (
        select 1 from information_schema.columns
        where table_name = 'turnkey_suppliers' and column_name = 'supplier'
      )
     or exists (
        select 1 from information_schema.columns
        where table_name = 'turnkey_suppliers' and column_name = 'company_name'
      )
  then
    execute $q$
      update turnkey_suppliers
         set supplier_company_name = coalesce(
               nullif(trim(both ' ' from concat_ws(' ', supplier, company_name)), ''),
               supplier_company_name)
    $q$;
  end if;
end $$;

alter table turnkey_suppliers drop column if exists supplier;
alter table turnkey_suppliers drop column if exists company_name;

commit;
