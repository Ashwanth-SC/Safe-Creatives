-- ============================================================================
-- Migration 046 — Project Tracking: customer read access
-- ============================================================================
--
-- Run ONCE, after 045.
--
-- Lets a signed-in customer see the tracking for their own project(s) — the
-- projects whose client_email (set by staff in the turnkey dashboard) matches
-- the email they logged in with. Read-only; the admin write policy is untouched.
--
-- turnkey_projects itself stays admin-only (it holds budget / margin / notes),
-- so the customer never queries it directly:
--   * turnkey_my_projects()  — SECURITY DEFINER, returns only SAFE columns for
--                              the caller's own projects.
--   * turnkey_project_is_mine(pid) — SECURITY DEFINER ownership check used by the
--                              tracking read policy (so the policy can test
--                              client_email without exposing turnkey_projects).
--
-- Gate is email-match only. To also require the advance to be paid later, add
-- that condition inside these two functions.
-- ============================================================================

begin;

-- The email the caller is signed in with (JWT claim; profiles.email fallback).
create or replace function turnkey_current_email()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select lower(coalesce(
    nullif(auth.jwt() ->> 'email', ''),
    (select p.email from profiles p where p.id = auth.uid()),
    ''
  ));
$$;

-- Does this project belong to the caller (by client_email)?
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

-- Safe project list for the signed-in customer (no financial/internal columns).
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

grant execute on function turnkey_current_email() to authenticated;
grant execute on function turnkey_project_is_mine(uuid) to authenticated;
grant execute on function turnkey_my_projects() to authenticated;

-- Customer can READ tracking rows for their own projects (admin policy stays
-- for all commands; SELECT policies are OR'd, so admins keep full access).
drop policy if exists turnkey_project_tracking_client_read on turnkey_project_tracking;
create policy turnkey_project_tracking_client_read on turnkey_project_tracking
  for select to authenticated
  using (turnkey_project_is_mine(project_id));

commit;
