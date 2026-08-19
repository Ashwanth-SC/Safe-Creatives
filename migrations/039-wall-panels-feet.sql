-- ============================================================================
-- Migration 039 — Wall Panels: dimensions in feet + material breakdown
-- ============================================================================
--
-- Run ONCE, after 038.
--
-- Wall Panels now take Length + Height in FEET (not mm). Adds length_ft /
-- height_ft; the old length_mm / width_mm stay but are unused. Panel maths:
--   * Base   — 8 mm ply face (area = L*H sqft)
--   * Framed — 12 mm ply face + 16 mm ply frame; frame sqft =
--              (L*0.25*2) + ((H-2)*0.25*floor(H))
--   * Direct — laminate only
-- Laminate is picked directly (no brand step). Special additions become a
-- hardware product + quantity (stored in the existing special_additions jsonb).
-- The computed material breakdown lives in the computed jsonb.
--
-- Deploy after this migration: supabase functions deploy compute-wall-panel
-- ============================================================================

begin;

alter table turnkey_quote_wall_panels
  add column if not exists length_ft numeric,
  add column if not exists height_ft numeric;

commit;
