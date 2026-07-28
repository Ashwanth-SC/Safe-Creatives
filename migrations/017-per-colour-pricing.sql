-- ============================================================================
-- Migration 017 — price and HSN live on each colour (size × colour)
-- ============================================================================
--
-- Run ONCE, after 016-installment-links.sql.
--
-- The old model carried a package base_price and layered +/- deltas on top of
-- it (size delta, colour delta, add-on). That forced the merchant to reason
-- about a base and a web of adjustments. The new model puts the ABSOLUTE price
-- (and its HSN) on each colour — and since a colour is already nested under a
-- size via product_options.parent_option_id, a colour row IS a size × colour
-- combination. A product's price is simply its selected colour's price; the
-- package total is the sum across products, plus any add-ons.
--
-- Why the arithmetic does not change anywhere:
--
--   Every total is computed as
--     base_price_paise + Σ(option price_delta_paise) + Σ(addon price_paise)
--   (cart_item_totals view, create-order, revise-order). With base = 0, size
--   price = 0, and the colour's price_delta_paise now holding the ABSOLUTE
--   price, that sum is exactly Σ(colour prices) + Σ(addons). So we keep the
--   column name price_delta_paise and merely relabel it "Price" in the admin;
--   the views and edge-function maths are untouched.
--
-- base_price_paise / packages.hsn_code / package_products.hsn_code are KEPT
-- (base set to 0, HSN left as-is but no longer edited in the UI). Dropping them
-- would ripple through the totals views, three edge functions and every
-- order-history snapshot for no functional gain; they become vestigial instead.
--
-- Add-ons are deliberately untouched: they remain a separate, simply-priced,
-- on/off concept (package_addons).
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. New columns
-- ---------------------------------------------------------------------------

-- HSN/SAC for each colour (size × colour). Used for invoice line descriptions
-- and snapshotted onto orders at placement time.
alter table product_options
  add column if not exists hsn_code text;

-- A short tagline shown under the product name on the configurator.
alter table package_products
  add column if not exists sub_heading text;

-- Snapshot of the colour's HSN onto the order line, so an invoice raised later
-- carries the HSN that applied when the order was placed.
alter table order_item_options
  add column if not exists hsn_code text;

-- The reservation advance becomes a single editable value, fixed across all
-- orders until the merchant changes it in the catalog admin. Defaults to
-- ₹8,999 (GST-inclusive); the create-order function reads this instead of a
-- hardcoded env var. The advance HSN/SAC (advance_hsn_code) is unchanged.
alter table seller_settings
  add column if not exists advance_amount_paise bigint not null default 899900
    check (advance_amount_paise >= 0);


-- ---------------------------------------------------------------------------
-- 2. Reset retired pricing to zero
-- ---------------------------------------------------------------------------
-- The old size/colour deltas are NOT valid absolute prices (a "+₹4,000" colour
-- delta is not a ₹4,000 product price), so every option price is reset to 0 and
-- re-entered per colour in the admin. Package bases go to 0 too.

update product_options set price_delta_paise = 0
  where price_delta_paise <> 0;

update packages set base_price_paise = 0
  where base_price_paise <> 0;

commit;


-- Check:
-- select p.name as package, pp.name as product, sz.name as size,
--        col.name as colour, col.price_delta_paise as price_paise, col.hsn_code
-- from packages p
-- join package_products pp on pp.package_id = p.id
-- join product_option_groups sg on sg.product_id = pp.id and sg.key = 'size'
-- join product_options sz on sz.group_id = sg.id and sz.parent_option_id is null
-- join product_option_groups cg on cg.product_id = pp.id and cg.key = 'colour'
-- join product_options col on col.group_id = cg.id and col.parent_option_id = sz.id
-- order by p.sort_order, pp.sort_order, sz.sort_order, col.sort_order;
--
-- select advance_amount_paise, advance_hsn_code from seller_settings;
