-- ============================================================================
-- Safe Creatives — catalog seed data
-- ============================================================================
--
-- Extracted from the hardcoded markup in living-room-package.html and
-- bedroom-package.html. Once this is loaded, those pages render from the
-- database and prices live in exactly one place.
--
-- Run AFTER database-schema.sql. Safe to re-run: every insert upserts on its
-- natural key, so editing a price here and re-running updates the catalog.
--
-- REMINDER: prices are in PAISE. ₹1,85,000 -> 18500000.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- Packages
-- ---------------------------------------------------------------------------

insert into packages (key, name, description, base_price_paise, sort_order) values
  ('living-room', 'Living Room Package',
   'A flexible, welcoming foundation for shared time, sensory comfort, and better everyday routines.',
   18500000, 1),
  ('bedroom', 'Bedroom Package',
   'A more restorative setting that supports gentler transitions, deeper rest, and a calmer start to every day.',
   16500000, 2)
on conflict (key) do update set
  name             = excluded.name,
  description      = excluded.description,
  base_price_paise = excluded.base_price_paise,
  sort_order       = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Living room — main products
-- ---------------------------------------------------------------------------

insert into package_products (package_id, key, name, description, specs, sort_order)
select p.id, v.key, v.name, v.description, v.specs::jsonb, v.sort_order
from packages p
join (values
  ('calm-corner-sofa', 'Calm Corner Sofa',
   'A low, softly structured sofa that makes gathering and unwinding feel effortless.',
   '[{"label":"SIZE","value":"280 × 160 cm"},{"label":"COMFORT","value":"Medium-soft"}]', 1),
  ('ambient-light-system', 'Ambient Light System',
   'Layered, dimmable lighting designed to soften visual noise and adapt to the rhythm of the room.',
   '[{"label":"CONTROL","value":"App + dimmer"},{"label":"TEMPERATURE","value":"2700–4000 K"}]', 2),
  ('grounding-rug', 'Grounding Rug',
   'A tactile layer underfoot that brings warmth, definition, and a quieter sensory base to the room.',
   '[{"label":"SIZE","value":"200 × 300 cm"},{"label":"CARE","value":"Low maintenance"}]', 3)
) as v(key, name, description, specs, sort_order) on true
where p.key = 'living-room'
on conflict (package_id, key) do update set
  name        = excluded.name,
  description = excluded.description,
  specs       = excluded.specs,
  sort_order  = excluded.sort_order;


-- Calm Corner Sofa colours
insert into product_colours (product_id, key, name, image_path, finish, material, sort_order)
select pp.id, v.key, v.name, v.image_path, v.finish, v.material, v.sort_order
from package_products pp
join packages p on p.id = pp.package_id
join (values
  ('sand',     'Sand',     'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=1200&q=85', 'Warm sand',     'Textured linen',     1),
  ('teal',     'Teal',     'https://images.unsplash.com/photo-1554995207-c18c203602cb?auto=format&fit=crop&w=1200&q=85', 'Deep teal',     'Performance velvet', 2),
  ('burgundy', 'Burgundy', 'https://images.unsplash.com/photo-1493666438817-866a91353ca9?auto=format&fit=crop&w=1200&q=85', 'Soft burgundy', 'Brushed cotton',     3)
) as v(key, name, image_path, finish, material, sort_order) on true
where p.key = 'living-room' and pp.key = 'calm-corner-sofa'
on conflict (product_id, key) do update set
  name = excluded.name, image_path = excluded.image_path,
  finish = excluded.finish, material = excluded.material, sort_order = excluded.sort_order;

-- Ambient Light System colours
insert into product_colours (product_id, key, name, image_path, finish, material, sort_order)
select pp.id, v.key, v.name, v.image_path, v.finish, v.material, v.sort_order
from package_products pp
join packages p on p.id = pp.package_id
join (values
  ('sand',     'Sand',     'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1200&q=85', 'Brass sand',      'Powder-coated metal', 1),
  ('teal',     'Teal',     'https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=1200&q=85', 'Teal shade',      'Tinted glass',        2),
  ('burgundy', 'Burgundy', 'https://images.unsplash.com/photo-1540932239986-30128078f3c5?auto=format&fit=crop&w=1200&q=85', 'Burgundy shade',  'Hand-finished glass', 3)
) as v(key, name, image_path, finish, material, sort_order) on true
where p.key = 'living-room' and pp.key = 'ambient-light-system'
on conflict (product_id, key) do update set
  name = excluded.name, image_path = excluded.image_path,
  finish = excluded.finish, material = excluded.material, sort_order = excluded.sort_order;

