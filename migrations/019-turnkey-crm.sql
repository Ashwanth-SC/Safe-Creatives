-- ============================================================================
-- Migration 019 — Turnkey Solutions CRM (leads/projects + receipts)
-- ============================================================================
--
-- Run ONCE, after 018-installment-payments-and-refunds.sql.
--
-- Adds the Turnkey side of the business to the database:
--
--   turnkey_projects  — one row per lead / project. Each gets the next running
--                       number (the "customer number", continuing from 28, so
--                       the first new row is 29). The SAME client can appear in
--                       several rows (one per project); that is intentional per
--                       the chosen "number per project/lead" model.
--
--   turnkey_receipts  — every payment the company receives against a project.
--                       Client + project details are SNAPSHOT onto the receipt
--                       at creation, so a later edit to the project never
--                       rewrites a receipt that has already been issued
--                       (same principle as orders snapshotting the catalog).
--
-- Money is stored in PAISE as bigint, matching the rest of the schema.
--
-- Access: staff only. Every policy is gated on is_admin(). The public enquiry
-- form does NOT write here directly — it goes through an Edge Function using
-- service_role (which bypasses RLS), so anon never touches these tables.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Running numbers
-- ---------------------------------------------------------------------------
-- The lead/customer counter continues from the 28 already handled offline, so
-- the next new project is number 29.
create sequence if not exists turnkey_project_number_seq start 29;

-- Receipts get their own clean, sequential number for the financial record.
create sequence if not exists turnkey_receipt_number_seq start 1;


-- ---------------------------------------------------------------------------
-- turnkey_projects — the lead / project register
-- ---------------------------------------------------------------------------
create table if not exists turnkey_projects (
  id             uuid primary key default gen_random_uuid(),

  -- The visible running number (29, 30, 31 ...). Unique and never reused.
  project_number integer not null unique
                 default nextval('turnkey_project_number_seq'),

  -- Client contact. Held on the row itself (flat model) so the same client can
  -- appear across several numbered rows, one per project.
  client_name    text not null,
  client_phone   text,
  client_email   text,                       -- the web form doesn't collect it;
                                             -- staff can add it later.

  -- How the lead reached us. Standard options are website / meta / referral /
  -- word of mouth, but the column stays free text so a new channel (e.g. a new
  -- ad platform) can be added from the dashboard without a migration.
  platform       text not null default 'website',

  -- A unique, human name for the project. Null until staff name it (fresh web
  -- leads arrive unnamed). Postgres allows many NULLs under a UNIQUE index, so
  -- unnamed leads don't collide with each other.
  project_name   text unique,

  -- The initially confirmed budget, in paise.
  budget_paise   bigint check (budget_paise is null or budget_paise >= 0),

  site_address   text,

  status         text not null default 'Lead'
                 check (status in (
                   'Lead',
                   'Closed',
                   'Design initiated',
                   'DSO',
                   'Execution commenced',
                   'Handed over'
                 )),

  -- Qualification details captured by the public enquiry form. Kept for the
  -- follow-up call; not all are relevant to a manually-added lead.
  pin_code         text,
  area_sqft        numeric,
  project_category text,                     -- 'Residential' / 'Commercial'
  requirement      text,                     -- 'Interior consultation' etc.

  source           text not null default 'manual'   -- 'website' | 'manual'
                   check (source in ('website', 'manual')),
  notes            text,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table turnkey_projects is
  'Turnkey leads/projects. One row per project; project_number is the running
   customer/lead number continuing from 28. Web-form leads are inserted by an
   Edge Function; staff add and edit rows from the Turnkey dashboard.';

create index if not exists turnkey_projects_created_idx
  on turnkey_projects (created_at desc);
create index if not exists turnkey_projects_status_idx
  on turnkey_projects (status);


-- ---------------------------------------------------------------------------
-- turnkey_receipts — money received against a project
-- ---------------------------------------------------------------------------
create table if not exists turnkey_receipts (
  id             uuid primary key default gen_random_uuid(),

  receipt_number text not null unique
                 default 'SC-RCPT-'
                         || lpad(nextval('turnkey_receipt_number_seq')::text, 4, '0'),

  project_id     uuid not null references turnkey_projects(id) on delete restrict,

  amount_paise   bigint not null check (amount_paise > 0),
  receipt_date   date   not null default current_date,
  receipt_name   text   not null,            -- 'Advance', 'Milestone 1', ...
  payment_mode   text   not null,            -- 'Cash', 'UPI', 'Bank transfer', ...

  -- Snapshot of who/what this receipt is for, frozen at issue time so editing
  -- the project later never alters an issued receipt.
  client_name    text not null,
  client_phone   text,
  project_name   text,
  site_address   text,

  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table turnkey_receipts is
  'One row per payment received against a turnkey project. Client/project fields
   are snapshot at creation; the printable receipt renders from this row.';

create index if not exists turnkey_receipts_project_idx
  on turnkey_receipts (project_id, receipt_date desc);


-- ---------------------------------------------------------------------------
-- updated_at triggers (touch_updated_at() already exists)
-- ---------------------------------------------------------------------------
drop trigger if exists turnkey_projects_touch on turnkey_projects;
create trigger turnkey_projects_touch
  before update on turnkey_projects
  for each row execute function touch_updated_at();

drop trigger if exists turnkey_receipts_touch on turnkey_receipts;
create trigger turnkey_receipts_touch
  before update on turnkey_receipts
  for each row execute function touch_updated_at();


-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_projects enable row level security;
alter table turnkey_receipts enable row level security;

-- Grants: the browser 'authenticated' role may touch these tables, but RLS
-- below narrows that to admins only. service_role (Edge Functions) bypasses RLS.
grant select, insert, update, delete on turnkey_projects to authenticated;
grant select, insert, update, delete on turnkey_receipts to authenticated;

-- Inserts default to nextval() on these sequences, so an admin insert from the
-- browser needs usage on them (service_role already has all sequences).
grant usage, select on sequence turnkey_project_number_seq to authenticated;
grant usage, select on sequence turnkey_receipt_number_seq to authenticated;

-- Unlike orders (read-only from the browser), the CRM is fully managed by staff
-- in the dashboard, so admins get full read/write here.
create policy turnkey_projects_admin_all on turnkey_projects
  for all to authenticated
  using (is_admin()) with check (is_admin());

create policy turnkey_receipts_admin_all on turnkey_receipts
  for all to authenticated
  using (is_admin()) with check (is_admin());

commit;


-- Checks, signed in as an admin from the browser console:
--   await sb.from('turnkey_projects').insert({ client_name: 'Test lead' }).select()
--     -> row comes back with project_number = 29 (then 30, 31 ...)
--   await sb.from('turnkey_projects').select('project_number, client_name, status')
--   await sb.from('turnkey_receipts').insert({
--          project_id: '<id>', amount_paise: 500000, receipt_name: 'Advance',
--          payment_mode: 'UPI', client_name: 'Test lead' }).select()
--     -> row comes back with receipt_number = 'SC-RCPT-0001'
--
-- As a non-admin (or logged out) the same selects must return nothing.
