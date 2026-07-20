-- ============================================================================
-- Safe Creatives — catalog seed data
-- ============================================================================
--
-- Run AFTER database-schema.sql (fresh install) or AFTER
-- migrations/001-option-groups.sql (existing database).
--
-- Safe to re-run: every insert upserts on its natural key, so editing a price
-- here and re-running updates the catalog rather than duplicating it.
--
-- REMINDER: prices are in PAISE. ₹1,85,000 -> 18500000.
--
-- Once the admin page is in use this file stops being the place to edit the
-- catalog -- it becomes the baseline a fresh database starts from.
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
-- Main products
-- ---------------------------------------------------------------------------

insert into package_products (package_id, key, name, description, specs, sort_order)
select p.id, v.key, v.name, v.description, v.specs::jsonb, v.sort_order
from packages p
join (values
  ('living-room', 'calm-corner-sofa', 'Calm Corner Sofa',
   'A low, softly structured sofa that makes gathering and unwinding feel effortless.',
   '[{"label":"COMFORT","value":"Medium-soft"}]', 1),
  ('living-room', 'ambient-light-system', 'Ambient Light System',
   'Layered, dimmable lighting designed to soften visual noise and adapt to the rhythm of the room.',
   '[{"label":"CONTROL","value":"App + dimmer"},{"label":"TEMPERATURE","value":"2700–4000 K"}]', 2),
  ('living-room', 'grounding-rug', 'Grounding Rug',
   'A tactile layer underfoot that brings warmth, definition, and a quieter sensory base to the room.',
   '[{"label":"CARE","value":"Low maintenance"}]', 3),
  ('bedroom', 'restful-bed-frame', 'Restful Bed Frame',
   'A soft-edged, grounded frame that gives the room a stable and comforting centre.',
   '[{"label":"PROFILE","value":"Low platform"}]', 1),
  ('bedroom', 'soft-light-bedside', 'Soft Light Bedside',
   'A warm, low-glare bedside light that helps the room shift gently from day to night.',
   '[{"label":"CONTROL","value":"Touch dimmer"},{"label":"LIGHT","value":"Warm 2700 K"}]', 2),
  ('bedroom', 'quiet-storage-bench', 'Quiet Storage Bench',
   'A tactile storage piece that reduces visual clutter while adding a practical place to pause.',
   '[{"label":"STORAGE","value":"Lift-up compartment"}]', 3)
) as v(pkey, key, name, description, specs, sort_order) on true
where p.key = v.pkey
on conflict (package_id, key) do update set
  name        = excluded.name,
  description = excluded.description,
  specs       = excluded.specs,
  sort_order  = excluded.sort_order;

-- SIZE now lives in an option group rather than a fixed spec row, because it
-- affects price. The specs above keep only the facts that never vary.


-- ---------------------------------------------------------------------------
-- Option groups — every product gets Size and Colour
-- ---------------------------------------------------------------------------

insert into product_option_groups (product_id, key, name, display_as, sort_order)
select pp.id, 'size', 'Size', 'chip', 1
from package_products pp
on conflict (product_id, key) do update set
  name = excluded.name, display_as = excluded.display_as, sort_order = excluded.sort_order;

insert into product_option_groups (product_id, key, name, display_as, sort_order)
select pp.id, 'colour', 'Colour', 'swatch', 2
from package_products pp
on conflict (product_id, key) do update set
  name = excluded.name, display_as = excluded.display_as, sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Size options
-- ---------------------------------------------------------------------------
-- The first size in each group is the baseline at +₹0; the rest are priced
-- relative to it.

