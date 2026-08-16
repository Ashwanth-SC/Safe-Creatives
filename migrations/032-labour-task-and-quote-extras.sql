-- ============================================================================
-- Migration 032 — Labour Task column + quotation Special additions & Labour
-- ============================================================================
--
-- Run ONCE, after 031.
--
--   Part 1 — Labour database gains a Task column (free text), sitting after
--            Name. Each labour row is now a (category, name, task) tuple with
--            its day / sqft rates, so the quotation can cascade
--            category -> name -> task and price the exact row.
--
--   Parts 2 & 3 — Box & Shutters units gain two per-unit extras, stored as the
--            raw inputs (so a unit reopens exactly) plus their computed totals:
--
--     special_additions jsonb  — [{ name, cost }]. The names are appended to the
--                                unit's Design specifications; the costs add
--                                into the base Total (margin/discount/GST apply).
--     labour_lines      jsonb  — [{ labour_id, category, name, task,
--                                    total_days, total_sqft, cost }]. Cost =
--                                total_days * cost_per_day + total_sqft *
--                                cost_per_sqft for the chosen labour row; the
--                                sum adds into the base Total.
--     special_price / labour_price numeric — the computed sub-totals, kept for
--                                easy aggregation later.
--
-- Access: staff only, via is_admin() (inherited from the existing tables).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Part 1 — Labour: Task (after Name in the grid; column order is UI-driven)
-- ---------------------------------------------------------------------------
alter table turnkey_labour
  add column if not exists task text;

comment on column turnkey_labour.task is
  'The specific task this labour row is rated for (free text). Fills the Task
   dropdown in the quotation Labour segment, filtered by category + name.';

-- ---------------------------------------------------------------------------
-- Parts 2 & 3 — Box & Shutters unit: special additions + labour
-- ---------------------------------------------------------------------------
alter table turnkey_quote_box_units
  add column if not exists special_additions jsonb,   -- [{ name, cost }]
  add column if not exists labour_lines      jsonb,   -- [{ labour_id, ... , cost }]
  add column if not exists special_price     numeric, -- computed sum of additions
  add column if not exists labour_price       numeric; -- computed sum of labour

commit;
