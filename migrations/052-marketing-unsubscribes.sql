-- ============================================================================
-- Migration 052 — marketing unsubscribes (one-click opt-out)
-- ============================================================================
--
-- Run ONCE, after 051.
--
-- Emails that have opted out of marketing. The public `unsubscribe` edge
-- function inserts a row (service role) when someone clicks the one-click
-- link in a marketing email; `send-marketing-email` excludes every address
-- listed here from both the recipient count and the send.
--
-- Emails are stored lower-cased. Admins can read the list (for a count); the
-- writes happen through the service role, so no insert policy is needed.
-- ============================================================================

begin;

create table if not exists marketing_unsubscribes (
  email      text primary key,
  created_at timestamptz not null default now()
);

comment on table marketing_unsubscribes is
  'Emails opted out of marketing. send-marketing-email skips them; rows are
   written by the public unsubscribe edge function via the service role.';

alter table marketing_unsubscribes enable row level security;

grant select on marketing_unsubscribes to authenticated;

drop policy if exists marketing_unsub_admin_read on marketing_unsubscribes;
create policy marketing_unsub_admin_read on marketing_unsubscribes
  for select to authenticated using (is_admin());

commit;
