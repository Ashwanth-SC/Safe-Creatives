-- ============================================================================
-- Migration 003 — package cover images and default-selected add-ons
-- ============================================================================
--
-- Run ONCE, after 002-option-images.sql.
--
-- Two additions:
--
--   packages.cover_image_path
--     The photo on the Sensory Rooms cards. It was hardcoded in packages.css
--     as .living-card / .bedroom-card, which meant a new package rendered
--     with no image and needed a stylesheet edit to fix. Now it is catalog
--     data like everything else.
--
--   package_addons.is_default_selected
--     A new configuration starts with add-ons already ticked, and the
--     customer removes what they do not want. Per add-on rather than a blanket
--     rule, so a rarely-wanted extra can default to off.
-- ============================================================================

begin;

alter table packages
  add column if not exists cover_image_path text;

alter table package_addons
  add column if not exists is_default_selected boolean not null default true;

-- Carry across the two images that were living in packages.css.
update packages set cover_image_path =
  'https://images.unsplash.com/photo-1556228720-195a672e8a03?auto=format&fit=crop&w=1600&q=85'
where key = 'living-room' and cover_image_path is null;

update packages set cover_image_path =
  'https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1600&q=85'
where key = 'bedroom' and cover_image_path is null;

commit;


-- Check:
-- select key, is_active, left(cover_image_path, 48) as cover from packages order by sort_order;
-- select key, name, is_default_selected from package_addons order by package_id, sort_order;