-- Grounding Rug colours
insert into product_colours (product_id, key, name, image_path, finish, material, sort_order)
select pp.id, v.key, v.name, v.image_path, v.finish, v.material, v.sort_order
from package_products pp
join packages p on p.id = pp.package_id
join (values
  ('sand',     'Sand',     'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1200&q=85', 'Oat sand',       'Wool blend',    1),
  ('teal',     'Teal',     'https://images.unsplash.com/photo-1600166898405-da9535204843?auto=format&fit=crop&w=1200&q=85', 'Teal weave',     'Recycled wool', 2),
  ('burgundy', 'Burgundy', 'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1200&q=85', 'Burgundy weave', 'Wool + jute',   3)
) as v(key, name, image_path, finish, material, sort_order) on true
where p.key = 'living-room' and pp.key = 'grounding-rug'
on conflict (product_id, key) do update set
  name = excluded.name, image_path = excluded.image_path,
  finish = excluded.finish, material = excluded.material, sort_order = excluded.sort_order;


-- Living room add-ons
insert into package_addons (package_id, key, name, description, image_path, price_paise, sort_order)
select p.id, v.key, v.name, v.description, v.image_path, v.price_paise, v.sort_order
from packages p
join (values
  ('living-aroma', 'Aroma diffuser',
   'A quiet diffuser with gentle, programmable scent sessions.',
   'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=85',  450000, 1),
  ('living-panel', 'Acoustic panel',
   'Softens everyday sound with a clean, architectural finish.',
   'https://images.unsplash.com/photo-1594620302200-9a762244a156?auto=format&fit=crop&w=800&q=85', 1200000, 2),
  ('living-throw', 'Weighted throw',
   'A comforting tactile layer for rest, focus, or decompression.',
   'https://images.unsplash.com/photo-1575410229391-19b4da01cc94?auto=format&fit=crop&w=800&q=85',  320000, 3)
) as v(key, name, description, image_path, price_paise, sort_order) on true
where p.key = 'living-room'
on conflict (package_id, key) do update set
  name = excluded.name, description = excluded.description,
  image_path = excluded.image_path,
  price_paise = excluded.price_paise, sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Bedroom — main products
-- ---------------------------------------------------------------------------

insert into package_products (package_id, key, name, description, specs, sort_order)
select p.id, v.key, v.name, v.description, v.specs::jsonb, v.sort_order
from packages p
join (values
  ('restful-bed-frame', 'Restful Bed Frame',
   'A soft-edged, grounded frame that gives the room a stable and comforting centre.',
   '[{"label":"SIZE","value":"Queen / King"},{"label":"PROFILE","value":"Low platform"}]', 1),
  ('soft-light-bedside', 'Soft Light Bedside',
   'A warm, low-glare bedside light that helps the room shift gently from day to night.',
   '[{"label":"CONTROL","value":"Touch dimmer"},{"label":"LIGHT","value":"Warm 2700 K"}]', 2),
  ('quiet-storage-bench', 'Quiet Storage Bench',
   'A tactile storage piece that reduces visual clutter while adding a practical place to pause.',
   '[{"label":"SIZE","value":"120 × 42 cm"},{"label":"STORAGE","value":"Lift-up compartment"}]', 3)
) as v(key, name, description, specs, sort_order) on true
where p.key = 'bedroom'
on conflict (package_id, key) do update set
  name        = excluded.name,
  description = excluded.description,
  specs       = excluded.specs,
  sort_order  = excluded.sort_order;


-- Restful Bed Frame colours
insert into product_colours (product_id, key, name, image_path, finish, material, sort_order)
select pp.id, v.key, v.name, v.image_path, v.finish, v.material, v.sort_order
from package_products pp
join packages p on p.id = pp.package_id
join (values
  ('sand',     'Sand',     'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=85', 'Natural sand',  'Oak veneer',          1),
  ('teal',     'Teal',     'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?auto=format&fit=crop&w=1200&q=85', 'Deep teal',     'Upholstered fabric',  2),
  ('burgundy', 'Burgundy', 'https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?auto=format&fit=crop&w=1200&q=85', 'Soft burgundy', 'Brushed linen',       3)
) as v(key, name, image_path, finish, material, sort_order) on true
where p.key = 'bedroom' and pp.key = 'restful-bed-frame'
on conflict (product_id, key) do update set
  name = excluded.name, image_path = excluded.image_path,
  finish = excluded.finish, material = excluded.material, sort_order = excluded.sort_order;