insert into product_options (group_id, key, name, price_delta_paise, sort_order)
select g.id, v.okey, v.oname, v.delta, v.sort
from product_option_groups g
join package_products pp on pp.id = g.product_id
join packages p on p.id = pp.package_id
join (values
  ('living-room', 'calm-corner-sofa',     'compact',  'Compact — 240 × 150 cm',   0,       1),
  ('living-room', 'calm-corner-sofa',     'standard', 'Standard — 280 × 160 cm',  1200000, 2),
  ('living-room', 'calm-corner-sofa',     'grand',    'Grand — 320 × 180 cm',     2600000, 3),

  ('living-room', 'ambient-light-system', 'single',   'Single zone',              0,       1),
  ('living-room', 'ambient-light-system', 'dual',     'Two zones',                900000,  2),
  ('living-room', 'ambient-light-system', 'whole',    'Whole room',               1800000, 3),

  ('living-room', 'grounding-rug',        'small',    '170 × 240 cm',             0,       1),
  ('living-room', 'grounding-rug',        'medium',   '200 × 300 cm',             800000,  2),
  ('living-room', 'grounding-rug',        'large',    '240 × 340 cm',             1600000, 3),

  ('bedroom',     'restful-bed-frame',    'queen',    'Queen — 150 × 200 cm',     0,       1),
  ('bedroom',     'restful-bed-frame',    'king',     'King — 180 × 200 cm',      1800000, 2),

  ('bedroom',     'soft-light-bedside',   'single',   'Single unit',              0,       1),
  ('bedroom',     'soft-light-bedside',   'pair',     'Pair',                     650000,  2),

  ('bedroom',     'quiet-storage-bench',  'small',    '100 × 42 cm',              0,       1),
  ('bedroom',     'quiet-storage-bench',  'standard', '120 × 42 cm',              450000,  2),
  ('bedroom',     'quiet-storage-bench',  'large',    '150 × 42 cm',              900000,  3)
) as v(pkey, prodkey, okey, oname, delta, sort) on true
where p.key = v.pkey and pp.key = v.prodkey and g.key = 'size'
on conflict (group_id, key) do update set
  name              = excluded.name,
  price_delta_paise = excluded.price_delta_paise,
  sort_order        = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Colour options
-- ---------------------------------------------------------------------------
-- Colours currently cost the same as each other, but the delta column is
-- there so a premium finish can be priced without a schema change.

insert into product_options (
  group_id, key, name, price_delta_paise,
  image_paths, swatch_hex, finish, material, sort_order
)
select g.id, v.okey, v.oname, v.delta, array[v.img], v.hex, v.finish, v.material, v.sort
from product_option_groups g
join package_products pp on pp.id = g.product_id
join packages p on p.id = pp.package_id
join (values
  ('living-room','calm-corner-sofa','sand','Sand',0,
   'https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=1200&q=85','#d0b28e','Warm sand','Textured linen',1),
  ('living-room','calm-corner-sofa','teal','Teal',0,
   'https://images.unsplash.com/photo-1554995207-c18c203602cb?auto=format&fit=crop&w=1200&q=85','#0c4444','Deep teal','Performance velvet',2),
  ('living-room','calm-corner-sofa','burgundy','Burgundy',0,
   'https://images.unsplash.com/photo-1493666438817-866a91353ca9?auto=format&fit=crop&w=1200&q=85','#6f222a','Soft burgundy','Brushed cotton',3),

  ('living-room','ambient-light-system','sand','Sand',0,
   'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1200&q=85','#d0b28e','Brass sand','Powder-coated metal',1),
  ('living-room','ambient-light-system','teal','Teal',0,
   'https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=1200&q=85','#0c4444','Teal shade','Tinted glass',2),
  ('living-room','ambient-light-system','burgundy','Burgundy',0,
   'https://images.unsplash.com/photo-1540932239986-30128078f3c5?auto=format&fit=crop&w=1200&q=85','#6f222a','Burgundy shade','Hand-finished glass',3),

  ('living-room','grounding-rug','sand','Sand',0,
   'https://images.unsplash.com/photo-1600210492486-724fe5c67fb0?auto=format&fit=crop&w=1200&q=85','#d0b28e','Oat sand','Wool blend',1),
  ('living-room','grounding-rug','teal','Teal',0,
   'https://images.unsplash.com/photo-1600166898405-da9535204843?auto=format&fit=crop&w=1200&q=85','#0c4444','Teal weave','Recycled wool',2),
  ('living-room','grounding-rug','burgundy','Burgundy',0,
   'https://images.unsplash.com/photo-1600566753086-00f18fb6b3ea?auto=format&fit=crop&w=1200&q=85','#6f222a','Burgundy weave','Wool + jute',3),

  ('bedroom','restful-bed-frame','sand','Sand',0,
   'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=85','#d0b28e','Natural sand','Oak veneer',1),
  ('bedroom','restful-bed-frame','teal','Teal',0,
   'https://images.unsplash.com/photo-1616594039964-ae9021a400a0?auto=format&fit=crop&w=1200&q=85','#0c4444','Deep teal','Upholstered fabric',2),
  ('bedroom','restful-bed-frame','burgundy','Burgundy',0,
   'https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?auto=format&fit=crop&w=1200&q=85','#6f222a','Soft burgundy','Brushed linen',3),

  ('bedroom','soft-light-bedside','sand','Sand',0,
   'https://images.unsplash.com/photo-1549497538-303791108f95?auto=format&fit=crop&w=1200&q=85','#d0b28e','Sand ceramic','Ceramic + linen',1),
  ('bedroom','soft-light-bedside','teal','Teal',0,
   'https://images.unsplash.com/photo-1513506003901-1e6a229e2d15?auto=format&fit=crop&w=1200&q=85','#0c4444','Teal ceramic','Tinted ceramic',2),
  ('bedroom','soft-light-bedside','burgundy','Burgundy',0,
   'https://images.unsplash.com/photo-1507473885765-e6ed057f782c?auto=format&fit=crop&w=1200&q=85','#6f222a','Burgundy ceramic','Glazed ceramic',3),

  ('bedroom','quiet-storage-bench','sand','Sand',0,
   'https://images.unsplash.com/photo-1586023492125-27b2c045efd7?auto=format&fit=crop&w=1200&q=85','#d0b28e','Sand oak','Oak + cotton',1),
  ('bedroom','quiet-storage-bench','teal','Teal',0,
   'https://images.unsplash.com/photo-1558997519-83ea9252edf8?auto=format&fit=crop&w=1200&q=85','#0c4444','Teal upholstery','Oak + velvet',2),
  ('bedroom','quiet-storage-bench','burgundy','Burgundy',0,
   'https://images.unsplash.com/photo-1616486029423-aaa4789e8c9a?auto=format&fit=crop&w=1200&q=85','#6f222a','Burgundy upholstery','Oak + linen',3)
) as v(pkey, prodkey, okey, oname, delta, img, hex, finish, material, sort) on true
where p.key = v.pkey and pp.key = v.prodkey and g.key = 'colour'
on conflict (group_id, key) do update set
  name              = excluded.name,
  price_delta_paise = excluded.price_delta_paise,
  image_paths       = excluded.image_paths,
  swatch_hex        = excluded.swatch_hex,
  finish            = excluded.finish,
  material          = excluded.material,
  sort_order        = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Add-ons
