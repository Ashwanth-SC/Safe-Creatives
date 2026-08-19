// ============================================================================
// compute-wall-panel — price one Wall Panel (backend maths)
// ============================================================================
//
// Inputs: space, panel_type (Direct|Base|Framed), plywood_brand +
// plywood_sub_category, laminate_id, length_ft, height_ft (FEET),
// special_additions [{hardware_id, quantity}], labour_lines, project_id.
//
// Units: everything in FEET. face sqft = L*H. Products' area_sqft is the sheet
// area; price_per_sqft is the per-SHEET price. Laminate is picked directly.
//
// Materials:
//   * laminate/panel: sheets = ceil(face / lam sheet area); price = sheets*price.
//   * Direct  — laminate only.
//   * Base    — laminate + 8 mm ply face (cover = L*H).
//   * Framed  — laminate + 12 mm ply face (L*H) + 16 mm ply frame. Frame sqft =
//     (L*0.25*2) + ((H-2)*0.25*floor(H)).
//   * special additions — hardware product + quantity (price = qty*hw price).
//
// Totals: material + special + labour -> base total; margin, discount, GST from
// the project percentages cascade. Emits a materials breakdown (supplier /
// category / product / qty / price) that feeds the vendor BOQ. On save: stores
// the panel + rebuilds the shared BOQ.
//
// Needs migrations 033 + 039. Deploy: supabase functions deploy compute-wall-panel
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rebuildBoq } from "../_shared/rebuild-boq.ts";

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
  const L = num(body.length_ft); // feet
  const H = num(body.height_ft); // feet
  if (!(L > 0) || !(H > 0)) return json({ error: "Enter a length and height (feet)." }, 400);
  if (!body.laminate_id) return json({ error: "Choose a laminate / panel." }, 400);

  const faceSqft = round2(L * H);

  // ---- Laminate / panel (picked directly, no brand) -----------------------
  const { data: lamProd } = await admin
    .from("turnkey_products")
    .select("id, product_name, supplier, category, thickness, area_sqft, price_per_sqft")
    .eq("id", String(body.laminate_id))
    .maybeSingle();
  const lamName = lamProd ? String(lamProd.product_name ?? "") : null;
  const lamSheet = lamProd ? Number(lamProd.area_sqft) || 0 : 0;
  const lamPricePer = lamProd ? Number(lamProd.price_per_sqft) || 0 : 0;
  const lamQty = lamProd && lamSheet > 0 ? ceilDiv(faceSqft, lamSheet) : null;
  const lamPrice = lamQty != null ? round2(lamQty * lamPricePer) : 0;

  // ---- Plywood: Base = 8mm face; Framed = 12mm face + 16mm frame -----------
  const plyBrand = body.plywood_brand ? String(body.plywood_brand) : null;
  const plySub = body.plywood_sub_category ? String(body.plywood_sub_category) : null;

  // Frame area (Framed only), sqft: 2 horizontal strips (L x 0.25ft) plus
  // floor(H) vertical strips ((H-2) x 0.25ft).
  const frameSqft = panelType === "framed"
    ? round2(L * 0.25 * 2 + Math.max(0, H - 2) * 0.25 * Math.floor(H + 1e-9))
    : 0;

  // Per-thickness plywood requirement.
  const plyReq: { thickness: number; coverSqft: number }[] = [];
  if (panelType === "base") plyReq.push({ thickness: 8, coverSqft: faceSqft });
  if (panelType === "framed") { plyReq.push({ thickness: 12, coverSqft: faceSqft }); plyReq.push({ thickness: 16, coverSqft: frameSqft }); }

  let plyProducts: Any[] = [];
  if (plyReq.length && plyBrand) {
    let q = admin.from("turnkey_products").select("id, product_name, supplier, category, thickness, area_sqft, price_per_sqft").eq("brand", plyBrand);
    if (plySub) q = q.eq("sub_category", plySub);
    const { data } = await q;
    plyProducts = data ?? [];
  }
  const plywood = plyReq.map((req) => {
    const board = plyProducts.find((p: Any) => num(p.thickness) === req.thickness) ?? null;
    const sheet = board ? Number(board.area_sqft) || 0 : 0;
    const pricePer = board ? Number(board.price_per_sqft) || 0 : 0;
    const qty = board && sheet > 0 ? ceilDiv(req.coverSqft, sheet) : null;
    const price = qty != null ? round2(qty * pricePer) : 0;
    return {
      thickness: req.thickness, cover_sqft: round2(req.coverSqft),
      name: board ? String(board.product_name ?? "") : null,
      supplier: board ? (board.supplier ?? null) : null,
      category: board ? String(board.category ?? "") : null,
      qty, price, price_per: pricePer, missing: !board,
    };
  });
  const plyPrice = round2(plywood.reduce((s, p) => s + (p.price || 0), 0));

  // ---- Special additions: hardware product + quantity ---------------------
  const specialIn = Array.isArray(body.special_additions) ? (body.special_additions as Any[]) : [];
  const specialHwIds = specialIn.map((s: Any) => s?.hardware_id).filter(Boolean).map(String);
  const specialHwById = new Map<string, Any>();
  if (specialHwIds.length) {
    const { data } = await admin.from("turnkey_hardwares").select("id, product_name, supplier, category, price").in("id", [...new Set(specialHwIds)]);
    (data ?? []).forEach((h: Any) => specialHwById.set(String(h.id), h));
  }
  const specialTable = specialIn.map((s: Any) => {
    const hw = s?.hardware_id ? specialHwById.get(String(s.hardware_id)) : undefined;
    const qty = num(s?.quantity);
    const unitPrice = hw ? Number(hw.price) || 0 : 0;
    return {
      hardware_id: s?.hardware_id ? String(s.hardware_id) : null,
      product_name: hw ? String(hw.product_name ?? "") : (s?.product_name ? String(s.product_name) : null),
      supplier: hw ? (hw.supplier ?? null) : null,
      category: hw ? String(hw.category ?? "") : null,
      quantity: qty, unit_price: unitPrice, cost: round2(qty * unitPrice),
    };
  }).filter((s) => s.hardware_id || s.quantity);
  const specialTotal = round2(specialTable.reduce((sum, s) => sum + (s.cost || 0), 0));

  const materialTotal = round2(lamPrice + plyPrice);

  // ---- Materials breakdown + BOQ lines ------------------------------------
  const materials: Any[] = [];
  const boqLines: Any[] = [];
  const pushMat = (supplier: Any, category: Any, product: Any, quantity: Any, unit_price: Any, price: Any) => {
    materials.push({ supplier: supplier ?? null, category: category ?? null, product: product ?? "", quantity, unit_price, price });
    if (quantity && quantity > 0) boqLines.push({ product_name: String(product ?? ""), category: category ?? null, quantity, supplier: supplier ?? null, unit_price });
  };
  if (lamProd && lamQty && lamQty > 0) pushMat(lamProd.supplier ?? null, lamProd.category || "Laminate/panel", lamName, lamQty, lamPricePer, lamPrice);
  plywood.forEach((p) => { if (p.qty && p.qty > 0) pushMat(p.supplier, p.category || `Plywood ${p.thickness}mm`, p.name, p.qty, p.price_per, p.price); });
  specialTable.forEach((s) => { if (s.quantity && s.quantity > 0) pushMat(s.supplier, s.category || "Special addition", s.product_name, s.quantity, s.unit_price, s.cost); });

  // ---- Category sqft (drives the labour sqft picker) -----------------------
  const categorySqft: { category: string; sqft: number }[] = [{ category: "Laminate/panel", sqft: faceSqft }];
  plywood.forEach((p) => categorySqft.push({ category: `Plywood (${p.thickness} mm)`, sqft: p.cover_sqft }));
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
  const typeLabel = panelType.charAt(0).toUpperCase() + panelType.slice(1);
  const plyNames = plywood.map((p) => p.name);
  const specialNames = specialTable.map((s) => s.product_name);
  const materialSpec = clean([...plyNames, lamName, ...specialNames]).join(", ");
  const designSpec = clean([typeLabel, lamName, ...specialNames]).join(", ");

  const computed = {
    panel_type: typeLabel,
    dimensions: { length_ft: L, height_ft: H, face_sqft: faceSqft, frame_sqft: round2(frameSqft) },
    laminate: { name: lamName, thickness: lamProd ? num(lamProd.thickness) : null, cover_sqft: faceSqft, qty: lamQty, price: lamPrice, missing: !lamProd },
    plywood,
    materials,
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
      laminate_brand: null,
      laminate_id: body.laminate_id ? String(body.laminate_id) : null,
      length_ft: L,
      height_ft: H,
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
