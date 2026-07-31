-- ============================================================================
-- Migration 018 — installment payments as first-class payment rows
-- ============================================================================
--
-- Run ONCE, after 017-per-colour-pricing.sql.
--
-- The 2nd (confirmation, 80%) and 3rd (dispatch, 20%) installments can now be
-- paid by the customer themselves from the Track Order page, via an inline
-- Razorpay popup — the same mechanism as the advance. Each such payment creates
-- a real `payments` row so it appears in the dashboard payments panel and is
-- refundable, exactly like the advance.
--
-- payments.purpose was limited to ('advance','balance'). Widen it to carry the
-- installment phase, so the webhook can tell an installment capture from the
-- advance capture and finalize the right milestone.
--
-- No new tables or grants: payments stays service-role-write only (the
-- create-installment-order and payment-webhook functions), read-only to owners.
-- The admin "send payment link" path (installment_links) is unchanged.
-- ============================================================================

begin;

alter table payments drop constraint if exists payments_purpose_check;

alter table payments
  add constraint payments_purpose_check
  check (purpose in ('advance', 'balance', 'confirmation', 'dispatch'));

commit;


-- Check:
-- select purpose, status, amount_paise from payments order by created_at desc;
