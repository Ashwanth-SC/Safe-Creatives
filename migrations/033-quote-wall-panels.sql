-- ============================================================================
-- Migration 033 — Quotation: Wall Panels
-- ============================================================================
--
-- Run ONCE, after 032.
--
-- Wall Panels are priced one panel per entry. Three build-ups:
--   * Direct  — laminate/panel pasted straight on the wall (laminate only).
--   * Base    — 8 mm ply on the wall + laminate on top (ply + laminate).
--   * Framed  — a 16 mm ply frame (3" strips) projecting off the wall, a 16 mm
--               ply face on the frame, laminate on top (frame + face + laminate,
--               all 16 mm plywood summed into one quantity).
--
-- Inputs (space, plywood brand/type, laminate brand/product, panel type, L×W in
-- mm) + the computed material total flow through the same Special additions /
-- Labour / margin-discount-GST model as Box & Shutters. The full breakdown is
-- stored as JSON; the boq_lines within it feed the shared project BOQ.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

create table if not exists turnkey_quote_wall_panels (
  id                    uuid primary key default gen_random_uuid(),
  project_id            uuid not null references turnkey_projects(id) on delete cascade,
  space                 text,          -- the "area" dropdown (project space)
  panel_type            text,          -- Direct | Base | Framed
  plywood_brand         text,
  plywood_sub_category  text,
  laminate_brand        text,
  laminate_id           uuid references turnkey_products(id) on delete set null,
  length_mm             numeric,
  width_mm              numeric,
  special_additions     jsonb,         -- [{ name, cost }]
  labour_lines          jsonb,         -- [{ labour_id, ... , cost }]
  total_material_price  numeric,       -- computed: plywood + laminate
  special_price         numeric,
  labour_price          numeric,
  total_price           numeric,       -- material + special + labour
  margin_price          numeric,
  margin_amount         numeric,
  discount_price        numeric,
  gst_price             numeric,
  material_spec         text,
  design_spec           text,
  computed              jsonb,         -- full breakdown (incl. boq_lines)
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

comment on table turnkey_quote_wall_panels is
  'One Wall Panel in a project quotation: inputs + computed material/labour
   totals. One panel per row; the computed boq_lines feed the shared BOQ.';

create index if not exists turnkey_quote_wall_panels_project_idx
  on turnkey_quote_wall_panels (project_id, created_at);

drop trigger if exists turnkey_quote_wall_panels_touch on turnkey_quote_wall_panels;
create trigger turnkey_quote_wall_panels_touch
  before update on turnkey_quote_wall_panels
  for each row execute function touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security — staff only
-- ---------------------------------------------------------------------------
alter table turnkey_quote_wall_panels enable row level security;

grant select, insert, update, delete on turnkey_quote_wall_panels to authenticated;

drop policy if exists turnkey_quote_wall_panels_admin_all on turnkey_quote_wall_panels;
create policy turnkey_quote_wall_panels_admin_all on turnkey_quote_wall_panels
  for all to authenticated using (is_admin()) with check (is_admin());

commit;
