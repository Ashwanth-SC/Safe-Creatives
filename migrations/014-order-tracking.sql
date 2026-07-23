-- ============================================================================
-- Migration 014 — customer order tracking
-- ============================================================================
--
-- Run ONCE, after 013-editable-catalog.sql.
--
-- Gives every order a customer-facing progress track, separate from the
-- payment-lifecycle `status` column (which the webhook owns). The admin
-- advances these milestones by hand from the dashboard; the customer sees them
-- on their "Track order" page.
--
--   fulfillment_stage    reserved -> confirmed | cancelled -> production
--                        -> dispatch -> delivered -> installed
--   installation_choice  undecided | in_house | self   (self = own carpenter,
--                        typically outside Chennai; installed milestone then
--                        does not apply)
--   confirmation_paid_at / dispatch_paid_at   the 2nd and 3rd installments,
--                        marked by the admin when received. The advance is the
--                        1st installment and is known from `status`/payments.
--
-- Money is deliberately NOT touched here. Column-level UPDATE grants below let
-- the admin edit only the four tracking columns, so totals stay server-computed
-- and unreachable from any browser.
-- ============================================================================

begin;

alter table orders
  add column if not exists fulfillment_stage    text not null default 'reserved',
  add column if not exists installation_choice  text not null default 'undecided',
  add column if not exists confirmation_paid_at  timestamptz,
  add column if not exists dispatch_paid_at       timestamptz;

alter table orders drop constraint if exists orders_fulfillment_stage_chk;
alter table orders add constraint orders_fulfillment_stage_chk
  check (fulfillment_stage in
    ('reserved', 'confirmed', 'cancelled', 'production', 'dispatch',
     'delivered', 'installed'));

alter table orders drop constraint if exists orders_installation_choice_chk;
alter table orders add constraint orders_installation_choice_chk
  check (installation_choice in ('undecided', 'in_house', 'self'));


-- ---------------------------------------------------------------------------
-- Admin edits the tracking columns from the dashboard
-- ---------------------------------------------------------------------------
-- The RLS policy limits UPDATE to admins; the column-level GRANT limits it to
-- exactly these four columns. Both gates must pass, so an admin can advance a
-- milestone but cannot rewrite a total from the browser.

drop policy if exists orders_admin_update on orders;
create policy orders_admin_update on orders
  for update to authenticated using (is_admin()) with check (is_admin());

grant update (fulfillment_stage, installation_choice, confirmation_paid_at, dispatch_paid_at)
  on orders to authenticated;


-- ---------------------------------------------------------------------------
-- Customer picks their own installation preference
-- ---------------------------------------------------------------------------
-- No customer UPDATE policy exists on orders, so this SECURITY DEFINER function
-- is the only way a customer can change anything — and it writes just the one
-- column, only on their own order.

create or replace function set_installation_choice(p_order uuid, p_choice text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_choice not in ('undecided', 'in_house', 'self') then
    raise exception 'Invalid installation choice: %', p_choice;
  end if;

  update orders
     set installation_choice = p_choice
   where id = p_order and user_id = auth.uid();

  if not found then
    raise exception 'Order not found for the current user';
  end if;
end;
$$;

grant execute on function set_installation_choice(uuid, text) to authenticated;

commit;


-- Check:
-- select order_number, status, fulfillment_stage, installation_choice,
--        confirmation_paid_at, dispatch_paid_at from orders order by placed_at desc;
