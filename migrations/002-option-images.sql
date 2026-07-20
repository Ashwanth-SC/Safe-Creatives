-- ============================================================================
-- Migration 002 — multiple images per option
-- ============================================================================
--
-- Run ONCE, after 001-option-groups.sql.
--
-- Each colour gets a gallery rather than a single photo. Size options keep no
-- images of their own: a King bed in Sand looks like the Sand photos, so the
-- gallery belongs to the colour and size only changes the price.
--
-- Stored as a text[] rather than four columns or a child table: it is ordered,
-- needs no join to render, and does not cap you at four if you later want six.
-- The admin page presents four slots because that is the house style, not
-- because the schema requires it.
--
-- package_addons keeps its single image_path -- one image each, as intended.
-- ============================================================================

begin;

alter table product_options
  add column if not exists image_paths text[] not null default '{}';

-- Carry the existing single image across as the first gallery entry.
update product_options
set image_paths = array[image_path]
where image_path is not null
  and image_path <> ''
  and cardinality(image_paths) = 0;

alter table product_options drop column if exists image_path;

commit;


-- Check: every colour option should have one image, sizes none.
-- select g.name as group_name, o.name, cardinality(o.image_paths) as images
-- from product_options o
-- join product_option_groups g on g.id = o.group_id
-- order by g.name, o.sort_order;
