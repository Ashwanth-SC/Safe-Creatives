// ============================================================================
// compute-box-unit — price a Box & Shutters cutlist unit (backend maths)
// ============================================================================
//
// Inputs: csv_text (mm cutlist: Designation "PartCategory-Name", Length, Width,
// Quantity), material_brand + material_sub_category (plywood), inner_laminate_id
// (one common inner laminate), outer_laminate_ids ({panelIndex: product_id}),
// edge_hinge_id + inner_hinge_id, handle_ids ({panelIndex: hardware_id}),
// special_additions [{hardware_id, quantity}], labour_lines, project_id.
//
// Logic (driven by the editable turnkey_box_part_logic table):
//   * plywood: thickness comes from the designation's plywood_thickness (the CSV
//     thickness is ignored). Group panels' cover area (L+2)(W+2)*qty by that
//     thickness; board = brand+type product at that thickness; sheets = ceil.
//   * laminate: inner is one product for the unit (cover = area*inner_lam);
//     outer is chosen PER PANEL (cover per chosen product = area*outer_lam).
//   * hinges: shutter panels get countByDim(max(L,B)) each — Edge Shutter→edge,
//     Inner Shutter→inner (Special shutter ignored via hinge_type None).
//   * handles: chosen PER PANEL; qty = handles*panel qty per chosen handle.
//   * channels (part channel=Yes): pick the channel size <= max(L,B); final qty
//     is HALF the pieces (ceil, bought as sets).
//   * minifix (part minifix=Yes): per panel countByDim(length)+countByDim(width),
//     ×qty; priced against the single "Minifix" hardware.
//   * legs (part legs=Yes): per panel countByDim(max(L,B))*2, ×qty; priced
//     against the single "Legs" hardware.
//   * special additions: hardware product + quantity.
// countByDim: fixed break points 750/900/1200/1500…
//
// Emits a Materials breakdown (supplier/category/product/qty/price) that is the
// vendor-BOQ feed. total = materials + labour; margin/discount/GST cascade.
//
// Needs migrations 027-031 + 040. Deploy: supabase functions deploy compute-box-unit
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { rebuildBoq } from "../_shared/rebuild-boq.ts";

