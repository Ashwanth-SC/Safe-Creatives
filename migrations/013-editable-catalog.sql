-- ============================================================================
-- Migration 013 — let the catalog be edited freely
-- ============================================================================
--
-- Run ONCE, after 012-terms-v2.sql.
--
-- Why a product/size/colour/add-on/package could not be deleted:
--
--   * ORDERS never blocked it. order_items and order_item_* store plain-text
--     snapshots (names, prices) with NO foreign keys back to the catalog, so
--     deleting catalog rows leaves order history untouched.
--
--   * CARTS did. cart_items and cart_item_* point at the live catalog with
--     ON DELETE RESTRICT, so a single abandoned cart holding a product was
--     enough to refuse the delete — which looked like a hard "minimum" that
--     could not be crossed.
--
-- Carts are transient shopping state and are re-validated at checkout, so they
-- should never stop an admin from shaping the catalog. Switch the cart-side
-- foreign keys to ON DELETE CASCADE: deleting a catalog row now quietly drops
-- it from any live cart instead of being refused.
--
-- The friendly minimums (>=2 packages, >=1 product, >=1 size, >=1 colour,
-- >=1 add-on) are enforced in the admin UI (admin.js), not here — the database
-- only guarantees integrity, not merchandising rules.
-- ============================================================================

begin;

-- Deleting a package clears it from any cart that still held it.
alter table cart_items
  drop constraint if exists cart_items_package_id_fkey,
  add  constraint cart_items_package_id_fkey
    foreign key (package_id) references packages(id) on delete cascade;

-- Deleting a size/colour (both are product_options) or its group clears the
-- matching cart line detail.
alter table cart_item_options
  drop constraint if exists cart_item_options_group_id_fkey,
  add  constraint cart_item_options_group_id_fkey
    foreign key (group_id) references product_option_groups(id) on delete cascade;

alter table cart_item_options
  drop constraint if exists cart_item_options_option_id_fkey,
  add  constraint cart_item_options_option_id_fkey
    foreign key (option_id) references product_options(id) on delete cascade;

-- Deleting an add-on clears it from any cart that had it selected.
alter table cart_item_addons
  drop constraint if exists cart_item_addons_addon_id_fkey,
  add  constraint cart_item_addons_addon_id_fkey
    foreign key (addon_id) references package_addons(id) on delete cascade;

-- The pre-migration colour table (product_colours / cart_item_colours) may
-- still exist with its own RESTRICT keys. Relax them too if present; skipped
-- automatically on databases where these tables were already dropped.
alter table if exists cart_item_colours
  drop constraint if exists cart_item_colours_product_id_fkey,
  add  constraint cart_item_colours_product_id_fkey
    foreign key (product_id) references package_products(id) on delete cascade;

alter table if exists cart_item_colours
  drop constraint if exists cart_item_colours_colour_id_fkey,
  add  constraint cart_item_colours_colour_id_fkey
    foreign key (colour_id) references product_colours(id) on delete cascade;

commit;
