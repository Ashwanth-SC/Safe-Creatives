// ============================================================================
// compute-wall-panel — price one Wall Panel (backend maths)
// ============================================================================
//
// Inputs: space, panel_type (Direct|Base|Framed), plywood_brand +
// plywood_sub_category, laminate_brand + laminate_id, length_mm, width_mm,
// special_additions, labour_lines, project_id.
//
// Units: products are in FEET (area_sqft = std_width*std_height); dimensions
// come in mm and convert internally. Prices are PER SHEET (the price_per_sqft
// column, mirroring Box & Shutters). Plywood thickness is in mm.
//
// Materials:
//   * laminate/panel: cover = L*W (mm^2 -> sqft); sheets = ceil(cover /
//     lam sheet area); price = sheets * price.
//   * Direct  — laminate only.
//   * Base    — laminate + 8 mm plywood (brand+type at 8 mm); ply cover = L*W.
//   * Framed  — laminate + 16 mm plywood (brand+type at 16 mm); ply cover =
//     face (L*W) + frame. Frame = vertical strips (floor(width_ft) strips, each
//     3" wide x (L-1ft) tall) + 2 horizontal strips (3" wide x full width).
//     Face + frame are summed into one 16 mm plywood quantity.
//
// Totals: material + special + labour -> base total; margin, discount, GST from
// the project percentages cascade over all of it (special names also append to
// the design spec). On save: stores the panel + rebuilds the shared BOQ.
//
// Needs migration 033. Deploy: supabase functions deploy compute-wall-panel
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rebuildBoq } from "../_shared/rebuild-boq.ts";

const SQFT_PER_MM2 = 92903.04;
const FT_MM = 304.8;
const STRIP_MM = 76.2; // 3 inches

function corsHeadersFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get("SITE_ORIGIN") ?? "*").split(",").map((v) => v.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  const allow = configured.includes("*") ? "*" : configured.includes(origin) ? origin : configured[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
const ceilDiv = (a: number, b: number) => (b > 0 && a > 0 ? Math.ceil(a / b) : 0);

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);
  const { data: userRes, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userRes?.user) return json({ error: "Not signed in" }, 401);
  const { data: me } = await admin.from("profiles").select("is_admin").eq("id", userRes.user.id).maybeSingle();
  if (!me?.is_admin) return json({ error: "Admins only" }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // BOQ-only rebuild (called after a delete).
  if (body.recompute_boq) {
    if (!body.project_id) return json({ error: "Missing project." }, 400);
    await rebuildBoq(admin, String(body.project_id));
    return json({ ok: true });
  }

  const panelType = String(body.panel_type ?? "").trim().toLowerCase(); // direct | base | framed
  if (!["direct", "base", "framed"].includes(panelType)) return json({ error: "Choose a panel type (Direct, Base or Framed)." }, 400);
  const L = num(body.length_mm);
  const W = num(body.width_mm);
  if (!(L > 0) || !(W > 0)) return json({ error: "Enter a length and width (mm)." }, 400);
  if (!body.laminate_id) return json({ error: "Choose a laminate / panel." }, 400);

  const faceSqft = (L * W) / SQFT_PER_MM2;

  // ---- Laminate / panel ----------------------------------------------------
  const { data: lamProd } = await admin
    .from("turnkey_products")
    .select("id, product_name, supplier, brand, thickness, area_sqft, price_per_sqft")
    .eq("id", String(body.laminate_id))
    .maybeSingle();
  const lamSheet = lamProd ? Number(lamProd.area_sqft) || 0 : 0;
  const lamPricePer = lamProd ? Number(lamProd.price_per_sqft) || 0 : 0;
  const lamQty = lamProd && lamSheet > 0 ? ceilDiv(faceSqft, lamSheet) : null;
  const lamPrice = lamQty != null ? round2(lamQty * lamPricePer) : 0;

  // ---- Plywood (Base = 8 mm face; Framed = 16 mm face + frame) --------------
  const plyBrand = body.plywood_brand ? String(body.plywood_brand) : null;
  const plySub = body.plywood_sub_category ? String(body.plywood_sub_category) : null;
  const plyThickness = panelType === "base" ? 8 : panelType === "framed" ? 16 : null;

  // Frame area (Framed only): floor(width_ft) vertical strips 3" x (L-1ft),
  // plus 2 horizontal strips 3" x full width.
  let frameSqft = 0;
  if (panelType === "framed") {
    // One vertical strip per whole foot of width (floor); +1e-9 so a clean
    // whole-foot width doesn't fall to 5.9999… and floor down a strip.
    const vCount = Math.floor(W / FT_MM + 1e-9);
    const vHeightMm = Math.max(0, L - FT_MM); // (length - 1 ft)
    const frameMm2 = vCount * STRIP_MM * vHeightMm + 2 * STRIP_MM * W;
    frameSqft = frameMm2 / SQFT_PER_MM2;
  }
  const plyCoverSqft = panelType === "base" ? faceSqft : panelType === "framed" ? faceSqft + frameSqft : 0;

  let plyBoard: Any = null;
  if (plyThickness && plyBrand) {
    let q = admin.from("turnkey_products").select("id, product_name, supplier, thickness, area_sqft, price_per_sqft").eq("brand", plyBrand);
    if (plySub) q = q.eq("sub_category", plySub);
    const { data } = await q;
    plyBoard = (data ?? []).find((p: Any) => num(p.thickness) === plyThickness) ?? null;
  }
  const plySheet = plyBoard ? Number(plyBoard.area_sqft) || 0 : 0;
  const plyPricePer = plyBoard ? Number(plyBoard.price_per_sqft) || 0 : 0;
  const plyQty = plyThickness && plyBoard && plySheet > 0 ? ceilDiv(plyCoverSqft, plySheet) : null;
  const plyPrice = plyQty != null ? round2(plyQty * plyPricePer) : 0;
  const plyMissing = plyThickness != null && !plyBoard;

  const materialTotal = round2(lamPrice + plyPrice);

  // ---- BOQ lines -----------------------------------------------------------
  const boqLines: { product_name: string; category: string; quantity: number; supplier: string | null; unit_price: number | null }[] = [];
  if (lamProd && lamQty && lamQty > 0) boqLines.push({ product_name: String(lamProd.product_name ?? ""), category: "Laminate/panel", quantity: lamQty, supplier: lamProd.supplier ?? null, unit_price: lamPricePer });
  if (plyBoard && plyQty && plyQty > 0) boqLines.push({ product_name: String(plyBoard.product_name ?? ""), category: "Plywood", quantity: plyQty, supplier: plyBoard.supplier ?? null, unit_price: plyPricePer });

  // ---- Special additions ---------------------------------------------------
  const specialIn = Array.isArray(body.special_additions) ? (body.special_additions as Any[]) : [];
  const specialTable = specialIn
    .map((s: Any) => ({ name: String(s?.name ?? "").trim(), cost: round2(num(s?.cost)) }))
    .filter((s) => s.name || s.cost > 0);
  const specialTotal = round2(specialTable.reduce((sum, s) => sum + (s.cost || 0), 0));

  // ---- Category sqft (drives the labour sqft picker) -----------------------
  const categorySqft: { category: string; sqft: number }[] = [{ category: "Laminate/panel", sqft: round2(faceSqft) }];
  if (panelType === "base") categorySqft.push({ category: "Plywood (8 mm)", sqft: round2(faceSqft) });
  if (panelType === "framed") categorySqft.push({ category: "Plywood (16 mm)", sqft: round2(plyCoverSqft) });
  const catSqftLookup = new Map(categorySqft.map((r) => [r.category, r.sqft]));

  // ---- Labour --------------------------------------------------------------
  const labourIn = Array.isArray(body.labour_lines) ? (body.labour_lines as Any[]) : [];
  const labourIds = labourIn.map((l: Any) => l?.labour_id).filter(Boolean).map(String);
  const labourById = new Map<string, Any>();
  if (labourIds.length) {
    const { data } = await admin.from("turnkey_labour").select("id, category, name, task, cost_per_day, cost_per_sqft").in("id", [...new Set(labourIds)]);
    (data ?? []).forEach((r: Any) => labourById.set(String(r.id), r));
  }
  const labourTable = labourIn.map((l: Any) => {
    const row = l?.labour_id ? labourById.get(String(l.labour_id)) : undefined;
    const days = num(l?.total_days);
    const cats = Array.isArray(l?.sqft_categories) ? (l.sqft_categories as Any[]).map(String) : [];
    const sqft = cats.length
      ? round2(cats.reduce((s: number, c: string) => s + (catSqftLookup.get(c) || 0), 0))
      : num(l?.total_sqft);
    const perDay = row ? Number(row.cost_per_day) || 0 : 0;
    const perSqft = row ? Number(row.cost_per_sqft) || 0 : 0;
    const cost = round2(days * perDay + sqft * perSqft);
    return {
      labour_id: l?.labour_id ? String(l.labour_id) : null,
      category: row ? String(row.category ?? "") : (l?.category ? String(l.category) : null),
      name: row ? String(row.name ?? "") : (l?.name ? String(l.name) : null),
      task: row ? String(row.task ?? "") : (l?.task ? String(l.task) : null),
      total_days: days,
      sqft_categories: cats,
      total_sqft: sqft,
      cost,
    };
  });
  const labourTotal = round2(labourTable.reduce((sum, l) => sum + (l.cost || 0), 0));

  // ---- Totals --------------------------------------------------------------
  let margin = 0, gst = 0, discount = 0;
  if (body.project_id) {
    const { data: proj } = await admin.from("turnkey_projects").select("margin_percent, gst_percent, discount_percent").eq("id", String(body.project_id)).maybeSingle();
    margin = Number(proj?.margin_percent) || 0;
    gst = Number(proj?.gst_percent) || 0;
    discount = Number(proj?.discount_percent) || 0;
  }
  const total = round2(materialTotal + specialTotal + labourTotal);
  const withMargin = round2(total * (1 + margin / 100));
  const marginAmount = round2(withMargin - total);
  const withDiscount = round2(withMargin * (1 - discount / 100));
  const withGst = round2(withDiscount * (1 + gst / 100));

  // ---- Spec strings --------------------------------------------------------
  const clean = (arr: (string | null | undefined)[]) => arr.map((s) => (s ?? "").trim()).filter(Boolean);
  const laminateBrand = body.laminate_brand ? String(body.laminate_brand) : (lamProd ? String(lamProd.brand ?? "") : null);
  const lamName = lamProd ? String(lamProd.product_name ?? "") : null;
  const boardName = plyBoard ? String(plyBoard.product_name ?? "") : null;
  const typeLabel = panelType.charAt(0).toUpperCase() + panelType.slice(1);
  const materialSpec = clean([boardName, laminateBrand, lamName]).join(", ");
  const specialNames = specialTable.map((s) => s.name);
  const designSpec = clean([typeLabel, laminateBrand, lamName, ...specialNames]).join(", ");

  const computed = {
    panel_type: typeLabel,
    dimensions: { length_mm: L, width_mm: W, face_sqft: round2(faceSqft), frame_sqft: round2(frameSqft) },
    laminate: { name: lamName, thickness: lamProd ? num(lamProd.thickness) : null, cover_sqft: round2(faceSqft), qty: lamQty, price: lamPrice, missing: !lamProd },
    plywood: {
      thickness: plyThickness,
      name: boardName,
      cover_sqft: round2(plyCoverSqft),
      qty: plyQty,
      price: plyPrice,
      missing: plyMissing,
      applies: plyThickness != null,
    },
    special: { total: specialTotal, table: specialTable },
    labour: { total: labourTotal, table: labourTable },
    category_sqft: categorySqft,
    totals: {
      material: materialTotal,
      special: specialTotal,
      labour: labourTotal,
      total,
      with_margin: withMargin,
      margin_amount: marginAmount,
      with_discount: withDiscount,
      with_gst: withGst,
    },
    boq_lines: boqLines,
    margin_percent: margin, discount_percent: discount, gst_percent: gst,
  };

  // ---- Save + rebuild BOQ --------------------------------------------------
  let panelId = body.unit_id ? String(body.unit_id) : null;
  if (body.save) {
    if (!body.project_id) return json({ error: "Missing project." }, 400);
    const row = {
      project_id: String(body.project_id),
      space: body.space ? String(body.space) : null,
      panel_type: typeLabel,
      plywood_brand: plyBrand,
      plywood_sub_category: plySub,
      laminate_brand: laminateBrand,
      laminate_id: body.laminate_id ? String(body.laminate_id) : null,
      length_mm: L,
      width_mm: W,
      special_additions: specialTable,
      labour_lines: labourTable,
      total_material_price: materialTotal,
      special_price: specialTotal,
      labour_price: labourTotal,
      total_price: total,
      margin_price: withMargin,
      margin_amount: marginAmount,
      discount_price: withDiscount,
      gst_price: withGst,
      material_spec: materialSpec,
      design_spec: designSpec,
      computed,
    };
    if (panelId) {
      const { error } = await admin.from("turnkey_quote_wall_panels").update(row).eq("id", panelId);
      if (error) return json({ error: `Save failed: ${error.message}` }, 500);
    } else {
      const { data, error } = await admin.from("turnkey_quote_wall_panels").insert(row).select("id").single();
      if (error) return json({ error: `Save failed: ${error.message}` }, 500);
      panelId = data.id;
    }
    await rebuildBoq(admin, String(body.project_id));
  }

  return json({ ok: true, computed, material_spec: materialSpec, design_spec: designSpec, unit_id: panelId, saved: Boolean(body.save) });
});
