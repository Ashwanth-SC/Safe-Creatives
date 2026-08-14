-- ============================================================================
-- Migration 028 — Products brand/sub-category + Hardwares database
-- ============================================================================
--
-- Run ONCE, after 027-quote-box-units.sql.
--
--   * turnkey_products gains `brand` (after product name) and `sub_category`
--     (after product category). Both free text.
--
--   * turnkey_hardwares — handles, hinges, drawer channels, etc. Its product
--     category is a managed list (turnkey_hardware_categories), so a category
--     name can't be added twice.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Products: brand + sub-category
-- ---------------------------------------------------------------------------
alter table turnkey_products
  add column if not exists brand        text,
  add column if not exists sub_category text;

-- ---------------------------------------------------------------------------
-- Hardware category options (managed, unique)
-- ---------------------------------------------------------------------------
create table if not exists turnkey_hardware_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

comment on table turnkey_hardware_categories is
  'Options for the Hardwares Product category dropdown. Unique names.';

insert into turnkey_hardware_categories (name)
  values ('Edge hinges'), ('Inner hinges'), ('Channel'), ('Handle')
  on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Hardwares
-- ---------------------------------------------------------------------------
create table if not exists turnkey_hardwares (
  id             uuid primary key default gen_random_uuid(),
  supplier       text,
  product_name   text,
  category       text,          -- value from turnkey_hardware_categories
  size           text,          -- free text (e.g. '450', '450mm')
  price          numeric check (price is null or price >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table turnkey_hardwares is
  'Hardware reference list (hinges, channels, handles, ...) for the quotation
   builder. Maintained as an editable grid in the Turnkey database window.';

create index if not exists turnkey_hardwares_created_idx on turnkey_hardwares (created_at);
create index if not exists turnkey_hardwares_category_idx on turnkey_hardwares (category);

drop trigger if exists turnkey_hardwares_touch on turnkey_hardwares;
create trigger turnkey_hardwares_touch
  before update on turnkey_hardwares
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_hardware_categories enable row level security;
alter table turnkey_hardwares enable row level security;

grant select, insert, update, delete on turnkey_hardware_categories to authenticated;
grant select, insert, update, delete on turnkey_hardwares to authenticated;

drop policy if exists turnkey_hardware_categories_admin_all on turnkey_hardware_categories;
create policy turnkey_hardware_categories_admin_all on turnkey_hardware_categories
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists turnkey_hardwares_admin_all on turnkey_hardwares;
create policy turnkey_hardwares_admin_all on turnkey_hardwares
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
