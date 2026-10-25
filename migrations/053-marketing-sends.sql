-- ============================================================================
-- Migration 053 — marketing sends (who has already been emailed)
-- ============================================================================
--
-- Run ONCE, after 052.
--
-- One row per email address that has received at least one marketing email
-- through the Sensory dashboard. send-marketing-email upserts here (service
-- role) after a successful send. The dashboard uses it to split no-activity
-- registrations into two audiences:
--   * "New registrations" — never emailed (not in this table)
--   * "Old registrations" — already emailed (in this table)
--
-- Admins can read the list (for counts and the CSV export); the writes happen
-- through the service role, so no insert policy is needed.
-- ============================================================================

begin;

create table if not exists marketing_sends (
  email         text primary key,
  first_sent_at timestamptz not null default now(),
  last_sent_at  timestamptz not null default now(),
  send_count    integer     not null default 1,
  last_category text
);

comment on table marketing_sends is
  'Emails that have been sent at least one marketing email from the Sensory
   dashboard. Splits no-activity registrations into new (never emailed) vs old
   (already emailed); written by send-marketing-email via the service role.';

alter table marketing_sends enable row level security;

grant select on marketing_sends to authenticated;

drop policy if exists marketing_sends_admin_read on marketing_sends;
create policy marketing_sends_admin_read on marketing_sends
  for select to authenticated using (is_admin());

commit;
