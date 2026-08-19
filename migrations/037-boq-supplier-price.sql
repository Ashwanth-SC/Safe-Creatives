-- ============================================================================
-- Migration 037 — Vendor BOQ: supplier + unit price on the material BOQ
-- ============================================================================
--
-- Run ONCE, after 036.
--
-- The aggregated material BOQ (turnkey_project_boq, fed from Box & Shutters and
-- Wall Panels) previously stored only product_name / category / quantity. The
-- Vendor BOQ groups purchases by supplier and shows costs, so each line now
-- also carries the supplier and the unit price.
--
-- The compute functions emit supplier + unit_price on every boq_line; the shared
-- rebuild backfills older lines (saved before this change) by matching the
-- product name against the products / hardwares databases. Existing box/wall
-- units don't need re-saving — opening the Vendor BOQ triggers a rebuild.
--
-- Deploy after this migration:
--   supabase functions deploy compute-box-unit
--   supabase functions deploy compute-wall-panel
-- ============================================================================

begin;

alter table turnkey_project_boq
  add column if not exists supplier   text,
  add column if not exists unit_price numeric;

commit;
