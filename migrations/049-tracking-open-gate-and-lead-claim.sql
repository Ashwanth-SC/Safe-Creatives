-- ============================================================================
-- Migration 049 — Tracking: open the gate + claim enquiry-form profile
-- ============================================================================
--
-- Run ONCE, after 048.
--
-- Two changes:
--
-- 1. No re-registration. A customer who filled the turnkey enquiry form already
--    gave us their name + phone (on turnkey_projects). turnkey_claim_lead_profile()
--    copies those into the signed-in user's profile (blanks only) so they skip
--    the registration form after logging in with the email code.
--
-- 2. Tracking is visible from the start. The "Track my project" button and the
--    project list are now email-match only (any customer with a matching
--    project), and the tracking read policy is email-match only — so the FULL
--    detail simply appears once staff have entered tracking rows; before that
--    the customer page shows the project's status. (Drops the DSO/advance gate.)
-- ============================================================================

begin;

-- 1. Pull enquiry-form details into the caller's profile (no re-register).
create or replace function turnkey_claim_lead_profile()
returns boolean            -- true once the profile has a name
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  em  text := turnkey_current_email();
  lead_name  text;
  lead_phone text;
  cur_name   text;
begin
  if uid is null or em = '' then return false; end if;

  select full_name into cur_name from profiles where id = uid;
  if cur_name is not null and btrim(cur_name) <> '' then
    return true;                      -- already registered
  end if;

  select client_name, client_phone
    into lead_name, lead_phone
  from turnkey_projects
  where client_email is not null
    and lower(client_email) = em
    and client_name is not null
    and btrim(client_name) <> ''
  order by project_number desc
  limit 1;

  if lead_name is null then return false; end if;   -- no matching lead

  update profiles
     set full_name = lead_name,
         phone     = coalesce(nullif(btrim(phone), ''), lead_phone)
   where id = uid;

  return true;
end;
$$;

grant execute on function turnkey_claim_lead_profile() to authenticated;

-- 2. Open the tracking gate back to email-match only.
create or replace function turnkey_project_is_mine(pid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select turnkey_current_email() <> ''
     and exists (
       select 1 from turnkey_projects p
       where p.id = pid
         and p.client_email is not null
         and lower(p.client_email) = turnkey_current_email()
     );
$$;

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
  order by p.project_number desc;
$$;

-- The DSO gate is no longer referenced.
drop function if exists turnkey_tracking_unlocked(uuid);

commit;