-- Soft Light Bedside colours
insert into product_colours (product_id, key, name, image_path, finish, material, sort_order)
select pp.id, v.key, v.name, v.image_path, v.finish, v.material, v.sort_order
from package_products pp
join packages p on p.id = pp.package_id
join (values
  ('sand',     'Sand',     'https://images.unsplash.com/photo-1549497538-303791108f95?auto=format&fit=crop&w=1200&q=85', 'Sand ceramic',     'Ceramic + linen', 1),
  ('teal',     'Teal',     'https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=1200&q=85', 'Teal ceramic',     'Tinted ceramic',  2),
  ('burgundy', 'Burgundy', 'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1200&q=85', 'Burgundy ceramic', 'Glazed ceramic',  3)
) as v(key, name, image_path, finish, material, sort_order) on true
where p.key = 'bedroom' and pp.key = 'soft-light-bedside'
on conflict (product_id, key) do update set
  name = excluded.name, image_path = excluded.image_path,
  finish = excluded.finish, material = excluded.material, sort_order = excluded.sort_order;

-- Quiet Storage Bench colours
insert into product_colours (product_id, key, name, image_path, finish, material, sort_order)
select pp.id, v.key, v.name, v.image_path, v.finish, v.material, v.sort_order
from package_products pp
join packages p on p.id = pp.package_id
join (values
  ('sand',     'Sand',     'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=1200&q=85', 'Sand oak',             'Oak + cotton', 1),
  ('teal',     'Teal',     'https://images.unsplash.com/photo-1558997519-83ea9252edf8?auto=format&fit=crop&w=1200&q=85', 'Teal upholstery',      'Oak + velvet', 2),
  ('burgundy', 'Burgundy', 'https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?auto=format&fit=crop&w=1200&q=85', 'Burgundy upholstery',  'Oak + linen',  3)
) as v(key, name, image_path, finish, material, sort_order) on true
where p.key = 'bedroom' and pp.key = 'quiet-storage-bench'
on conflict (product_id, key) do update set
  name = excluded.name, image_path = excluded.image_path,
  finish = excluded.finish, material = excluded.material, sort_order = excluded.sort_order;


-- Bedroom add-ons
insert into package_addons (package_id, key, name, description, image_path, price_paise, sort_order)
select p.id, v.key, v.name, v.description, v.image_path, v.price_paise, v.sort_order
from packages p
join (values
  ('bedroom-blackout', 'Blackout curtains',
   'Layered curtains to reduce light and support a more consistent sleep setting.',
   'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=800&q=85', 850000, 1),
  ('bedroom-sound', 'Sound machine',
   'Soft, consistent soundscapes for rest, sleep, or moments of quiet focus.',
   'https://images.unsplash.com/photo-1600080972464-8e5f35f63d08?auto=format&fit=crop&w=800&q=85', 650000, 2),
  ('bedroom-weighted', 'Weighted blanket',
   'A reassuring layer designed for calmer settling and deeper relaxation.',
   'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=85', 490000, 3)
) as v(key, name, description, image_path, price_paise, sort_order) on true
where p.key = 'bedroom'
on conflict (package_id, key) do update set
  name = excluded.name, description = excluded.description,
  image_path = excluded.image_path,
  price_paise = excluded.price_paise, sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Swatch colours
-- ---------------------------------------------------------------------------
-- Every product offers the same three finishes, so this is one statement
-- rather than a repeated column in each insert above. These hex values are
-- lifted from the [data-color="..."] rules in packages.css.

update product_colours set swatch_hex = case key
  when 'sand'     then '#d0b28e'
  when 'teal'     then '#0c4444'
  when 'burgundy' then '#6f222a'
  else swatch_hex
end
where key in ('sand', 'teal', 'burgundy');


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Expect: living-room ₹1,85,000 with 3 products / 9 colours / 3 addons
--         bedroom     ₹1,65,000 with 3 products / 9 colours / 3 addons

select
  p.key,
  p.base_price_paise / 100 as base_price_rupees,
  (select count(*) from package_products pp where pp.package_id = p.id) as products,
  (select count(*) from product_colours pc
     join package_products pp2 on pp2.id = pc.product_id
    where pp2.package_id = p.id) as colours,
  (select count(*) from package_addons pa where pa.package_id = p.id) as addons
from packages p
order by p.sort_order;
