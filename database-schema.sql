-- Future Supabase/PostgreSQL schema for Safe Creatives.
-- The current prototype stores the same structure in browser localStorage.

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  email text unique not null,
  phone text,
  address text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'submitted', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table cart_packages (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references carts(id) on delete cascade,
  package_key text not null,
  base_price integer not null,
  selected_colours jsonb not null default '{}'::jsonb,
  total_price integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, package_key)
);

create table cart_addons (
  id uuid primary key default gen_random_uuid(),
  cart_package_id uuid not null references cart_packages(id) on delete cascade,
  addon_key text not null,
  addon_name text not null,
  price integer not null,
  unique (cart_package_id, addon_key)
);

-- Required Supabase Row Level Security policies should allow a user
-- to access only carts where carts.user_id = auth.uid().
