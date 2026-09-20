-- ============================================================================
-- Migration 050 — Turnkey gallery (portfolio)
-- ============================================================================
--
-- Run ONCE, after 049.
--
-- A curated portfolio of finished turnkey projects, shown on the public gallery
-- page. Each item is created and photographed by staff (standalone — not tied to
-- a project row): title, category (Residential / Commercial), location, blurb,
-- an ordered set of photos with one chosen as the cover, a published flag and a
-- sort order.
--
-- Published items are world-readable (the gallery page uses the anon key);
-- everything else is admin-only. Photos live in a PUBLIC 'turnkey-gallery'
-- Storage bucket (admin-write, public-read).
-- ============================================================================

begin;

create table if not exists turnkey_gallery (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  category     text,                    -- 'Residential' | 'Commercial' (free text)
  location     text,
  blurb        text,
  cover_photo  text,                    -- storage path of the cover (one of photos)
  photos       jsonb not null default '[]'::jsonb,   -- ordered storage paths
  published    boolean not null default false,
  sort_order   integer,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table turnkey_gallery is
  'Curated portfolio of finished turnkey projects for the public gallery page.
   Photos live in the public turnkey-gallery bucket.';

create index if not exists turnkey_gallery_published_idx
  on turnkey_gallery (published, sort_order);

drop trigger if exists turnkey_gallery_touch on turnkey_gallery;
create trigger turnkey_gallery_touch
  before update on turnkey_gallery
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — public reads PUBLISHED items; admins do everything
-- ---------------------------------------------------------------------------
alter table turnkey_gallery enable row level security;

grant select on turnkey_gallery to anon, authenticated;
grant insert, update, delete on turnkey_gallery to authenticated;

drop policy if exists turnkey_gallery_public_read on turnkey_gallery;
create policy turnkey_gallery_public_read on turnkey_gallery
  for select to anon, authenticated
  using (published = true);

drop policy if exists turnkey_gallery_admin_all on turnkey_gallery;
create policy turnkey_gallery_admin_all on turnkey_gallery
  for all to authenticated
  using (is_admin()) with check (is_admin());

-- ---------------------------------------------------------------------------
-- Storage bucket for gallery photos — PUBLIC read, admin write
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('turnkey-gallery', 'turnkey-gallery', true)
on conflict (id) do nothing;

drop policy if exists turnkey_gallery_objects_admin_write on storage.objects;
create policy turnkey_gallery_objects_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'turnkey-gallery' and is_admin())
  with check (bucket_id = 'turnkey-gallery' and is_admin());

commit;
