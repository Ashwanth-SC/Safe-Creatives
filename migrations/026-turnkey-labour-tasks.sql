-- ============================================================================
-- Migration 026 — Turnkey database: labour tasks
-- ============================================================================
--
-- Run ONCE, after 025-turnkey-labour.sql.
--
-- Adds a Task column to the labour table, chosen from a managed list
-- (turnkey_labour_tasks) that staff can add to / delete from — same pattern as
-- the labour category.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_labour_tasks (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

comment on table turnkey_labour_tasks is
  'Options for the Task dropdown on the labour table (Turnkey database window).';

alter table turnkey_labour add column if not exists task text;

create index if not exists turnkey_labour_task_idx on turnkey_labour (task);

alter table turnkey_labour_tasks enable row level security;
grant select, insert, update, delete on turnkey_labour_tasks to authenticated;

drop policy if exists turnkey_labour_tasks_admin_all on turnkey_labour_tasks;
create policy turnkey_labour_tasks_admin_all on turnkey_labour_tasks
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
