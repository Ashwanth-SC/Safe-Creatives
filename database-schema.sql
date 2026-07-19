-- ============================================================================
-- Safe Creatives — Supabase / PostgreSQL schema
-- ============================================================================
--
-- Design rules this schema enforces:
--
--   1. The client never sends a price. It sends package / colour / addon IDs.
--      The server reads prices from the catalog tables and computes totals.
--
--   2. Money is stored in PAISE as bigint, never rupees, never float.
--      ₹1,20,000 is stored as 12000000. Payment gateways also work in paise,
--      so this avoids the classic 100x conversion bug at the boundary.
--
--   3. Carts reference the catalog. Orders SNAPSHOT it. A price change must
--      never retroactively alter an order a customer already paid against.
--
--   4. Nothing writes to orders, payments, or refunds from the browser.
--      Those are service_role only (Edge Functions). RLS grants read access
--      to owners and nothing more.
--
-- ============================================================================


-- ============================================================================
-- SECTION 1 — PROFILES
-- ============================================================================

create table profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null,
  email       text not null unique,
  phone       text,
  address     text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table profiles is
  'Customer profile, 1:1 with auth.users. Delivery address here is the current
   default; orders snapshot their own copy at placement time.';


-- ============================================================================
-- SECTION 2 — CATALOG  (server-authoritative pricing)
-- ============================================================================
-- This is the piece the prototype was missing. Prices live here, not in HTML
-- data-attributes, so the browser cannot influence what a customer is charged.

