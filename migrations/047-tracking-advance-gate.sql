-- ============================================================================
-- Migration 047 — Project Tracking: require the advance to be paid
-- ============================================================================
--
-- Run ONCE, after 046.
--
-- Tightens the customer tracking gate: a customer can now see a project's
-- tracking only once its ADVANCE has been received. "Advance paid" = the
-- project has a turnkey_receipts row whose receipt_name starts with 'advance'
-- (case-insensitive) — the dashboard records the first payment as 'Advance'.
-- (To instead accept ANY receipt, drop the receipt_name LIKE clause below.)
--
-- Both SECURITY DEFINER functions get the condition, so it governs the account
-- link, the project list AND the tracking read policy. These functions bypass
-- turnkey_receipts' admin-only RLS (that's the point of SECURITY DEFINER).
-- ============================================================================

begin;

-- Has this project's advance been received?
create or replace function turnkey_advance_paid(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from turnkey_receipts r
    where r.project_id = pid
      and r.amount_paise > 0
      and lower(trim(r.receipt_name)) like 'advance%'
  );
$$;

-- Ownership check now also requires the advance to be paid.
create or replace function turnkey_project_is_mine(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select turnkey_current_email() <> ''
     and turnkey_advance_paid(pid)
     and exists (
       select 1 from turnkey_projects p
       where p.id = pid
         and p.client_email is not null
         and lower(p.client_email) = turnkey_current_email()
     );
$$;

-- Only advance-paid projects appear in the customer's list.
create or replace function turnkey_my_projects()
returns table (id uuid, project_number integer, project_name text, client_name text, status text)
language sql
stable
security definer
set search_path = public
as $$
  select p.id, p.project_number, p.project_name, p.client_name, p.status
  from turnkey_projects p
  where turnkey_current_email() <> ''
    and p.client_email is not null
    and lower(p.client_email) = turnkey_current_email()
    and turnkey_advance_paid(p.id)
  order by p.project_number desc;
$$;

grant execute on function turnkey_advance_paid(uuid) to authenticated;

commit;
