-- ============================================================================
-- Migration 031 — Box & Shutters: per-part-category handle selections
-- ============================================================================
--
-- Run ONCE, after 030.
--
-- Handles are now chosen per part category (Drawer Shutter, Edge Shutter, ...)
-- rather than one per unit, so store the selection as a { category: hardware_id }
-- map. The old single handle_id column stays but is no longer used.
-- ============================================================================

begin;

alter table turnkey_quote_box_units add column if not exists handle_ids jsonb;

commit;
