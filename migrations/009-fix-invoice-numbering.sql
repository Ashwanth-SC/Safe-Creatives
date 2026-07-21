-- ============================================================================
-- Migration 009 — fix ambiguous column in next_invoice_number
-- ============================================================================
--
-- Run ONCE, after 006-invoicing.sql (order relative to 007/008 does not
-- matter). Safe to run on top of the broken version -- it just replaces the
-- function.
--
-- Bug: next_invoice_number RETURNS TABLE (... financial_year text ...), so
-- `financial_year` is an output variable throughout the body. invoice_counters
-- ALSO has a column `financial_year`. In the counter upsert, Postgres could
-- not tell which one `financial_year` meant and raised:
--
--   column reference "financial_year" is ambiguous
--
-- This failed EVERY invoice, webhook path included -- it surfaced first when
-- back-filling by hand.
--
-- Fix: `#variable_conflict use_column` tells PL/pgSQL that a bare name which
-- could be either resolves to the COLUMN. That is exactly right here: the
-- only bare `financial_year` references are the insert's column list and the
-- conflict target, both of which are the table's column. Everything the
-- function returns is built from the v_-prefixed locals, so nothing else is
-- affected.
-- ============================================================================

create or replace function next_invoice_number(p_user_id uuid)
returns table (
  invoice_number  text,
  financial_year  text,
  fy_short        text,
  customer_number integer,
  phase_number    integer,
  sequence_number integer
)
language plpgsql
security definer
set search_path = public
as $$
#variable_conflict use_column
declare
  v_fy       text;
  v_fy_short text;
  v_cust     integer;
  v_phase    integer;
  v_seq      integer;
begin
  v_fy := financial_year_of(current_date);
  v_fy_short := right(v_fy, 2);

  select p.customer_number into v_cust from profiles p where p.id = p_user_id;
  if v_cust is null then
    raise exception 'Customer % has no customer_number', p_user_id;
  end if;

  -- This customer's invoice count + 1 = their next phase.
  select count(*) + 1 into v_phase from invoices i where i.user_id = p_user_id;

  -- Global sequence for the financial year, allocated under a row lock.
  insert into invoice_counters (financial_year, last_sequence)
  values (v_fy, 1)
  on conflict (financial_year)
    do update set last_sequence = invoice_counters.last_sequence + 1
  returning invoice_counters.last_sequence into v_seq;

  return query select
    'SCSR-' || v_fy_short || '-' ||
      lpad(v_cust::text, 2, '0') || '-' ||
      v_phase::text || '-' ||
      lpad(v_seq::text, 3, '0'),
    v_fy, v_fy_short, v_cust, v_phase, v_seq;
end;
$$;

grant execute on function next_invoice_number(uuid) to service_role;


-- Verify (this consumes a sequence number, so only run when you mean to):
-- select * from next_invoice_number('<a user id with a customer_number>');
