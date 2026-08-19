-- ============================================================================
-- Migration 038 — Quotation: Civil Work + Electrical Work
-- ============================================================================
--
-- Run ONCE, after 037.
--
-- Civil and Electrical are composite units (like Box & Shutters, but manual):
-- each unit has a space, name and design spec, plus three sub-sections stored
-- as JSON — Material (supplier + product + quantity → price), Labour (category/
-- name/task + days + sqft → price) and Special additions (name + cost). The
-- project margin / discount / GST cascade over the summed total (snapshot).
--
--   material_lines : [{ supplier, product_id, product_name, quantity, unit_price, total }]
--   labour_lines   : [{ labour_id, category, name, task, total_days, total_sqft, cost }]
--   special_additions : [{ name, cost }]
--   material_spec  : product names + special-addition names, comma-joined
--
-- The material lines feed the Vendor BOQ (per supplier); the labour lines feed
-- the Labour BOQ (per labour name). Both read straight from these tables — saved
-- client-side (RLS admin), no edge function.
--
-- Access: staff only, via is_admin().
-- ============================================================================

begin;

do $$
declare tbl text;
begin
  foreach tbl in array array['turnkey_quote_civil', 'turnkey_quote_electrical'] loop
    execute format($f$
      create table if not exists %I (
        id                   uuid primary key default gen_random_uuid(),
        project_id           uuid not null references turnkey_projects(id) on delete cascade,
        space                text,
        unit_name            text,
        design_spec          text,
        material_lines       jsonb,
        labour_lines         jsonb,
        special_additions    jsonb,
        material_spec        text,
        total_material_price numeric,
        labour_price         numeric,
        special_price        numeric,
        total_price          numeric,
        margin_price         numeric,
        margin_amount        numeric,
        discount_price       numeric,
        gst_price            numeric,
        sort_order           integer,
        created_at           timestamptz not null default now(),
        updated_at           timestamptz not null default now()
      );
    $f$, tbl);
    execute format('create index if not exists %I on %I (project_id, sort_order)', tbl || '_project_idx', tbl);
    execute format('drop trigger if exists %I on %I', tbl || '_touch', tbl);
    execute format('create trigger %I before update on %I for each row execute function touch_updated_at()', tbl || '_touch', tbl);
    execute format('alter table %I enable row level security', tbl);
    execute format('grant select, insert, update, delete on %I to authenticated', tbl);
    execute format('drop policy if exists %I on %I', tbl || '_admin_all', tbl);
    execute format('create policy %I on %I for all to authenticated using (is_admin()) with check (is_admin())', tbl || '_admin_all', tbl);
  end loop;
end $$;

comment on table turnkey_quote_civil is
  'Civil Work quotation units (manual). Material/Labour/Special sub-sections as
   JSON; material_lines feed the Vendor BOQ, labour_lines the Labour BOQ.';
comment on table turnkey_quote_electrical is
  'Electrical Work quotation units (manual). Same shape as turnkey_quote_civil.';

commit;
