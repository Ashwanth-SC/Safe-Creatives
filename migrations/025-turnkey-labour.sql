-- ============================================================================
-- Migration 025 — Turnkey database: labour
-- ============================================================================
--
-- Run ONCE, after 024-turnkey-products.sql.
--
-- The labour reference table: labourers/contractors with their category, day
-- rate and per-sqft rate. The labour category is chosen from a managed list
-- (turnkey_labour_categories) that staff can add to / delete from — same
-- pattern as product categories.
--
--   turnkey_labour_categories — the dropdown options (Carpenter, Painter, ...).
--   turnkey_labour            — one row per labourer/contractor + rates.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- Category options for the Labour category dropdown
-- ---------------------------------------------------------------------------
create table if not exists turnkey_labour_categories (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,
  created_at  timestamptz not null default now()
);

comment on table turnkey_labour_categories is
  'Options for the Labour category dropdown in the Turnkey database window.';

insert into turnkey_labour_categories (name)
  values ('Carpenter'), ('Painter'), ('Plumber'), ('Electrician'), ('Civil')
  on conflict (name) do nothing;

-- ---------------------------------------------------------------------------
-- Labour
-- ---------------------------------------------------------------------------
create table if not exists turnkey_labour (
  id              uuid primary key default gen_random_uuid(),
  category        text,          -- value from turnkey_labour_categories
  name            text,
  contact_number  text,
  cost_per_day    numeric check (cost_per_day is null or cost_per_day >= 0),
  cost_per_sqft   numeric check (cost_per_sqft is null or cost_per_sqft >= 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table turnkey_labour is
  'Labour/contractor reference list + rates for the quotation builder.
   Maintained as an editable grid in the Turnkey database window.';

create index if not exists turnkey_labour_created_idx on turnkey_labour (created_at);
create index if not exists turnkey_labour_category_idx on turnkey_labour (category);

drop trigger if exists turnkey_labour_touch on turnkey_labour;
create trigger turnkey_labour_touch
  before update on turnkey_labour
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_labour_categories enable row level security;
alter table turnkey_labour enable row level security;

grant select, insert, update, delete on turnkey_labour_categories to authenticated;
grant select, insert, update, delete on turnkey_labour to authenticated;

drop policy if exists turnkey_labour_categories_admin_all on turnkey_labour_categories;
create policy turnkey_labour_categories_admin_all on turnkey_labour_categories
  for all to authenticated using (is_admin()) with check (is_admin());

drop policy if exists turnkey_labour_admin_all on turnkey_labour;
create policy turnkey_labour_admin_all on turnkey_labour
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
