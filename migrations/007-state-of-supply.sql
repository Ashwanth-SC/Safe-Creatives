-- ============================================================================
-- Migration 007 — state of supply
-- ============================================================================
--
-- Run ONCE, after 006-invoicing.sql.
--
-- The GST split depends on the customer's state: Tamil Nadu customers pay
-- CGST 9% + SGST 9%, everyone else pays IGST 18%. We collect city and PIN
-- but never asked for the state, and inferring it from PIN prefixes is an
-- approximation -- not acceptable when it decides which tax appears on a
-- legal document. So the customer picks their state from a dropdown and it
-- is stored explicitly.
--
-- Snapshotted onto orders like the rest of the address, because place of
-- supply is fixed at the time of supply regardless of where the customer
-- moves later.
-- ============================================================================

begin;

alter table profiles add column if not exists state_name text;
alter table profiles add column if not exists state_code text;

alter table orders add column if not exists delivery_state_name text;
alter table orders add column if not exists delivery_state_code text;

-- Two-digit GST state code, e.g. '33' for Tamil Nadu.
alter table profiles add constraint profiles_state_code_format
  check (state_code is null or state_code ~ '^[0-9]{2}$');

commit;


-- Check:
-- select email, city, state_name, state_code, pin_code from profiles;
