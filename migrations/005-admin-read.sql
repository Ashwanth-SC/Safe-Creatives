-- ============================================================================
-- Migration 005 — admin read access for the dashboard
-- ============================================================================
--
-- Run ONCE, after 004-gst-terms-address.sql.
--
-- Every customer-facing table is scoped to `user_id = auth.uid()`, which is
-- correct for customers and useless for you: without these policies the
-- dashboard would show an admin only their own registration, their own cart
-- and their own orders.
--
-- Deliberately SELECT only. An admin can read everything and write nothing
-- here: editing an order's totals from a screen would break the guarantee
-- that what is stored is what the server computed. Catalog tables are the
-- exception and already have admin write policies from migration 001.
--
-- is_admin() is security definer, so it reads profiles without re-triggering
-- the profiles policies. No recursion.
-- ============================================================================

begin;

-- Customers and their contact details
create policy profiles_admin_read on profiles
  for select to authenticated using (is_admin());

-- Carts, for the abandoned-cart follow-up list
create policy carts_admin_read on carts
  for select to authenticated using (is_admin());

create policy cart_items_admin_read on cart_items
  for select to authenticated using (is_admin());

create policy cart_item_options_admin_read on cart_item_options
  for select to authenticated using (is_admin());

create policy cart_item_addons_admin_read on cart_item_addons
  for select to authenticated using (is_admin());

-- Orders and their snapshot lines
create policy orders_admin_read on orders
  for select to authenticated using (is_admin());

create policy order_items_admin_read on order_items
  for select to authenticated using (is_admin());

create policy order_item_options_admin_read on order_item_options
  for select to authenticated using (is_admin());

create policy order_item_addons_admin_read on order_item_addons
  for select to authenticated using (is_admin());

-- Money
create policy payments_admin_read on payments
  for select to authenticated using (is_admin());

create policy refunds_admin_read on refunds
  for select to authenticated using (is_admin());

-- Who accepted which terms, and when
create policy terms_acceptances_admin_read on terms_acceptances
  for select to authenticated using (is_admin());

commit;


-- Check, signed in as an admin from the browser console:
--   await sb.from('profiles').select('email')      -- expect every customer
--   await sb.from('orders').select('order_number') -- expect every order
--
-- And as a non-admin customer, the same calls must still return only their
-- own rows. If they do not, one of these policies is too broad.