create table packages (
  id               uuid primary key default gen_random_uuid(),
  key              text not null unique,          -- 'living-room', 'bedroom'
  name             text not null,                 -- 'Living Room Package'
  description      text,
  base_price_paise bigint not null check (base_price_paise >= 0),
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- The configurable main products inside a package (sofa, bed, wardrobe...).
create table package_products (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references packages(id) on delete cascade,
  key         text not null,                      -- matches data-product in HTML
  name        text not null,
  sort_order  integer not null default 0,
  unique (package_id, key)
);

-- Colour / finish variants for a product. Mirrors the data-* attributes
-- currently hardcoded on .color-option buttons in the package pages.
create table product_colours (
  id                uuid primary key default gen_random_uuid(),
  product_id        uuid not null references package_products(id) on delete cascade,
  key               text not null,                -- matches data-color
  name              text not null,
  image_path        text not null,                -- data-image
  finish            text,                         -- data-finish
  material          text,                         -- data-material
  price_delta_paise bigint not null default 0,    -- lets a premium finish cost more
  is_active         boolean not null default true,
  sort_order        integer not null default 0,
  unique (product_id, key)
);

create table package_addons (
  id          uuid primary key default gen_random_uuid(),
  package_id  uuid not null references packages(id) on delete cascade,
  key         text not null,                      -- matches data-id on .addon-card
  name        text not null,
  description text,
  price_paise bigint not null check (price_paise >= 0),
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  unique (package_id, key)
);


-- ============================================================================
-- SECTION 3 — CARTS  (live, references catalog, stores NO prices)
-- ============================================================================

create table carts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles(id) on delete cascade,
  status     text not null default 'active'
             check (status in ('active', 'ordered', 'abandoned')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active cart per customer, enforced by the database rather than by
-- hoping the client picks the right row.
create unique index carts_one_active_per_user
  on carts (user_id)
  where status = 'active';

-- NOTE: deliberately NOT unique on (cart_id, package_id).
-- The UI already supports adding the same package twice with different
-- configurations ("Add another one?" in package-page.js), e.g. two bedrooms
-- in different colours. Each is its own line item.
create table cart_items (
  id         uuid primary key default gen_random_uuid(),
  cart_id    uuid not null references carts(id) on delete cascade,
  package_id uuid not null references packages(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index cart_items_cart_id_idx on cart_items (cart_id);

create table cart_item_colours (
  id           uuid primary key default gen_random_uuid(),
  cart_item_id uuid not null references cart_items(id) on delete cascade,
  product_id   uuid not null references package_products(id) on delete restrict,
  colour_id    uuid not null references product_colours(id) on delete restrict,
  unique (cart_item_id, product_id)              -- one colour per product
);

create table cart_item_addons (
  id           uuid primary key default gen_random_uuid(),
  cart_item_id uuid not null references cart_items(id) on delete cascade,
  addon_id     uuid not null references package_addons(id) on delete restrict,
  unique (cart_item_id, addon_id)                -- an addon is on or off
);


-- ============================================================================
-- SECTION 4 — CART TOTALS  (derived, never stored)
-- ============================================================================
-- Reading a total always recomputes from current catalog prices, so a cart
-- cannot drift out of sync with the catalog and cannot be forged.

-- security_invoker is essential here. Without it a view runs with its OWNER's
-- privileges and quietly bypasses RLS on the tables underneath — meaning any
-- logged-in customer could read every other customer's cart totals.
create view cart_item_totals with (security_invoker = true) as
select
  ci.id                                        as cart_item_id,
  ci.cart_id,
  p.id                                         as package_id,
  p.key                                        as package_key,
  p.name                                       as package_name,
  p.base_price_paise,
  coalesce(colour_delta.total, 0)              as colour_delta_paise,
  coalesce(addon_total.total, 0)               as addons_paise,
  p.base_price_paise
    + coalesce(colour_delta.total, 0)
    + coalesce(addon_total.total, 0)           as line_total_paise
from cart_items ci
join packages p on p.id = ci.package_id
left join lateral (
  select sum(pc.price_delta_paise) as total
  from cart_item_colours cic
  join product_colours pc on pc.id = cic.colour_id
  where cic.cart_item_id = ci.id
) colour_delta on true
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


-- ============================================================================
-- SECTION 5 — ORDERS  (immutable snapshot)
-- ============================================================================
-- Order rows copy names and prices as plain values. No foreign keys into the
-- catalog, because editing a package price next month must not rewrite history.

create sequence order_number_seq start 1000;

create table orders (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete restrict,
  order_number  text not null unique
                default 'SC-' || to_char(now(), 'YYYY') || '-'
                        || lpad(nextval('order_number_seq')::text, 5, '0'),

  status        text not null default 'pending_advance'
                check (status in (
                  'pending_advance',      -- reserved, advance not yet paid
                  'advance_paid',         -- money received, awaiting site visit
                  'site_verification',    -- our team is verifying the house
                  'confirmed',            -- verified, production can begin
                  'in_production',
                  'delivered',
                  'cancelled',
                  'refunded'
                )),

  currency      text not null default 'INR' check (currency = upper(currency)),

  -- Money, all computed server-side at placement time.
  subtotal_paise       bigint not null check (subtotal_paise >= 0),
  advance_percent      numeric(5,2) not null check (advance_percent between 0 and 100),
  advance_amount_paise bigint not null check (advance_amount_paise >= 0),
  balance_paise        bigint generated always as
                       (subtotal_paise - advance_amount_paise) stored,

  -- Contact + delivery snapshot. Copied from the profile at placement so a
  -- later profile edit does not silently change where an order ships.
  contact_name     text not null,
  contact_email    text not null,
  contact_phone    text,
  delivery_address text not null,

  notes         text,
  placed_at     timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index orders_user_id_idx on orders (user_id, placed_at desc);
create index orders_status_idx  on orders (status);

create table order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id) on delete cascade,
  package_key      text not null,                 -- snapshot, not an FK
  package_name     text not null,
  base_price_paise bigint not null,
  line_total_paise bigint not null
);

create index order_items_order_id_idx on order_items (order_id);

create table order_item_colours (
  id              uuid primary key default gen_random_uuid(),
  order_item_id   uuid not null references order_items(id) on delete cascade,
  product_name    text not null,
  colour_name     text not null,
  finish          text,
  material        text,
  price_delta_paise bigint not null default 0
);

create table order_item_addons (
  id            uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  addon_key     text not null,
  addon_name    text not null,
  price_paise   bigint not null
);


-- ============================================================================
-- SECTION 6 — PAYMENTS  (provider agnostic)
-- ============================================================================
-- Nothing here assumes Razorpay or Stripe. `provider` names the gateway and
-- the provider_* columns hold whatever IDs it issues. Swapping providers, or
-- running two at once, needs no schema change.

create table payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete restrict,
  user_id             uuid not null references profiles(id) on delete restrict,

  provider            text not null,             -- 'razorpay', 'stripe', ...
  provider_order_id   text,                      -- gateway's order/intent ID
  provider_payment_id text,                      -- gateway's payment ID

  purpose             text not null default 'advance'
                      check (purpose in ('advance', 'balance')),

  amount_paise        bigint not null check (amount_paise > 0),
  currency            text not null default 'INR',

  status              text not null default 'created'
                      check (status in (
                        'created',      -- we asked the gateway for a session
                        'pending',      -- customer is mid-payment
                        'authorized',   -- funds held, not yet captured
                        'captured',     -- money is ours
                        'failed',
                        'cancelled'
                      )),

  method              text,                      -- 'upi', 'card', 'netbanking'
  failure_reason      text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- A gateway payment ID must map to exactly one row. This is the guard against
-- a replayed webhook creating duplicate payments.
create unique index payments_provider_payment_unique
  on payments (provider, provider_payment_id)
  where provider_payment_id is not null;

create index payments_order_id_idx on payments (order_id);

-- Raw webhook log. Insert first, process second: if processing crashes the
-- event is still on disk and can be replayed.
create table payment_events (
  id                uuid primary key default gen_random_uuid(),
  payment_id        uuid references payments(id) on delete set null,
  provider          text not null,
  provider_event_id text not null,
  event_type        text not null,
  payload           jsonb not null,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  process_error     text,
  unique (provider, provider_event_id)           -- idempotency key
);

create index payment_events_unprocessed_idx
  on payment_events (received_at)
  where processed_at is null;

-- The advance is refundable, so refunds are first-class rather than a status.
create table refunds (
  id                 uuid primary key default gen_random_uuid(),
  payment_id         uuid not null references payments(id) on delete restrict,
  provider_refund_id text,
  amount_paise       bigint not null check (amount_paise > 0),
  status             text not null default 'pending'
                     check (status in ('pending', 'processed', 'failed')),
  reason             text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create unique index refunds_provider_refund_unique
  on refunds (provider_refund_id)
  where provider_refund_id is not null;


-- ============================================================================
-- SECTION 7 — updated_at TRIGGERS
-- ============================================================================

create or replace function touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch    before update on profiles    for each row execute function touch_updated_at();
create trigger packages_touch    before update on packages    for each row execute function touch_updated_at();
create trigger carts_touch       before update on carts       for each row execute function touch_updated_at();
create trigger cart_items_touch  before update on cart_items  for each row execute function touch_updated_at();
create trigger orders_touch      before update on orders      for each row execute function touch_updated_at();
create trigger payments_touch    before update on payments    for each row execute function touch_updated_at();
create trigger refunds_touch     before update on refunds     for each row execute function touch_updated_at();


-- ============================================================================
-- SECTION 8 — ROW LEVEL SECURITY
-- ============================================================================
-- The anon key in supabase-client.js is public by design and ships to every
-- visitor's browser. These policies are the only thing standing between that
-- key and your customer data. RLS on every table, no exceptions.

alter table profiles           enable row level security;
alter table packages           enable row level security;
alter table package_products   enable row level security;
alter table product_colours    enable row level security;
alter table package_addons     enable row level security;
alter table carts              enable row level security;
alter table cart_items         enable row level security;
alter table cart_item_colours  enable row level security;
alter table cart_item_addons   enable row level security;
alter table orders             enable row level security;
alter table order_items        enable row level security;
alter table order_item_colours enable row level security;
alter table order_item_addons  enable row level security;
alter table payments           enable row level security;
alter table payment_events     enable row level security;
alter table refunds            enable row level security;


-- ---- Catalog: world-readable when active, never client-writable -----------
-- Browsable without logging in. Writes happen in the Supabase dashboard or
-- via service_role, which bypasses RLS entirely.

create policy packages_public_read on packages
  for select to anon, authenticated using (is_active);

create policy package_products_public_read on package_products
  for select to anon, authenticated using (
    exists (select 1 from packages p where p.id = package_id and p.is_active)
  );

create policy product_colours_public_read on product_colours
  for select to anon, authenticated using (is_active);

create policy package_addons_public_read on package_addons
  for select to anon, authenticated using (is_active);


-- ---- Profiles: strictly your own row --------------------------------------

create policy profiles_select_own on profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_insert_own on profiles
  for insert to authenticated with check (id = auth.uid());

create policy profiles_update_own on profiles
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- No delete policy: account deletion cascades from auth.users instead.


-- ---- Carts: full ownership, since a cart is scratch space -----------------

create policy carts_own on carts
  for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy cart_items_own on cart_items
  for all to authenticated
  using (
    exists (select 1 from carts c where c.id = cart_id and c.user_id = auth.uid())
  )
  with check (
    exists (select 1 from carts c where c.id = cart_id and c.user_id = auth.uid())
  );

create policy cart_item_colours_own on cart_item_colours
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

create policy cart_item_addons_own on cart_item_addons
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


-- ---- Orders: READ ONLY from the browser -----------------------------------
-- Select policies only. No insert, update, or delete policy exists, so the
-- anon and authenticated roles simply cannot write here. Orders are created
-- by an Edge Function using service_role, which computes the totals itself.

create policy orders_select_own on orders
  for select to authenticated using (user_id = auth.uid());

create policy order_items_select_own on order_items
  for select to authenticated using (
    exists (select 1 from orders o where o.id = order_id and o.user_id = auth.uid())
  );

create policy order_item_colours_select_own on order_item_colours
  for select to authenticated using (
    exists (
      select 1 from order_items oi
      join orders o on o.id = oi.order_id
      where oi.id = order_item_id and o.user_id = auth.uid()
    )
  );

create policy order_item_addons_select_own on order_item_addons
  for select to authenticated using (
    exists (
      select 1 from order_items oi
      join orders o on o.id = oi.order_id
      where oi.id = order_item_id and o.user_id = auth.uid()
    )
  );


-- ---- Payments: READ ONLY, refunds read only, webhooks invisible -----------
-- A browser that could write to payments could mark its own order paid.

create policy payments_select_own on payments
  for select to authenticated using (user_id = auth.uid());

create policy refunds_select_own on refunds
  for select to authenticated using (
    exists (
      select 1 from payments p
      where p.id = payment_id and p.user_id = auth.uid()
    )
  );

-- payment_events gets RLS enabled and zero policies: no client role can read
-- or write it at all. Raw gateway payloads stay server-side.


-- ============================================================================
-- SECTION 9 — NEW USER BOOTSTRAP
-- ============================================================================
-- login.js currently does select-then-insert-or-update against profiles from
-- the browser. This trigger creates the row automatically on signup, so the
-- client only ever needs to update its own profile.

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