-- ---------------------------------------------------------------------------

insert into package_addons (package_id, key, name, description, image_path, price_paise, sort_order)
select p.id, v.key, v.name, v.description, v.image_path, v.price_paise, v.sort_order
from packages p
join (values
  ('living-room', 'living-aroma', 'Aroma diffuser',
   'A quiet diffuser with gentle, programmable scent sessions.',
   'https://images.unsplash.com/photo-1603006905003-be475563bc59?auto=format&fit=crop&w=800&q=85',  450000, 1),
  ('living-room', 'living-panel', 'Acoustic panel',
   'Softens everyday sound with a clean, architectural finish.',
   'https://images.unsplash.com/photo-1594620302200-9a762244a156?auto=format&fit=crop&w=800&q=85', 1200000, 2),
  ('living-room', 'living-throw', 'Weighted throw',
   'A comforting tactile layer for rest, focus, or decompression.',
   'https://images.unsplash.com/photo-1575410229391-19b4da01cc94?auto=format&fit=crop&w=800&q=85',  320000, 3),

  ('bedroom', 'bedroom-blackout', 'Blackout curtains',
   'Layered curtains to reduce light and support a more consistent sleep setting.',
   'https://images.unsplash.com/photo-1505693416388-ac5ce068fe85?auto=format&fit=crop&w=800&q=85', 850000, 1),
  ('bedroom', 'bedroom-sound', 'Sound machine',
   'Soft, consistent soundscapes for rest, sleep, or moments of quiet focus.',
   'https://images.unsplash.com/photo-1600080972464-8e5f35f63d08?auto=format&fit=crop&w=800&q=85', 650000, 2),
  ('bedroom', 'bedroom-weighted', 'Weighted blanket',
   'A reassuring layer designed for calmer settling and deeper relaxation.',
   'https://images.unsplash.com/photo-1513694203232-719a280e022f?auto=format&fit=crop&w=800&q=85', 490000, 3)
) as v(pkey, key, name, description, image_path, price_paise, sort_order) on true
where p.key = v.pkey
on conflict (package_id, key) do update set
  name = excluded.name, description = excluded.description,
  image_path = excluded.image_path,
  price_paise = excluded.price_paise, sort_order = excluded.sort_order;


-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Expect: living-room ₹1,85,000 / 3 products / 6 groups / 18 options / 3 addons
--         bedroom     ₹1,65,000 / 3 products / 6 groups / 16 options / 3 addons

select
  p.key,
  p.base_price_paise / 100 as base_price_rupees,
  (select count(*) from package_products pp where pp.package_id = p.id) as products,
  (select count(*) from product_option_groups g
     join package_products pp2 on pp2.id = g.product_id
    where pp2.package_id = p.id) as option_groups,
  (select count(*) from product_options o
     join product_option_groups g2 on g2.id = o.group_id
     join package_products pp3 on pp3.id = g2.product_id
    where pp3.package_id = p.id) as options,
  (select count(*) from package_addons pa where pa.package_id = p.id) as addons
from packages p
order by p.sort_order;
