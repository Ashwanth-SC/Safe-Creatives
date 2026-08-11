-- ============================================================================
-- Migration 024 — Turnkey database: product specifications & pricing
-- ============================================================================
--
-- Run ONCE, after 023-suppliers-merge-name.sql.
--
-- The second reference table behind the quotation builder: products with their
-- standard dimensions and per-sqft price. The product category is chosen from a
-- managed list (turnkey_product_categories) that staff can add to / delete from.
--
--   turnkey_product_categories — the dropdown options (Plywood, Laminate, ...).
--   turnkey_products           — one row per product spec + price.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Category options for the Product category dropdown
-- ---------------------------------------------------------------------------
create table if not exists turnkey_product_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

comment on table turnkey_product_categories is
  'Options for the Product category dropdown in the Turnkey database window.';

-- A couple of starter categories (as named in the brief); staff add/delete more.
insert into turnkey_product_categories (name) values ('Plywood'), ('Laminate')
  on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Product specifications & pricing
-- ---------------------------------------------------------------------------
create table if not exists turnkey_products (
  id              uuid primary key default gen_random_uuid(),
  supplier        text,
  product_name    text,
  category        text,          -- value from turnkey_product_categories (free
                                 -- text in the row, so a category can be renamed
                                 -- or deleted without rewriting products)
  std_width       numeric check (std_width is null or std_width >= 0),
  std_height      numeric check (std_height is null or std_height >= 0),
  thickness       text,          -- free text: '18mm', '0.8mm', ...
  price_per_sqft  numeric check (price_per_sqft is null or price_per_sqft >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table turnkey_products is
  'Product specs + per-sqft pricing for the quotation builder. Maintained as an
   editable grid in the Turnkey database window.';

create index if not exists turnkey_products_created_idx on turnkey_products (created_at);
create index if not exists turnkey_products_category_idx on turnkey_products (category);

drop trigger if exists turnkey_products_touch on turnkey_products;
create trigger turnkey_products_touch
  before update on turnkey_products
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_product_categories enable row level security;
alter table turnkey_products enable row level security;

grant select, insert, update, delete on turnkey_product_categories to authenticated;
grant select, insert, update, delete on turnkey_products to authenticated;

drop policy if exists turnkey_product_categories_admin_all on turnkey_product_categories;
create policy turnkey_product_categories_admin_all on turnkey_product_categories
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists turnkey_products_admin_all on turnkey_products;
create policy turnkey_products_admin_all on turnkey_products
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
