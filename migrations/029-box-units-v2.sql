-- ============================================================================
-- Migration 029 — Box & Shutters v2 (brand/laminate model + hardware)
-- ============================================================================
--
-- Run ONCE, after 028. (Needs 027's turnkey_quote_box_units to exist.)
--
-- Reworks Box & Shutters pricing:
--   * material is chosen by brand + sub-category (the board per thickness is
--     found automatically); laminate by brand + an outer + an inner product;
--   * laminate faces depend on the panel's part-category (from the CSV
--     Designation, "PartCategory-Name"); hinges + channels come from Hardwares;
--   * totals carry through margin, discount and GST.
--
-- The full computed breakdown (plywood groups, laminate, hardware) is stored as
-- JSON on the unit; the old per-thickness groups table is dropped.
--
-- Access: staff only, via is_admin() (inherited from the existing table).
-- ============================================================================

begin;

alter table turnkey_quote_box_units
  add column if not exists material_brand         text,
  add column if not exists material_sub_category  text,
  add column if not exists laminate_brand         text,
  add column if not exists outer_laminate_id      uuid references turnkey_products(id) on delete set null,
  add column if not exists inner_laminate_id      uuid references turnkey_products(id) on delete set null,
  add column if not exists hardware_price         numeric,
  add column if not exists total_price            numeric,   -- plywood+laminate+hardware
  add column if not exists margin_price           numeric,
  add column if not exists discount_price         numeric,
  add column if not exists gst_price              numeric,
  add column if not exists material_spec          text,
  add column if not exists design_spec            text,
  add column if not exists computed               jsonb;     -- full breakdown

-- The category-per-unit model is replaced by brand/sub-category.
alter table turnkey_quote_box_units drop column if exists material_category;
alter table turnkey_quote_box_units drop column if exists laminate_category;

-- Breakdown now lives in the computed JSON.
drop table if exists turnkey_quote_box_groups;

commit;
