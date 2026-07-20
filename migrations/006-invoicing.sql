-- ============================================================================
-- Migration 006 — GST invoicing
-- ============================================================================
--
-- Run ONCE, after 005-admin-read.sql.
--
-- Invoice number format:  SCSR-27-01-1-001   (16 characters)
--
--   SCSR  Safe Creatives / Sensory Rooms
--   27    financial year ENDING year. FY 2026-27 is "27". Indian FY runs
--         April to March, and Rule 46(b) requires the series to be unique per
--         financial year -- a calendar year would put March and April 2027
--         invoices in the same series when they belong to different ones.
--   01    customer number, assigned in registration order
--   1     payment phase for that customer: 1 advance, 2 first instalment,
--         3 handover, and so on
--   001   global invoice sequence for the financial year, independent of
--         customer, phase or order
--
-- Sixteen characters is the legal maximum. This format uses all sixteen, so
-- it breaks when a customer number reaches three digits or the sequence
-- reaches four. Both are years away; neither is decades away. When you get
-- close, drop the SR segment rather than exceeding the limit.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Customer numbers
-- ---------------------------------------------------------------------------

create sequence if not exists customer_number_seq start 1;

alter table profiles add column if not exists customer_number integer;
alter table profiles add column if not exists gstin text;

-- Existing customers get numbers in the order they registered, so the
-- sequence reflects history rather than the order of this UPDATE.
with ordered as (
  select id, row_number() over (order by created_at) as rn
  from profiles
  where customer_number is null
)
update profiles p
set customer_number = ordered.rn
from ordered
where p.id = ordered.id;

-- Move the sequence past whatever was just assigned.
select setval(
  'customer_number_seq',
  greatest((select coalesce(max(customer_number), 0) from profiles), 1)
);

alter table profiles
  alter column customer_number set default nextval('customer_number_seq');

create unique index if not exists profiles_customer_number_key
  on profiles (customer_number);

-- A GSTIN is 15 characters: 2 state code, 10 PAN, 1 entity, 1 'Z', 1 check.
-- Optional, because most customers are individuals who do not have one.
alter table profiles add constraint profiles_gstin_format
  check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$');

-- New signups get their number automatically.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name, customer_number)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', ''),
    nextval('customer_number_seq')
  )
  on conflict (id) do nothing;
  return new;
exception
  when others then
    raise warning 'handle_new_user failed for %: %', new.id, sqlerrm;
    return new;
end;
$$;


-- ---------------------------------------------------------------------------
-- 2. HSN codes
-- ---------------------------------------------------------------------------
-- On all three levels. Invoice LINES are drawn per package and per add-on,
-- because that is how the price is actually composed -- a product inside a
-- package has no standalone price. Product HSN is carried for reference and
-- for the line description.

alter table packages         add column if not exists hsn_code text;
alter table package_products add column if not exists hsn_code text;
alter table package_addons   add column if not exists hsn_code text;

-- Snapshot onto orders, so an invoice raised later uses the HSN that applied
-- when the order was placed rather than whatever admin says today.
alter table order_items       add column if not exists hsn_code text;
alter table order_item_addons add column if not exists hsn_code text;


-- ---------------------------------------------------------------------------
-- 3. Seller settings
-- ---------------------------------------------------------------------------
-- Single row. Every mandatory supplier field from Rule 46 lives here rather
-- than being hardcoded, so a change of address does not mean a code change.

create table if not exists seller_settings (
  id               boolean primary key default true check (id),
  legal_name       text not null,
  trade_name       text,
  gstin            text,
  pan              text,
  address_line     text not null,
  city             text not null,
  state_name       text not null,
  state_code       text not null,
  pin_code         text not null,
  email            text,
  phone            text,
  bank_name        text,
  bank_account     text,
  bank_ifsc        text,
  updated_at       timestamptz not null default now()
);

insert into seller_settings (
  id, legal_name, trade_name, address_line, city,
  state_name, state_code, pin_code, email, phone
) values (
  true, 'Safe Creatives', 'Safe Creatives',
  'Address line — set this before issuing invoices', 'Chennai',
  'Tamil Nadu', '33', '600001',
  'ashwanth@safecreatives.com', '+919789890877'
) on conflict (id) do nothing;


-- ---------------------------------------------------------------------------
-- 4. Invoices
-- ---------------------------------------------------------------------------
-- Every party detail is snapshotted. An invoice is a legal document: it must
-- read the same in five years regardless of what has changed since.

create table if not exists invoices (
  id             uuid primary key default gen_random_uuid(),
  invoice_number text not null unique,

  order_id       uuid references orders(id) on delete restrict,
  user_id        uuid not null references profiles(id) on delete restrict,

  -- Components, kept separately so they can be queried without parsing.
  financial_year   text not null,          -- '2026-27'
  fy_short         text not null,          -- '27'
  customer_number  integer not null,
  phase_number     integer not null,
  sequence_number  integer not null,

  phase_label    text,                     -- 'Advance', 'First instalment'
  issue_date     date not null default current_date,

  -- Supplier snapshot
  seller_name       text not null,
  seller_gstin      text,
  seller_address    text not null,
  seller_state_name text not null,
  seller_state_code text not null,

  -- Recipient snapshot
  buyer_name       text not null,
  buyer_gstin      text,
  buyer_address    text not null,
  buyer_state_name text,
  buyer_state_code text,
  buyer_email      text,
  buyer_phone      text,

  -- Place of supply decides the tax split, so it is recorded explicitly.
  place_of_supply_state text not null,
  place_of_supply_code  text not null,
  is_interstate         boolean not null default false,

  taxable_value_paise bigint not null default 0,
  cgst_paise          bigint not null default 0,
  sgst_paise          bigint not null default 0,
  igst_paise          bigint not null default 0,
  total_paise         bigint not null default 0,

  reverse_charge boolean not null default false,
  notes          text,
  created_at     timestamptz not null default now(),

  -- Intra-state uses CGST+SGST, inter-state uses IGST. Never both.
  constraint invoices_tax_split check (
    (is_interstate and cgst_paise = 0 and sgst_paise = 0)
    or (not is_interstate and igst_paise = 0)
  )
);

