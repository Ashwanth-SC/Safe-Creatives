-- ============================================================================
-- Migration 001 — colours become generic option groups
-- ============================================================================
--
-- Run this ONCE against an existing database. Fresh installs get the same
-- shape from database-schema.sql and should not run this file.
--
-- Why: product_colours was colour-specific. Adding Size would have meant a
-- parallel product_sizes table duplicating every column and every code path,
-- and a third axis later would mean a third. One generic model instead:
--
--   package_products      "Restful Bed Frame"
--     product_option_groups   "Size"          "Colour"
--       product_options         Queen  +₹0      Sand +₹0
--                               King   +₹18k    Teal +₹4k
--
-- Existing colour data is copied across, not discarded. Carts and orders keep
-- their selections.
--
-- Wrapped in a transaction: if any step fails nothing is applied.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Admin flag
-- ---------------------------------------------------------------------------

alter table profiles
  add column if not exists is_admin boolean not null default false;

comment on column profiles.is_admin is
  'Grants write access to catalog tables via RLS. Set manually in SQL; there
   is deliberately no UI for granting it.';

-- security definer so the policy can read profiles without triggering the
-- profiles policies recursively.
create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select p.is_admin from profiles p where p.id = auth.uid()), false);
$$;


-- ---------------------------------------------------------------------------
-- 2. New catalog tables
-- ---------------------------------------------------------------------------

create table product_option_groups (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references package_products(id) on delete cascade,
  key        text not null,                      -- 'size', 'colour'
  name       text not null,                      -- 'Size', 'Colour'
  -- How the configurator should render this group. A group the page has never
  -- seen still renders sensibly rather than disappearing.
  display_as text not null default 'chip'
             check (display_as in ('swatch', 'chip', 'dropdown')),
  is_required boolean not null default true,
  sort_order integer not null default 0,
  unique (product_id, key)
);

create table product_options (
  id                uuid primary key default gen_random_uuid(),
  group_id          uuid not null references product_option_groups(id) on delete cascade,
  key               text not null,
  name              text not null,
  description       text,
  price_delta_paise bigint not null default 0,

  -- Presentation. Colours use all of these; sizes typically use none.
  image_path        text,
  swatch_hex        text check (swatch_hex is null or swatch_hex ~ '^#[0-9a-fA-F]{6}$'),
  finish            text,
  material          text,

  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  unique (group_id, key)
);

create index product_options_group_idx on product_options (group_id);

create table cart_item_options (
  id           uuid primary key default gen_random_uuid(),
  cart_item_id uuid not null references cart_items(id) on delete cascade,
  group_id     uuid not null references product_option_groups(id) on delete restrict,
  option_id    uuid not null references product_options(id) on delete restrict,
  unique (cart_item_id, group_id)                -- one choice per group
);

create index cart_item_options_item_idx on cart_item_options (cart_item_id);

create table order_item_options (
  id                uuid primary key default gen_random_uuid(),
  order_item_id     uuid not null references order_items(id) on delete cascade,
  product_name      text not null,
  group_name        text not null,
  option_name       text not null,
  finish            text,
  material          text,
  price_delta_paise bigint not null default 0
);

create index order_item_options_item_idx on order_item_options (order_item_id);


-- ---------------------------------------------------------------------------
-- 3. Copy existing colour data across
-- ---------------------------------------------------------------------------

-- One "Colour" group per product that had colours.
insert into product_option_groups (product_id, key, name, display_as, sort_order)
select distinct pc.product_id, 'colour', 'Colour', 'swatch', 2
from product_colours pc;

-- Each colour becomes an option in its product's Colour group.
insert into product_options (
  group_id, key, name, price_delta_paise,
  image_path, swatch_hex, finish, material, is_active, sort_order
)
select
  g.id, pc.key, pc.name, pc.price_delta_paise,
  pc.image_path, pc.swatch_hex, pc.finish, pc.material, pc.is_active, pc.sort_order
from product_colours pc
join product_option_groups g
  on g.product_id = pc.product_id and g.key = 'colour';

-- Cart selections.
insert into cart_item_options (cart_item_id, group_id, option_id)
select
  cic.cart_item_id,
  g.id,
  o.id
from cart_item_colours cic
join product_colours pc on pc.id = cic.colour_id
join product_option_groups g
  on g.product_id = pc.product_id and g.key = 'colour'
join product_options o
  on o.group_id = g.id and o.key = pc.key
on conflict (cart_item_id, group_id) do nothing;

