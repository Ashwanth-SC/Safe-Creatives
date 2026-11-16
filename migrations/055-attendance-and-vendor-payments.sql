-- ============================================================================
-- Migration 055 — Attendance log + Vendor payments
-- ============================================================================
--
-- Run ONCE, after 054.
--
-- Two internal ledgers for the Turnkey dashboard:
--
--   turnkey_attendance       — daily labour attendance: one row per person per
--                              day per project, with what we paid that person.
--                              Powers the "Attendance" tab (log a day's people +
--                              amounts) and its per-project / whole-history
--                              report + CSV export.
--
--   turnkey_vendor_payments  — money paid to a supplier/vendor against a
--                              project. Powers the "Vendor payments" tab.
--                              supplier_name is snapshotted so a payment still
--                              reads correctly if the supplier row is later
--                              deleted (supplier_id then goes null).
--
-- Both cascade-delete with their project (ON DELETE CASCADE): a project that has
-- issued receipts still can't be deleted (receipts are ON DELETE RESTRICT), so
-- these ledgers only ever cascade away with a project that had no receipts.
--
-- Money is stored in paise (bigint), matching turnkey_receipts.amount_paise.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Attendance
-- ---------------------------------------------------------------------------
create table if not exists turnkey_attendance (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references turnkey_projects (id) on delete cascade,
  work_date    date not null,
  person_name  text not null,
  amount_paise bigint,                 -- what we paid this person that day (optional)
  note         text,
  created_at   timestamptz not null default now()
);

comment on table turnkey_attendance is
  'Daily labour attendance per turnkey project — one row per person per day,
   with what we paid them (paise). Reported per project and across all history.';

create index if not exists turnkey_attendance_project_idx on turnkey_attendance (project_id);
create index if not exists turnkey_attendance_date_idx    on turnkey_attendance (work_date);

-- ---------------------------------------------------------------------------
-- Vendor payments
-- ---------------------------------------------------------------------------
create table if not exists turnkey_vendor_payments (
  id            uuid primary key default gen_random_uuid(),
  supplier_id   uuid references turnkey_suppliers (id) on delete set null,
  supplier_name text,                  -- snapshot of the vendor name at pay time
  project_id    uuid not null references turnkey_projects (id) on delete cascade,
  amount_paise  bigint not null,
  pay_date      date not null default current_date,
  note          text,
  created_at    timestamptz not null default now()
);

comment on table turnkey_vendor_payments is
  'Payments made to a supplier/vendor against a turnkey project (amount in paise).';

create index if not exists turnkey_vendor_payments_project_idx  on turnkey_vendor_payments (project_id);
create index if not exists turnkey_vendor_payments_supplier_idx on turnkey_vendor_payments (supplier_id);

-- ---------------------------------------------------------------------------
-- RLS — admins only
-- ---------------------------------------------------------------------------
alter table turnkey_attendance      enable row level security;
alter table turnkey_vendor_payments enable row level security;

grant select, insert, update, delete on turnkey_attendance      to authenticated;
grant select, insert, update, delete on turnkey_vendor_payments to authenticated;

drop policy if exists turnkey_attendance_admin_all on turnkey_attendance;
create policy turnkey_attendance_admin_all on turnkey_attendance
  for all to authenticated
  using (is_admin()) with check (is_admin());

drop policy if exists turnkey_vendor_payments_admin_all on turnkey_vendor_payments;
create policy turnkey_vendor_payments_admin_all on turnkey_vendor_payments
  for all to authenticated
  using (is_admin()) with check (is_admin());

commit;
