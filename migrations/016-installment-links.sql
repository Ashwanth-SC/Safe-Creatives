-- ============================================================================
-- Migration 016 — installment payment links
-- ============================================================================
--
-- Run ONCE, after 015-order-revision.sql.
--
-- The advance is collected at checkout (existing flow). The 2nd (80%) and 3rd
-- (20%) installments are collected via Razorpay Payment Links that the admin
-- sends from the dashboard. This table tracks each link so the webhook can
-- match a `payment_link.paid` event back to the right order and installment,
-- mark it paid, and email the customer a receipt.
--
-- Rows are written under service_role (the create-installment-link function and
-- the webhook); admins read them in the dashboard.
-- ============================================================================

begin;

create table if not exists installment_links (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  phase               text not null check (phase in ('confirmation', 'dispatch')),
  provider            text not null default 'razorpay',
  provider_link_id    text unique,          -- Razorpay plink_… id
  provider_payment_id text,                 -- the pay_… once paid
  amount_paise        bigint not null check (amount_paise > 0),
  short_url           text,
  status              text not null default 'created'
                      check (status in ('created', 'paid', 'cancelled')),
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);

create index if not exists installment_links_order_idx on installment_links (order_id);

alter table installment_links enable row level security;

-- Admins read them in the dashboard; all writes happen under service_role,
-- which bypasses RLS.
drop policy if exists installment_links_admin_read on installment_links;
create policy installment_links_admin_read on installment_links
  for select to authenticated using (is_admin());

grant select on installment_links to authenticated;
grant all privileges on installment_links to service_role;

commit;