-- Order snapshots. These are plain text already, so they just move across.
insert into order_item_options (
  order_item_id, product_name, group_name, option_name,
  finish, material, price_delta_paise
)
select
  oic.order_item_id, oic.product_name, 'Colour', oic.colour_name,
  oic.finish, oic.material, oic.price_delta_paise
from order_item_colours oic;


-- ---------------------------------------------------------------------------
-- 4. Rebuild the totals views against options
-- ---------------------------------------------------------------------------

drop view if exists cart_totals;
drop view if exists cart_item_totals;

create view cart_item_totals with (security_invoker = true) as
select
  ci.id                                        as cart_item_id,
  ci.cart_id,
  p.id                                         as package_id,
  p.key                                        as package_key,
  p.name                                       as package_name,
  p.base_price_paise,
  coalesce(option_delta.total, 0)              as options_paise,
  coalesce(addon_total.total, 0)               as addons_paise,
  p.base_price_paise
    + coalesce(option_delta.total, 0)
    + coalesce(addon_total.total, 0)           as line_total_paise
from cart_items ci
join packages p on p.id = ci.package_id
left join lateral (
  select sum(po.price_delta_paise) as total
  from cart_item_options cio
  join product_options po on po.id = cio.option_id
  where cio.cart_item_id = ci.id
) option_delta on true
left join lateral (
  select sum(pa.price_paise) as total
  from cart_item_addons cia
  join package_addons pa on pa.id = cia.addon_id
  where cia.cart_item_id = ci.id
) addon_total on true;

create view cart_totals with (security_invoker = true) as
select
  c.id      as cart_id,
  c.user_id,
  count(cit.cart_item_id)                        as item_count,
  coalesce(sum(cit.line_total_paise), 0)::bigint as subtotal_paise
from carts c
left join cart_item_totals cit on cit.cart_id = c.id
group by c.id, c.user_id;


-- ---------------------------------------------------------------------------
-- 5. Retire the old tables
-- ---------------------------------------------------------------------------
-- Only reached if every copy above succeeded, because of the transaction.

drop table cart_item_colours;
drop table order_item_colours;
drop table product_colours;


-- ---------------------------------------------------------------------------
-- 6. RLS and grants for the new tables
-- ---------------------------------------------------------------------------

alter table product_option_groups enable row level security;
alter table product_options       enable row level security;
alter table cart_item_options     enable row level security;
alter table order_item_options    enable row level security;

-- Catalog: readable by anyone, writable only by admins.
create policy option_groups_public_read on product_option_groups
  for select to anon, authenticated using (
    exists (
      select 1 from package_products pp
      join packages p on p.id = pp.package_id
      where pp.id = product_id and p.is_active
    )
  );

create policy options_public_read on product_options
  for select to anon, authenticated using (is_active);

create policy option_groups_admin_write on product_option_groups
  for all to authenticated using (is_admin()) with check (is_admin());

create policy options_admin_write on product_options
  for all to authenticated using (is_admin()) with check (is_admin());

-- Cart selections: owner only, same shape as cart_item_addons.
create policy cart_item_options_own on cart_item_options
  for all to authenticated
  using (
    exists (
      select 1 from cart_items ci
      join carts c on c.id = ci.cart_id
      where ci.id = cart_item_id and c.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from cart_items ci
      join carts c on c.id = ci.cart_id
      where ci.id = cart_item_id and c.user_id = auth.uid()
    )
  );

-- Order snapshots: read your own, never write.
create policy order_item_options_select_own on order_item_options
  for select to authenticated using (
    exists (
      select 1 from order_items oi
      join orders o on o.id = oi.order_id
      where oi.id = order_item_id and o.user_id = auth.uid()
    )
  );


-- Admin write access on the rest of the catalog. Read policies already exist.
create policy packages_admin_write on packages
  for all to authenticated using (is_admin()) with check (is_admin());

create policy package_products_admin_write on package_products
  for all to authenticated using (is_admin()) with check (is_admin());

create policy package_addons_admin_write on package_addons
  for all to authenticated using (is_admin()) with check (is_admin());


-- Grants. RLS decides which rows; these decide whether the role may touch the
-- table at all. Both are required.
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;

grant select on product_option_groups, product_options to anon, authenticated;
grant insert, update, delete on
  packages, package_products, package_addons,
  product_option_groups, product_options
  to authenticated;

grant select, insert, update, delete on cart_item_options to authenticated;
grant select on order_item_options to authenticated;
grant select on cart_item_totals, cart_totals to authenticated;

commit;


-- ---------------------------------------------------------------------------
-- Make yourself an admin (run separately, after the transaction)
-- ---------------------------------------------------------------------------
-- update profiles set is_admin = true where email = 'ashwanth@safecreatives.com';
