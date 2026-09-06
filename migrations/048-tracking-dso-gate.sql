-- ============================================================================
-- Migration 048 — Project Tracking: unlock at Design Sign-Off (DSO), not advance
-- ============================================================================
--
-- Run ONCE, after 047.
--
-- The tracking gate now unlocks once the customer has paid the Design Sign-Off
-- (DSO) milestone — the dashboard records this as a 'DSO Payment' receipt.
-- (The earlier 'advance%' rule matched nothing: the receipts in use are
-- 'Design Initiation' and 'DSO Payment'.)
--
-- Renames turnkey_advance_paid -> turnkey_tracking_unlocked (matching 'dso%' /
-- 'sign off') and folds it into the ownership check + project list. To move the
-- gate to a different milestone later, change the receipt_name match below.
-- ============================================================================

begin;

-- Has this project reached the DSO (Design Sign-Off) payment?
create or replace function turnkey_tracking_unlocked(pid uuid)
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
      and (
        lower(btrim(r.receipt_name)) like 'dso%'
        or lower(r.receipt_name) like '%sign off%'
        or lower(r.receipt_name) like '%sign-off%'
      )
  );
$$;

-- Ownership check requires DSO paid.
create or replace function turnkey_project_is_mine(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select turnkey_current_email() <> ''
     and turnkey_tracking_unlocked(pid)
     and exists (
       select 1 from turnkey_projects p
       where p.id = pid
         and p.client_email is not null
         and lower(p.client_email) = turnkey_current_email()
     );
$$;

-- Only DSO-paid projects appear in the customer's list.
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
    and turnkey_tracking_unlocked(p.id)
  order by p.project_number desc;
$$;

-- The old, now-unreferenced advance gate.
drop function if exists turnkey_advance_paid(uuid);

grant execute on function turnkey_tracking_unlocked(uuid) to authenticated;

commit;