create index if not exists invoices_user_idx on invoices (user_id, issue_date desc);
create index if not exists invoices_order_idx on invoices (order_id);

create table if not exists invoice_lines (
  id                  uuid primary key default gen_random_uuid(),
  invoice_id          uuid not null references invoices(id) on delete cascade,
  line_number         integer not null,
  description         text not null,
  detail              text,               -- products, sizes, colours
  hsn_code            text,
  quantity            numeric(12,2) not null default 1,
  unit                text not null default 'NOS',
  unit_price_paise    bigint not null,
  taxable_value_paise bigint not null,
  gst_rate            numeric(5,2) not null default 18,
  cgst_paise          bigint not null default 0,
  sgst_paise          bigint not null default 0,
  igst_paise          bigint not null default 0,
  line_total_paise    bigint not null,
  unique (invoice_id, line_number)
);


-- ---------------------------------------------------------------------------
-- 5. Number generation
-- ---------------------------------------------------------------------------

create table if not exists invoice_counters (
  financial_year text primary key,
  last_sequence  integer not null default 0
);

-- Indian financial year runs April to March. Returns e.g. '2026-27'.
create or replace function financial_year_of(d date)
returns text
language sql
immutable
as $$
  select case
    when extract(month from d) >= 4
      then extract(year from d)::int || '-' || right((extract(year from d)::int + 1)::text, 2)
    else (extract(year from d)::int - 1) || '-' || right(extract(year from d)::text, 2)
  end;
$$;

-- Allocates the next number atomically. The INSERT ... ON CONFLICT DO UPDATE
-- takes a row lock, so two invoices raised at the same instant cannot receive
-- the same sequence -- which for a legal document is not a tolerable race.
create or replace function next_invoice_number(p_user_id uuid)
returns table (
  invoice_number  text,
  financial_year  text,
  fy_short        text,
  customer_number integer,
  phase_number    integer,
  sequence_number integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fy       text;
  v_fy_short text;
  v_cust     integer;
  v_phase    integer;
  v_seq      integer;
begin
  v_fy := financial_year_of(current_date);
  v_fy_short := right(v_fy, 2);

  select p.customer_number into v_cust from profiles p where p.id = p_user_id;
  if v_cust is null then
    raise exception 'Customer % has no customer_number', p_user_id;
  end if;

  -- Phase counts this customer's invoices, so their first is 1, second is 2.
  select count(*) + 1 into v_phase from invoices i where i.user_id = p_user_id;

  insert into invoice_counters (financial_year, last_sequence)
  values (v_fy, 1)
  on conflict (financial_year)
    do update set last_sequence = invoice_counters.last_sequence + 1
  returning last_sequence into v_seq;

  return query select
    'SCSR-' || v_fy_short || '-' ||
      lpad(v_cust::text, 2, '0') || '-' ||
      v_phase::text || '-' ||
      lpad(v_seq::text, 3, '0'),
    v_fy, v_fy_short, v_cust, v_phase, v_seq;
end;
$$;


-- ---------------------------------------------------------------------------
-- 6. RLS and grants
-- ---------------------------------------------------------------------------

alter table invoices        enable row level security;
alter table invoice_lines   enable row level security;
alter table seller_settings enable row level security;
alter table invoice_counters enable row level security;

-- Customers read their own invoices and never write them.
create policy invoices_select_own on invoices
  for select to authenticated using (user_id = auth.uid());

create policy invoice_lines_select_own on invoice_lines
  for select to authenticated using (
    exists (select 1 from invoices i where i.id = invoice_id and i.user_id = auth.uid())
  );

create policy invoices_admin_read on invoices
  for select to authenticated using (is_admin());

create policy invoice_lines_admin_read on invoice_lines
  for select to authenticated using (is_admin());

-- Seller details are printed on every invoice, so they are world-readable.
create policy seller_settings_read on seller_settings
  for select to anon, authenticated using (true);

create policy seller_settings_admin_write on seller_settings
  for all to authenticated using (is_admin()) with check (is_admin());

-- invoice_counters has RLS on and no policies: nothing but service_role may
-- touch it. A client that could edit the counter could mint duplicate
-- invoice numbers.

grant select on invoices, invoice_lines, seller_settings to authenticated;
grant select on seller_settings to anon;
grant insert, update on seller_settings to authenticated;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
grant execute on function next_invoice_number(uuid) to service_role;

commit;


-- Check:
-- select email, customer_number, gstin from profiles order by customer_number;
-- select * from seller_settings;
-- select * from next_invoice_number('<a user id>');   -- consumes a sequence number
