-- ============================================================================
-- Migration 004 — structured address, GST, flat advance, terms acceptance
-- ============================================================================
--
-- Run ONCE, after 003-cover-and-defaults.sql.
--
-- Four changes:
--
--   1. Address becomes three fields. A single text blob cannot be sorted by
--      city or grouped by PIN, which you will want the moment you are
--      routing more than a few installations.
--
--   2. GST is stored, not derived at render time. An order placed today must
--      still show 18% in three years if the rate changes, so the rate lives
--      on the row alongside the amount it produced.
--
--   3. The advance becomes a flat ₹8,999 rather than a percentage.
--
--   4. Terms are versioned and acceptance is recorded. "They ticked a box"
--      is worth little without knowing WHICH text they ticked it against.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Structured address
-- ---------------------------------------------------------------------------

alter table profiles add column if not exists address_line text;
alter table profiles add column if not exists city         text;
alter table profiles add column if not exists pin_code     text;

update profiles set address_line = address
where address is not null and address <> '' and address_line is null;

alter table profiles drop column if exists address;

alter table orders add column if not exists delivery_address_line text;
alter table orders add column if not exists delivery_city         text;
alter table orders add column if not exists delivery_pin_code     text;

update orders set delivery_address_line = delivery_address
where delivery_address_line is null;

alter table orders alter column delivery_address drop not null;


-- ---------------------------------------------------------------------------
-- 2. GST and flat advance
-- ---------------------------------------------------------------------------
-- balance_paise is generated, and a generated column cannot be redefined in
-- place, so it is dropped and rebuilt against the new total.

alter table orders drop column if exists balance_paise;

alter table orders add column if not exists gst_percent numeric(5,2) not null default 18;
alter table orders add column if not exists gst_paise   bigint not null default 0;
alter table orders add column if not exists total_paise bigint not null default 0;

-- Backfill existing orders at the current rate.
update orders
set gst_paise   = round(subtotal_paise * 0.18),
    total_paise = subtotal_paise + round(subtotal_paise * 0.18)
where total_paise = 0;

alter table orders
  add column balance_paise bigint
  generated always as (total_paise - advance_amount_paise) stored;

-- The advance is now a flat fee, so a percentage no longer describes it.
alter table orders drop column if exists advance_percent;

comment on column orders.advance_amount_paise is
  'Flat refundable reservation fee, GST inclusive. Set by ADVANCE_PAISE in
   the create-order function, not derived from the order total.';


-- ---------------------------------------------------------------------------
-- 3. Terms and conditions
-- ---------------------------------------------------------------------------

create table if not exists terms_versions (
  id           uuid primary key default gen_random_uuid(),
  version      text not null unique,
  body         text not null,
  is_current   boolean not null default false,
  published_at timestamptz not null default now()
);

-- Exactly one current version, enforced rather than remembered.
create unique index if not exists terms_versions_one_current
  on terms_versions ((is_current)) where is_current;

create table if not exists terms_acceptances (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references profiles(id) on delete cascade,
  terms_version_id uuid not null references terms_versions(id) on delete restrict,
  order_id         uuid references orders(id) on delete set null,
  accepted_at      timestamptz not null default now()
);

create index if not exists terms_acceptances_user_idx on terms_acceptances (user_id);

comment on table terms_acceptances is
  'One row per acceptance. Deliberately append-only and never updated: the
   record of what someone agreed to, and when, must not be editable after
   the fact. order_id is nullable so an acceptance can outlive a cancelled
   order.';

-- Placeholder text. Replace the body via SQL or the admin page later; publish
-- a NEW version rather than editing this one, so past acceptances keep
-- pointing at the text that was actually agreed to.
insert into terms_versions (version, body, is_current)
values (
  'v1',
  'These are placeholder terms and conditions for Safe Creatives.

The reservation advance of ₹8,999 is refundable and inclusive of GST. It secures your order and covers the site verification visit. Following verification, our team will confirm the final scope, schedule and balance payable.

All package prices are exclusive of GST, which is charged at 18% and shown separately at review.

This text is a placeholder and does not constitute the final agreement.',
  true
)
on conflict (version) do nothing;


-- ---------------------------------------------------------------------------
-- 4. RLS and grants
-- ---------------------------------------------------------------------------

alter table terms_versions    enable row level security;
alter table terms_acceptances enable row level security;

-- Anyone may read the terms; only admins may publish them.
create policy terms_versions_public_read on terms_versions
  for select to anon, authenticated using (true);

create policy terms_versions_admin_write on terms_versions
  for all to authenticated using (is_admin()) with check (is_admin());

-- Customers may read their own acceptances and nothing else. Writes happen
-- in create-order under service_role: a browser that could insert here could
-- fabricate a record of agreeing to terms it never saw.
create policy terms_acceptances_select_own on terms_acceptances
  for select to authenticated using (user_id = auth.uid());

grant select on terms_versions to anon, authenticated;
grant insert, update, delete on terms_versions to authenticated;
grant select on terms_acceptances to authenticated;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

commit;


-- Check:
-- select version, is_current, left(body, 40) from terms_versions;
-- select email, address_line, city, pin_code from profiles;
-- select order_number, subtotal_paise, gst_paise, total_paise,
--        advance_amount_paise, balance_paise from orders order by placed_at desc;