const SQFT_PER_MM2 = 92903.04;
const MM_PER_FT = 304.8;

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
const normPart = (s: unknown) => String(s ?? "").toLowerCase().replace(/[_\s]+/g, " ").trim();
const ceilDiv = (a: number, b: number) => (b > 0 && a > 0 ? Math.ceil(a / b) : 0);
// Fixed break points 750/900/1200/1500…: <750→2, 750–900→3, 900–1200→4, …
const countByDim = (x: number) => (x < 750 ? 2 : x < 900 ? 3 : 4 + Math.floor((x - 900) / 300 + 1e-9));

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

  const csvText = String(body.csv_text ?? "");
  if (!csvText.trim()) return json({ error: "No cutlist CSV provided." }, 400);

  let panels: Panel[];
  try {
    panels = parseCutlist(csvText);
  } catch (e) {
    return json({ error: `Could not read the CSV: ${(e as Error).message}` }, 400);
  }

  // ---- Logic table -> per-part rules --------------------------------------
  const { data: logicRows } = await admin.from("turnkey_box_part_logic").select("*");
  const logic = new Map<string, Any>();
  (logicRows ?? []).forEach((r: Any) => logic.set(normPart(r.part_category), r));
  const DEF = { part_category: null, plywood_thickness: null, outer_lam: 0, inner_lam: 0, hinge_type: "None", handles: 0, channel: "No", minifix: "No", legs: "No" };
  const lg = (partCat: string) => logic.get(partCat) ?? DEF;

  const materialBrand = body.material_brand ? String(body.material_brand) : null;
  const materialSub = body.material_sub_category ? String(body.material_sub_category) : null;
  const outerLamIds: Record<string, string> = (body.outer_laminate_ids && typeof body.outer_laminate_ids === "object") ? (body.outer_laminate_ids as Any) : {};
  const handleIds: Record<string, string> = (body.handle_ids && typeof body.handle_ids === "object") ? (body.handle_ids as Any) : {};

  // Materials breakdown accumulator (supplier / category / product / qty / price).
  const materials: Any[] = [];
  const pushMat = (supplier: Any, category: Any, product: Any, quantity: Any, unit_price: Any, price: Any) => {
    if (!(quantity > 0)) return;
    materials.push({ supplier: supplier ?? null, category: category ?? null, product: product ?? "", quantity, unit_price, price });
  };

  // ---- Plywood: group cover area by the designation's plywood_thickness ----
  const byThickness = new Map<number, { count: number; coverMm2: number }>();
  panels.forEach((p) => {
    const thk = num(lg(p.partCat).plywood_thickness);
    if (!(thk > 0)) return;
    const g = byThickness.get(thk) ?? { count: 0, coverMm2: 0 };
    g.count += p.qty;
    g.coverMm2 += (p.length + 2) * (p.width + 2) * p.qty;
    byThickness.set(thk, g);
  });

  let plyProducts: Any[] = [];
  if (materialBrand) {
    let q = admin.from("turnkey_products").select("id, product_name, supplier, category, thickness, area_sqft, price_per_sqft").eq("brand", materialBrand);
    if (materialSub) q = q.eq("sub_category", materialSub);
    const { data } = await q;
    plyProducts = data ?? [];
  }
  const plyByThickness = new Map<number, Any>();
  plyProducts.forEach((p) => plyByThickness.set(num(p.thickness), p));

  let plywoodPrice = 0;
  const groups = [...byThickness.entries()].sort((a, b) => b[0] - a[0]).map(([t, g]) => {
    const coverSqft = g.coverMm2 / SQFT_PER_MM2;
    const prod = plyByThickness.get(t);
    const sheetArea = prod ? Number(prod.area_sqft) || 0 : 0;
    const pricePer = prod ? Number(prod.price_per_sqft) || 0 : 0;
    let qty: number | null = null, lineTotal: number | null = null;
    if (prod && sheetArea > 0) {
      qty = ceilDiv(coverSqft, sheetArea);
      lineTotal = round2(qty * pricePer);
      plywoodPrice += lineTotal;
      pushMat(prod.supplier ?? null, prod.category || `Plywood ${t}mm`, prod.product_name, qty, pricePer, lineTotal);
    }
    return { thickness: t, panel_count: g.count, cover_sqft: round2(coverSqft), product_name: prod ? String(prod.product_name ?? "") : null, qty, price: lineTotal, missing: !prod };
  });
  plywoodPrice = round2(plywoodPrice);

  // ---- Laminate: inner (common) + outer (per panel) -----------------------
  const innerLamId = body.inner_laminate_id ? String(body.inner_laminate_id) : null;
  const lamIds = [innerLamId, ...Object.values(outerLamIds)].filter(Boolean).map(String);
  const lamById = new Map<string, Any>();
  if (lamIds.length) {
    const { data } = await admin.from("turnkey_products").select("id, product_name, supplier, category, area_sqft, price_per_sqft").in("id", [...new Set(lamIds)]);
    (data ?? []).forEach((p: Any) => lamById.set(String(p.id), p));
  }

  let innerMm2 = 0;
  const outerByProduct = new Map<string, number>(); // productId -> mm2
  const outerPanels: Any[] = []; // panels needing an outer laminate (for the UI)
  const handlePanels: Any[] = []; // panels needing a handle (for the UI)
  panels.forEach((p, i) => {
    const L = lg(p.partCat);
    const area = (p.length + 2) * (p.width + 2) * p.qty;
    innerMm2 += area * (Number(L.inner_lam) || 0);
    if ((Number(L.outer_lam) || 0) > 0) {
      outerPanels.push({ index: i, name: p.name || p.partCat, category: L.part_category || p.partCat });
      const pid = outerLamIds[String(i)];
      if (pid) outerByProduct.set(pid, (outerByProduct.get(pid) || 0) + area * (Number(L.outer_lam) || 0));
    }
    if ((Number(L.handles) || 0) > 0) handlePanels.push({ index: i, name: p.name || p.partCat, category: L.part_category || p.partCat });
  });

  const lamLine = (prod: Any, coverMm2: number) => {
    const cover = coverMm2 / SQFT_PER_MM2;
    const sheetArea = prod ? Number(prod.area_sqft) || 0 : 0;
    const pricePer = prod ? Number(prod.price_per_sqft) || 0 : 0;
    const qty = prod && sheetArea > 0 ? ceilDiv(cover, sheetArea) : null;
    const price = qty != null ? round2(qty * pricePer) : 0;
    return { qty, price, pricePer, cover: round2(cover) };
  };

  const innerProd = innerLamId ? lamById.get(innerLamId) : undefined;
  const inner = lamLine(innerProd, innerMm2);
  let laminatePrice = inner.price || 0;
  const innerName = innerProd ? String(innerProd.product_name ?? "") : null;
  if (innerProd && inner.qty && inner.qty > 0) pushMat(innerProd.supplier ?? null, innerProd.category || "Inner laminate", innerName, inner.qty, inner.pricePer, inner.price);

  const outerLines: Any[] = [];
  for (const [pid, mm2] of outerByProduct) {
    const prod = lamById.get(pid);
    const line = lamLine(prod, mm2);
    laminatePrice += line.price || 0;
    const nm = prod ? String(prod.product_name ?? "") : null;
    if (prod && line.qty && line.qty > 0) pushMat(prod.supplier ?? null, prod.category || "Outer laminate", nm, line.qty, line.pricePer, line.price);
    outerLines.push({ product_id: pid, name: nm, qty: line.qty, price: line.price });
  }
  laminatePrice = round2(laminatePrice);

  // ---- Hardware: hinges, handles, channels, minifix, legs -----------------
  const pickedHwIds = [...Object.values(handleIds)].filter(Boolean).map(String);
  const hwById = new Map<string, Any>();
  if (pickedHwIds.length) {
    const { data } = await admin.from("turnkey_hardwares").select("id, product_name, supplier, category, price").in("id", [...new Set(pickedHwIds)]);
    (data ?? []).forEach((h: Any) => hwById.set(String(h.id), h));
  }
  const { data: allHw } = await admin.from("turnkey_hardwares").select("id, product_name, supplier, category, size, price");
  const firstHwInCat = (cat: string) => (allHw ?? []).find((h: Any) => normPart(h.category) === cat) ?? null;

  // Hinges — countByDim(max(L,B)) per shutter panel; the hinge product is the
  // single one in the Edge/Inner hinges category (auto, like minifix/legs).
  let edgeQty = 0, innerHingeQty = 0;
  panels.forEach((p) => {
    const type = normPart(lg(p.partCat).hinge_type);
    if (type !== "edge" && type !== "inner") return;
    const c = countByDim(Math.max(p.length, p.width)) * p.qty;
    if (type === "edge") edgeQty += c; else innerHingeQty += c;
  });
  const edgeHinge = firstHwInCat("edge hinges");
  const innerHinge = firstHwInCat("inner hinges");
  const edgePrice = round2(edgeQty * (edgeHinge ? Number(edgeHinge.price) || 0 : 0));
  const innerHingePrice = round2(innerHingeQty * (innerHinge ? Number(innerHinge.price) || 0 : 0));
  if (edgeHinge && edgeQty > 0) pushMat(edgeHinge.supplier ?? null, edgeHinge.category || "Edge hinges", edgeHinge.product_name, edgeQty, Number(edgeHinge.price) || 0, edgePrice);
  if (innerHinge && innerHingeQty > 0) pushMat(innerHinge.supplier ?? null, innerHinge.category || "Inner hinges", innerHinge.product_name, innerHingeQty, Number(innerHinge.price) || 0, innerHingePrice);

  // Handles — per panel, qty = handles*panelQty, per chosen handle.
  const handleByProduct = new Map<string, number>();
  panels.forEach((p, i) => {
    const h = Number(lg(p.partCat).handles) || 0;
    if (h <= 0) return;
    const hid = handleIds[String(i)];
    if (hid) handleByProduct.set(hid, (handleByProduct.get(hid) || 0) + h * p.qty);
  });
  let handlePrice = 0, handleQty = 0;
  const handleLines: Any[] = [];
  for (const [hid, qty] of handleByProduct) {
    const hw = hwById.get(hid);
    const price = round2(qty * (hw ? Number(hw.price) || 0 : 0));
    handlePrice += price; handleQty += qty;
    if (hw) pushMat(hw.supplier ?? null, hw.category || "Handle", hw.product_name, qty, Number(hw.price) || 0, price);
    handleLines.push({ handle_id: hid, name: hw ? String(hw.product_name ?? "") : null, qty, price });
  }
  handlePrice = round2(handlePrice);

  // Channels — pick size <= max(L,B); final qty = ceil(pieces/2) (sets).
  const channels = (allHw ?? [])
    .filter((h: Any) => normPart(h.category) === "channel")
    .map((h: Any) => ({ name: String(h.product_name ?? ""), supplier: h.supplier ?? null, sizeMm: num(h.size) * MM_PER_FT, price: Number(h.price) || 0 }))
    .filter((c: Any) => Number.isFinite(c.sizeMm));
  const pickChannel = (panelMax: number) => {
    if (!channels.length) return null;
    const sorted = channels.slice().sort((a: Any, b: Any) => a.sizeMm - b.sizeMm);
    let chosen: Any = null;
    for (const c of sorted) if (c.sizeMm <= panelMax) chosen = c;
    return chosen ?? sorted[0];
  };
  const channelCount = new Map<string, { name: string; supplier: Any; price: number; pieces: number }>();
  panels.forEach((p) => {
    if (String(lg(p.partCat).channel).toLowerCase() !== "yes") return;
    const c = pickChannel(Math.max(p.length, p.width));
    if (!c) return;
    const cur = channelCount.get(c.name) ?? { name: c.name, supplier: c.supplier, price: c.price, pieces: 0 };
    cur.pieces += p.qty;
    channelCount.set(c.name, cur);
  });
  let channelPrice = 0, channelQty = 0;
  const channelLines: Any[] = [];
  for (const [, c] of channelCount) {
    const sets = Math.ceil(c.pieces / 2);
    const price = round2(sets * c.price);
    channelPrice += price; channelQty += sets;
    pushMat(c.supplier ?? null, "Channel", c.name, sets, c.price, price);
    channelLines.push({ name: c.name, qty: sets, price });
  }
  channelPrice = round2(channelPrice);

  // Minifix — per panel countByDim(length)+countByDim(width), ×qty.
  let minifixCount = 0;
  panels.forEach((p) => {
    if (String(lg(p.partCat).minifix).toLowerCase() !== "yes") return;
    minifixCount += (countByDim(p.length) + countByDim(p.width)) * p.qty;
  });
  const minifixHw = firstHwInCat("minifix");
  const minifixPrice = round2(minifixCount * (minifixHw ? Number(minifixHw.price) || 0 : 0));
  if (minifixHw) pushMat(minifixHw.supplier ?? null, minifixHw.category || "Minifix", minifixHw.product_name, minifixCount, Number(minifixHw.price) || 0, minifixPrice);

  // Legs — per panel countByDim(max(L,B))*2, ×qty (Carcass base only).
  let legsCount = 0;
  panels.forEach((p) => {
    if (String(lg(p.partCat).legs).toLowerCase() !== "yes") return;
    legsCount += countByDim(Math.max(p.length, p.width)) * 2 * p.qty;
  });
  const legsHw = firstHwInCat("legs");
  const legsPrice = round2(legsCount * (legsHw ? Number(legsHw.price) || 0 : 0));
  if (legsHw) pushMat(legsHw.supplier ?? null, legsHw.category || "Legs", legsHw.product_name, legsCount, Number(legsHw.price) || 0, legsPrice);

  const hardwareTotal = round2(edgePrice + innerHingePrice + handlePrice + channelPrice + minifixPrice + legsPrice);

  // ---- Special additions: hardware product + quantity ---------------------
  const specialIn = Array.isArray(body.special_additions) ? (body.special_additions as Any[]) : [];
  const specialTable = specialIn.map((s: Any) => {
    const hw = s?.hardware_id ? ((allHw ?? []).find((h: Any) => String(h.id) === String(s.hardware_id)) || null) : null;
    const qty = num(s?.quantity);
    const unitPrice = hw ? Number(hw.price) || 0 : 0;
    return { hardware_id: s?.hardware_id ? String(s.hardware_id) : null, product_name: hw ? String(hw.product_name ?? "") : (s?.product_name ? String(s.product_name) : null), supplier: hw ? (hw.supplier ?? null) : null, category: hw ? String(hw.category ?? "") : null, quantity: qty, unit_price: unitPrice, cost: round2(qty * unitPrice) };
  }).filter((s) => s.hardware_id || s.quantity);
  const specialTotal = round2(specialTable.reduce((sum, s) => sum + (s.cost || 0), 0));
  specialTable.forEach((s) => pushMat(s.supplier, s.category || "Special addition", s.product_name, s.quantity, s.unit_price, s.cost));

  const materialsGrandTotal = round2(plywoodPrice + laminatePrice + hardwareTotal + specialTotal);

  // ---- Sqft per part category (drives the labour sqft picker) -------------
  const catSqftMap = new Map<string, number>();
  for (const p of panels) {
    const a = ((p.length + 2) * (p.width + 2) * p.qty) / SQFT_PER_MM2;
    const known = logic.get(normPart(p.partCat));
    const label = known ? String(known.part_category ?? p.partCat) : p.partCat;
    catSqftMap.set(label, (catSqftMap.get(label) || 0) + a);
  }
  const categorySqft = [...catSqftMap.entries()].map(([category, sqft]) => ({ category, sqft: round2(sqft) })).sort((a, b) => b.sqft - a.sqft);
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
    const sqft = cats.length ? round2(cats.reduce((s: number, c: string) => s + (catSqftLookup.get(c) || 0), 0)) : num(l?.total_sqft);
    const perDay = row ? Number(row.cost_per_day) || 0 : 0;
    const perSqft = row ? Number(row.cost_per_sqft) || 0 : 0;
    return {
      labour_id: l?.labour_id ? String(l.labour_id) : null,
      category: row ? String(row.category ?? "") : (l?.category ? String(l.category) : null),
      name: row ? String(row.name ?? "") : (l?.name ? String(l.name) : null),
      task: row ? String(row.task ?? "") : (l?.task ? String(l.task) : null),
      total_days: days, sqft_categories: cats, total_sqft: sqft, cost: round2(days * perDay + sqft * perSqft),
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
  const total = round2(materialsGrandTotal + labourTotal);
  const withMargin = round2(total * (1 + margin / 100));
  const marginAmount = round2(withMargin - total);
  const withDiscount = round2(withMargin * (1 - discount / 100));
  const withGst = round2(withDiscount * (1 + gst / 100));

  // ---- Spec strings --------------------------------------------------------
  const clean = (arr: (string | null | undefined)[]) => [...new Set(arr.map((s) => (s ?? "").trim()).filter(Boolean))];
  const materialSpec = clean(materials.map((mm) => mm.product)).join(", ");
  const designSpec = clean([innerName, ...outerLines.map((o) => o.name)]).join(", ");

  const boqLines = materials.map((mm) => ({ product_name: mm.product, category: mm.category, quantity: mm.quantity, supplier: mm.supplier, unit_price: mm.unit_price }));

  const computed = {
    groups,
    materials,
    laminate: { inner: { name: innerName, qty: inner.qty, price: inner.price }, outer: outerLines },
    outer_panels: outerPanels,
    handle_panels: handlePanels,
    hinges: {
      edge: { name: edgeHinge ? String(edgeHinge.product_name ?? "") : null, qty: edgeQty, price: edgePrice },
      inner: { name: innerHinge ? String(innerHinge.product_name ?? "") : null, qty: innerHingeQty, price: innerHingePrice },
    },
    handles: { qty: handleQty, price: handlePrice, lines: handleLines },
    channels: { qty: channelQty, price: channelPrice, lines: channelLines },
    minifix: { qty: minifixCount, price: minifixPrice, name: minifixHw ? String(minifixHw.product_name ?? "") : null },
    legs: { qty: legsCount, price: legsPrice, name: legsHw ? String(legsHw.product_name ?? "") : null },
    special: { total: specialTotal, table: specialTable },
    labour: { total: labourTotal, table: labourTable },
    category_sqft: categorySqft,
    totals: {
      material: materialsGrandTotal, hardware: hardwareTotal, special: specialTotal, labour: labourTotal,
      total, with_margin: withMargin, margin_amount: marginAmount, with_discount: withDiscount, with_gst: withGst,
    },
    boq_lines: boqLines,
    margin_percent: margin, discount_percent: discount, gst_percent: gst,
  };

  // ---- Save + rebuild BOQ --------------------------------------------------
  let unitId = body.unit_id ? String(body.unit_id) : null;
  if (body.save) {
    if (!body.project_id) return json({ error: "Missing project." }, 400);
    const row = {
      project_id: String(body.project_id),
      space: body.space ? String(body.space) : null,
      unit_name: body.unit_name ? String(body.unit_name) : null,
      csv_text: csvText,
      material_brand: materialBrand,
      material_sub_category: materialSub,
      laminate_brand: null,
      outer_laminate_id: null,
      inner_laminate_id: innerLamId,
      outer_laminate_ids: outerLamIds,
      edge_hinge_id: null,
      inner_hinge_id: null,
      channel_id: null,
      handle_id: null,
      handle_ids: handleIds,
      special_additions: specialTable,
      labour_lines: labourTable,
      special_price: specialTotal,
      labour_price: labourTotal,
      total_material_price: materialsGrandTotal,
      hardware_price: hardwareTotal,
      total_price: total,
      margin_price: withMargin,
      margin_amount: marginAmount,
      discount_price: withDiscount,
      gst_price: withGst,
      material_spec: materialSpec,
      design_spec: designSpec,
      computed,
    };
    if (unitId) {
      const { error } = await admin.from("turnkey_quote_box_units").update(row).eq("id", unitId);
      if (error) return json({ error: `Save failed: ${error.message}` }, 500);
    } else {
      const { data, error } = await admin.from("turnkey_quote_box_units").insert(row).select("id").single();
      if (error) return json({ error: `Save failed: ${error.message}` }, 500);
      unitId = data.id;
    }
    await rebuildBoq(admin, String(body.project_id));
  }

  return json({ ok: true, computed, material_spec: materialSpec, design_spec: designSpec, unit_id: unitId, saved: Boolean(body.save) });
});

