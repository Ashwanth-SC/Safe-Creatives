-- ============================================================================
-- Migration 008 — HSN/SAC for the advance line
-- ============================================================================
--
-- Run ONCE, after 007-state-of-supply.sql.
--
-- The advance invoice line was borrowing the first package's HSN, which is
-- wrong in kind: packages are goods (chapter 94), while a reservation
-- advance is a service and takes a SAC. One value for the whole business,
-- so it lives in seller_settings and is editable from the catalog admin.
--
-- Which SAC applies (9954 works-contract vs 9972/9983 services) is a
-- classification question for your CA, not for this schema.
-- ============================================================================

alter table seller_settings
  add column if not exists advance_hsn_code text;

-- Check:
-- select advance_hsn_code from seller_settings;
