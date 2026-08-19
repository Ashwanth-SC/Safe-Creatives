-- ============================================================================
-- Migration 040 — Box & Shutters logic v2 (thickness / minifix / legs)
-- ============================================================================
--
-- Run ONCE, after 039.
--
-- The per-part-category logic gains:
--   * plywood_thickness — the plywood thickness (mm) is now decided by the
--     designation here, not by the cutlist CSV (ply_qty is retired).
--   * minifix (No/Yes) — the part gets Minifix hardware (count from the size).
--   * legs (No/Yes)     — the part gets Legs hardware (Carcass base only).
--
-- Reseeds the 13 canonical designations (adds Carcass base, Filler, Drawer
-- panel; 'Drawer outer' is renamed to 'Drawer panel'). Hinges/handles/channels/
-- minifix/legs counts are computed by the calculator from the panel size.
--
-- Deploy after this migration: supabase functions deploy compute-box-unit
-- ============================================================================

begin;

alter table turnkey_box_part_logic
  add column if not exists plywood_thickness numeric,
  add column if not exists minifix text not null default 'No',
  add column if not exists legs    text not null default 'No';

-- Per-panel outer-laminate selections ({ panelIndex: product_id }); inner
-- laminate stays a single per-unit product on inner_laminate_id.
alter table turnkey_quote_box_units
  add column if not exists outer_laminate_ids jsonb;

insert into turnkey_box_part_logic
  (part_category, plywood_thickness, outer_lam, inner_lam, hinge_type, handles, channel, minifix, legs, sort_order) values
  ('Carcass outer',   16, 1, 1, 'None',  0, 'No',  'Yes', 'No',  1),
  ('Carcass base',    16, 0, 2, 'None',  0, 'No',  'Yes', 'Yes', 2),
  ('Back ply',         8, 0, 2, 'None',  0, 'No',  'No',  'No',  3),
  ('Skirting',        16, 1, 1, 'None',  0, 'No',  'No',  'No',  4),
  ('Filler',          16, 1, 1, 'None',  0, 'No',  'No',  'No',  5),
  ('Partition',       16, 0, 2, 'None',  0, 'No',  'Yes', 'No',  6),
  ('Shelf',           16, 0, 2, 'None',  0, 'No',  'No',  'No',  7),
  ('Drawer side',     16, 0, 2, 'None',  0, 'Yes', 'Yes', 'No',  8),
  ('Drawer panel',    16, 0, 2, 'None',  0, 'No',  'Yes', 'No',  9),
  ('Drawer Shutter',  16, 1, 1, 'None',  1, 'No',  'Yes', 'No', 10),
  ('Edge Shutter',    16, 1, 1, 'Edge',  1, 'No',  'No',  'No', 11),
  ('Inner Shutter',   16, 1, 1, 'Inner', 1, 'No',  'No',  'No', 12),
  ('Special shutter', 16, 1, 1, 'None',  1, 'No',  'No',  'No', 13)
on conflict (part_category) do update set
  plywood_thickness = excluded.plywood_thickness,
  outer_lam = excluded.outer_lam, inner_lam = excluded.inner_lam,
  hinge_type = excluded.hinge_type, handles = excluded.handles, channel = excluded.channel,
  minifix = excluded.minifix, legs = excluded.legs, sort_order = excluded.sort_order;

-- 'Drawer outer' was renamed to 'Drawer panel'.
delete from turnkey_box_part_logic where part_category = 'Drawer outer';

commit;
