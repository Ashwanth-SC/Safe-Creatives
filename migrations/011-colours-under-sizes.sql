-- ============================================================================
-- Migration 011 — colours nested under sizes (per-size galleries)
-- ============================================================================
--
-- Run ONCE, after 010-invoice-emailed-at.sql.
--
-- New model: each main product has 2–4 sizes, and each SIZE has its own 2–4
-- colours, each colour with its own gallery. So a colour option now belongs
-- to a size option via product_options.parent_option_id:
--
--   product
--     Size group  → size options (parent NULL)        e.g. Queen, King
--       each size → colour options (parent = size id)  e.g. Sand, Teal (per size)
--
-- Colours keep group_id = the product's 'colour' group (for the "Colour"
-- label on invoices/orders) AND gain parent_option_id = a size option.
--
-- Existing flat colours (one set shared across sizes) are copied under every
-- size, then the originals are hidden (is_active=false, not deleted, so any
-- cart/order rows that reference them stay valid).
-- ============================================================================

begin;

alter table product_options
  add column if not exists parent_option_id uuid references product_options(id) on delete cascade;

create index if not exists product_options_parent_idx on product_options (parent_option_id);

-- The old `unique (group_id, key)` forbids the same colour key under two
-- different sizes (Sand under Queen AND under King). Replace it with
-- uniqueness per (group, parent, key). coalesce(parent, group) gives size
-- options — which have a NULL parent — a stable sentinel so their keys stay
-- unique within the size group, and works on any Postgres version.
alter table product_options drop constraint if exists product_options_group_id_key_key;
create unique index if not exists product_options_group_parent_key
  on product_options (group_id, coalesce(parent_option_id, group_id), key);

-- Duplicate each product's flat colours under every one of its sizes.
do $$
declare
  sz record;
  col record;
begin
  for sz in
    select so.id as size_id,
           cg.id as colour_group_id
    from product_options so
    join product_option_groups sg on sg.id = so.group_id and sg.key = 'size'
    join product_option_groups cg on cg.product_id = sg.product_id and cg.key = 'colour'
    where so.parent_option_id is null
  loop
    for col in
      select * from product_options
      where group_id = sz.colour_group_id
        and parent_option_id is null
        and is_active = true
    loop
      if not exists (
        select 1 from product_options
        where group_id = sz.colour_group_id
          and parent_option_id = sz.size_id
          and key = col.key
      ) then
        insert into product_options (
          group_id, parent_option_id, key, name, description,
          price_delta_paise, image_paths, swatch_hex, finish, material,
          is_active, sort_order
        ) values (
          sz.colour_group_id, sz.size_id, col.key, col.name, col.description,
          col.price_delta_paise, col.image_paths, col.swatch_hex, col.finish, col.material,
          true, col.sort_order
        );
      end if;
    end loop;
  end loop;

  -- Retire the original flat colours (kept for FK integrity, hidden from the UI).
  update product_options so
  set is_active = false
  where so.parent_option_id is null
    and exists (
      select 1 from product_option_groups g
      where g.id = so.group_id and g.key = 'colour'
    );
end $$;

commit;


-- Check: every size should now have its own colours.
-- select p.key as package, pp.name as product, sz.name as size, col.name as colour
-- from packages p
-- join package_products pp on pp.package_id = p.id
-- join product_option_groups sg on sg.product_id = pp.id and sg.key = 'size'
-- join product_options sz on sz.group_id = sg.id and sz.parent_option_id is null
-- join product_options col on col.parent_option_id = sz.id and col.is_active
-- order by p.key, pp.sort_order, sz.sort_order, col.sort_order;
