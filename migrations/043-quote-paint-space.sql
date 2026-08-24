-- ============================================================================
-- Migration 043 — Paint work: space
-- ============================================================================
--
-- Run ONCE, after 042.
--
-- Adds the project "area" (space) dropdown to each Paint work line, mirroring
-- the Space column already on Box & Shutters / Wall Panels / Furniture / Civil /
-- Electrical. Shown in the Paint segment (after Supplier) and the customer
-- quotation.
-- ============================================================================

begin;

alter table turnkey_quote_paint
  add column if not exists space text;

commit;
