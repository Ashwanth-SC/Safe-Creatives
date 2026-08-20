-- ============================================================================
-- Migration 042 — Wall Panels: unit name
-- ============================================================================
--
-- Run ONCE, after 041.
--
-- Adds a free-text unit name to each Wall Panel (e.g. "TV wall", "Reading nook
-- panel"), mirroring the Unit name already on Box & Shutters. Shown in the
-- panel's Main segment, the saved-panels list and the customer quotation.
--
-- Deploy after this migration: supabase functions deploy compute-wall-panel
-- ============================================================================

begin;

alter table turnkey_quote_wall_panels
  add column if not exists unit_name text;

commit;