// ---------------------------------------------------------------------------
interface Panel { partCat: string; name: string; length: number; width: number; thickness: number; qty: number; }

function parseCutlist(text: string): Panel[] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("empty file");
  const semis = (lines[0].match(/;/g) || []).length;
  const commas = (lines[0].match(/,/g) || []).length;
  const delim = semis >= commas ? ";" : ",";
  const header = lines[0].split(delim).map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const iDes = col("designation"), iLen = col("length"), iWid = col("width"), iThk = col("thickness"), iQty = col("quantity");
  if (iLen < 0 || iWid < 0) throw new Error(`need columns Length, Width — found: ${header.join(", ") || "none"}`);
  const panels: Panel[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const des = iDes >= 0 ? String(cells[iDes] ?? "").trim() : "";
    const hy = des.indexOf("-");
    const partCat = normPart(hy >= 0 ? des.slice(0, hy) : des);
    const name = hy >= 0 ? des.slice(hy + 1).trim() : "";
    const L = num(cells[iLen]), W = num(cells[iWid]), T = iThk >= 0 ? num(cells[iThk]) : 0;
    const q = iQty >= 0 ? Math.max(1, Math.round(num(cells[iQty])) || 1) : 1;
    if (!(L > 0) || !(W > 0)) continue;
    panels.push({ partCat, name, length: L, width: W, thickness: T, qty: q });
  }
  if (!panels.length) throw new Error("no valid panel rows");
  return panels;
}
