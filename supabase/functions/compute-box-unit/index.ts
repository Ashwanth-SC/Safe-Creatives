// ============================================================================
// compute-box-unit — price a Box & Shutters cutlist unit (backend maths)
// ============================================================================
//
// Inputs: csv_text (mm cutlist), material_brand + material_sub_category
// (plywood), laminate_brand + outer_laminate_id + inner_laminate_id,
// edge_hinge_id + inner_hinge_id + handle_id (hardware), project_id.
//
// Units: the products / hardware database is in FEET (sheet area = W*H sqft);
// the cutlist is in mm and converted internally. Prices are PER PIECE.
//
// Logic (driven by the editable turnkey_box_part_logic table):
//   * Designation "PartCategory-Name" -> part category.
//   * per panel: area = (L+2)(W+2)*qty mm^2 -> sqft.
//   * plywood: group by thickness; board = product with the selected brand +
//     sub-category at that thickness; sheets = ceil(coverArea / sheetArea),
//     price = sheets * price(piece). coverArea uses the part's ply_qty.
//   * outer/inner laminate: coverArea = sum(area * outer_lam | inner_lam);
//     sheets = ceil(cover / lamSheetArea); price = sheets * price(piece).
//   * hinges: per panel with hinge_type Edge/Inner -> count = 2 up to 600mm
//     then +1 per 300mm (size = max(L,W)); price = qty * hinge price.
//   * handles: per panel handles count -> total; price = qty * handle price.
//   * channels: each part with channel=Yes -> the Channel hardware whose size
//     (ft->mm) is the largest <= max(L,W) (smallest if under all); one each.
//   * special additions: per-unit [{name, cost}] — names appended to the design
//     spec, costs summed into the base total.
//   * labour: per-unit [{labour_id, total_days, sqft_categories[], total_sqft}]
//     — sqft is the sum of the picked category_sqft rows (or manual total_sqft);
//     cost per line = days*cost_per_day + sqft*cost_per_sqft (rates from the
//     labour row); summed into the base total. category_sqft (sqft per part
//     category from the cutlist) is returned to drive the picker.
//   * total = plywood + laminate + hardware + special + labour; withMargin,
//     margin amount, withDiscount, withGst from the project percentages.
//
// On save: stores the unit + rebuilds turnkey_project_boq from ALL the
// project's units. { recompute_boq:true, project_id } just rebuilds the BOQ.
//
// Needs migrations 027-030. Deploy: supabase functions deploy compute-box-unit
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
const hingeCount = (size: number) => (size <= 600 ? 2 : 2 + Math.ceil((size - 600) / 300));

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

  // ---- Logic table -> per-part multipliers --------------------------------
  const { data: logicRows } = await admin.from("turnkey_box_part_logic").select("*");
  const logic = new Map<string, Any>();
  (logicRows ?? []).forEach((r: Any) => logic.set(normPart(r.part_category), r));
  const lg = (partCat: string) => logic.get(partCat) ?? { ply_qty: 1, outer_lam: 0, inner_lam: 0, hinge_type: "None", handles: 0, channel: "No" };

  const materialBrand = body.material_brand ? String(body.material_brand) : null;
  const materialSub = body.material_sub_category ? String(body.material_sub_category) : null;
  const laminateBrand = body.laminate_brand ? String(body.laminate_brand) : null;

  // ---- Plywood: group by thickness ----------------------------------------
  const byThickness = new Map<string, { count: number; coverMm2: number }>();
  for (const p of panels) {
    const mult = Number(lg(p.partCat).ply_qty) || 0;
    if (mult <= 0) continue;
    const key = String(p.thickness);
    const g = byThickness.get(key) ?? { count: 0, coverMm2: 0 };
    g.count += p.qty;
    g.coverMm2 += (p.length + 2) * (p.width + 2) * p.qty * mult;
    byThickness.set(key, g);
  }

  let plyProducts: Any[] = [];
  if (materialBrand) {
    let q = admin.from("turnkey_products").select("id, product_name, thickness, area_sqft, price_per_sqft").eq("brand", materialBrand);
    if (materialSub) q = q.eq("sub_category", materialSub);
    const { data } = await q;
    plyProducts = data ?? [];
  }
  const plyByThickness = new Map<number, Any>();
  plyProducts.forEach((p) => plyByThickness.set(num(p.thickness), p));

  let plywoodPrice = 0;
  const boqLines: { product_name: string; category: string; quantity: number }[] = [];
  const groups = [...byThickness.entries()]
    .sort((a, b) => num(b[0]) - num(a[0]))
    .map(([t, g]) => {
      const coverSqft = g.coverMm2 / SQFT_PER_MM2;
      const prod = plyByThickness.get(num(t));
      const sheetArea = prod ? Number(prod.area_sqft) || 0 : 0;
      const price = prod ? Number(prod.price_per_sqft) || 0 : 0;
      let qty: number | null = null, lineTotal: number | null = null;
      if (prod && sheetArea > 0) {
        qty = ceilDiv(coverSqft, sheetArea);
        lineTotal = round2(qty * price);
        plywoodPrice += lineTotal;
        boqLines.push({ product_name: String(prod.product_name ?? ""), category: "Plywood", quantity: qty });
      }
      return {
        thickness: num(t),
        panel_count: g.count,
        cover_sqft: round2(coverSqft),
        product_name: prod ? String(prod.product_name ?? "") : null,
        qty,
        price: lineTotal,
        missing: !prod,
      };
    });

  // ---- Laminate: outer + inner by logic multipliers -----------------------
  let outerMm2 = 0, innerMm2 = 0;
  for (const p of panels) {
    const a = (p.length + 2) * (p.width + 2) * p.qty;
    outerMm2 += a * (Number(lg(p.partCat).outer_lam) || 0);
    innerMm2 += a * (Number(lg(p.partCat).inner_lam) || 0);
  }
  const lamIds = [body.outer_laminate_id, body.inner_laminate_id].filter(Boolean).map(String);
  const lamById = new Map<string, Any>();
  if (lamIds.length) {
    const { data } = await admin.from("turnkey_products").select("id, product_name, thickness, area_sqft, price_per_sqft").in("id", lamIds);
    (data ?? []).forEach((p) => lamById.set(String(p.id), p));
  }
  const lamCalc = (id: unknown, coverMm2: number, cat: string) => {
    const prod = id ? lamById.get(String(id)) : undefined;
    const cover = coverMm2 / SQFT_PER_MM2;
    const sheetArea = prod ? Number(prod.area_sqft) || 0 : 0;
    const price = prod ? Number(prod.price_per_sqft) || 0 : 0;
    const qty = prod && sheetArea > 0 ? ceilDiv(cover, sheetArea) : null;
    const total = qty != null ? round2(qty * price) : null;
    if (qty != null && qty > 0) boqLines.push({ product_name: String(prod.product_name ?? ""), category: cat, quantity: qty });
    return { name: prod ? String(prod.product_name ?? "") : null, thickness: prod ? num(prod.thickness) : null, cover_sqft: round2(cover), qty, price: total };
  };
  const outer = lamCalc(body.outer_laminate_id, outerMm2, "Outer laminate");
  const inner = lamCalc(body.inner_laminate_id, innerMm2, "Inner laminate");
  const laminatePrice = (outer.price ?? 0) + (inner.price ?? 0);
  const materialTotal = round2(plywoodPrice + laminatePrice);

  // ---- Hardware: hinges, handles, channels --------------------------------
  const handleIds: Record<string, string> = (body.handle_ids && typeof body.handle_ids === "object") ? (body.handle_ids as Any) : {};
  const hwIds = [body.edge_hinge_id, body.inner_hinge_id, ...Object.values(handleIds)].filter(Boolean).map(String);
  const hwById = new Map<string, Any>();
  if (hwIds.length) {
    const { data } = await admin.from("turnkey_hardwares").select("id, product_name, price").in("id", [...new Set(hwIds)]);
    (data ?? []).forEach((h) => hwById.set(String(h.id), h));
  }
  const edgeHinge = body.edge_hinge_id ? hwById.get(String(body.edge_hinge_id)) : undefined;
  const innerHinge = body.inner_hinge_id ? hwById.get(String(body.inner_hinge_id)) : undefined;

  const { data: chData } = await admin.from("turnkey_hardwares").select("product_name, category, size, price");
  const channels = (chData ?? [])
    .filter((h: Any) => normPart(h.category) === "channel")
    .map((h: Any) => ({ name: String(h.product_name ?? ""), sizeMm: num(h.size) * MM_PER_FT, price: Number(h.price) || 0 }))
    .filter((c: Any) => Number.isFinite(c.sizeMm));
  const pickChannel = (panelMax: number) => {
    if (!channels.length) return null;
    const sorted = channels.slice().sort((a, b) => a.sizeMm - b.sizeMm);
    let chosen: Any = null;
    for (const c of sorted) if (c.sizeMm <= panelMax) chosen = c;
    return chosen ?? sorted[0];
  };

  let edgeQty = 0, innerQty = 0, channelQty = 0, channelPrice = 0;
  const channelUse = new Map<string, number>();
  const handleByCat = new Map<string, number>();
  for (const p of panels) {
    const L = lg(p.partCat);
    const size = Math.max(p.length, p.width);
    if (normPart(L.hinge_type) === "edge") edgeQty += hingeCount(size);
    else if (normPart(L.hinge_type) === "inner") innerQty += hingeCount(size);
    const h = Number(L.handles) || 0;
    if (h > 0) { const cat = String(L.part_category ?? p.partCat); handleByCat.set(cat, (handleByCat.get(cat) || 0) + h * p.qty); }
    if (String(L.channel).toLowerCase() === "yes") {
      const c = pickChannel(size);
      if (c) { channelQty += p.qty; channelPrice += c.price * p.qty; channelUse.set(c.name, (channelUse.get(c.name) || 0) + p.qty); }
    }
  }
  const edgePrice = round2(edgeQty * (edgeHinge ? Number(edgeHinge.price) || 0 : 0));
  const innerHingePrice = round2(innerQty * (innerHinge ? Number(innerHinge.price) || 0 : 0));
  channelPrice = round2(channelPrice);

  // Handles: one selectable handle per part category.
  let handlePrice = 0, handleQty = 0;
  const handleTable = [...handleByCat.entries()].map(([cat, qty]) => {
    const id = handleIds[cat];
    const prod = id ? hwById.get(String(id)) : undefined;
    const price = round2(qty * (prod ? Number(prod.price) || 0 : 0));
    handlePrice += price;
    handleQty += qty;
    if (prod && qty > 0) boqLines.push({ product_name: String(prod.product_name ?? ""), category: "Handle", quantity: qty });
    return { category: cat, qty, handle_id: id ?? null, handle_name: prod ? String(prod.product_name ?? "") : null, price };
  });
  handlePrice = round2(handlePrice);

  if (edgeHinge && edgeQty > 0) boqLines.push({ product_name: String(edgeHinge.product_name ?? ""), category: "Edge hinges", quantity: edgeQty });
  if (innerHinge && innerQty > 0) boqLines.push({ product_name: String(innerHinge.product_name ?? ""), category: "Inner hinges", quantity: innerQty });
  for (const [name, q] of channelUse) boqLines.push({ product_name: name, category: "Channel", quantity: q });

  const hardwareTotal = round2(edgePrice + innerHingePrice + handlePrice + channelPrice);

  // ---- Special additions (name + cost, entered per unit) ------------------
  const specialIn = Array.isArray(body.special_additions) ? (body.special_additions as Any[]) : [];
  const specialTable = specialIn
    .map((s: Any) => ({ name: String(s?.name ?? "").trim(), cost: round2(num(s?.cost)) }))
    .filter((s) => s.name || s.cost > 0);
  const specialTotal = round2(specialTable.reduce((sum, s) => sum + (s.cost || 0), 0));

  // ---- Sqft of every box & shutters part category (from the cutlist) -------
  // Reference for the labour sqft; keyed by the logic table's display name
  // where the part is known, else the raw designation.
  const catSqftMap = new Map<string, number>();
  for (const p of panels) {
    const a = ((p.length + 2) * (p.width + 2) * p.qty) / SQFT_PER_MM2;
    const known = logic.get(normPart(p.partCat));
    const label = known ? String(known.part_category ?? p.partCat) : p.partCat;
    catSqftMap.set(label, (catSqftMap.get(label) || 0) + a);
  }
  const categorySqft = [...catSqftMap.entries()]
    .map(([category, sqft]) => ({ category, sqft: round2(sqft) }))
    .sort((a, b) => b.sqft - a.sqft);
  const catSqftLookup = new Map(categorySqft.map((r) => [r.category, r.sqft]));

  // ---- Labour (category -> name -> task, days + sqft) ----------------------
  // Each line references a turnkey_labour row. Sqft is auto-summed from the
  // selected box & shutters categories (sqft_categories) when any are picked,
  // else the manual total_sqft; cost = days*cost_per_day + sqft*cost_per_sqft.
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
  // Special additions + labour land in the base Total, so margin, discount and
  // GST cascade over them just like materials and hardware.
  const total = round2(materialTotal + hardwareTotal + specialTotal + labourTotal);
  const withMargin = round2(total * (1 + margin / 100));
  const marginAmount = round2(withMargin - total);
  const withDiscount = round2(withMargin * (1 - discount / 100));
  const withGst = round2(withDiscount * (1 + gst / 100));

  // ---- Spec strings --------------------------------------------------------
  const clean = (arr: (string | null | undefined)[]) => arr.map((s) => (s ?? "").trim()).filter(Boolean);
  const hingeNames = clean([edgeQty > 0 ? edgeHinge?.product_name : null, innerQty > 0 ? innerHinge?.product_name : null]);
  const handleNames = [...new Set(handleTable.filter((r) => r.handle_name).map((r) => r.handle_name as string))];
  const materialSpec = clean([materialBrand, ...hingeNames, ...handleNames, ...channelUse.keys(), laminateBrand, outer.name, inner.name]).join(", ");
  // Special addition names are appended to the design spec, after a comma.
  const specialNames = specialTable.map((s) => s.name);
  const designSpec = clean([laminateBrand, outer.name, inner.name, ...specialNames]).join(", ");

  const computed = {
    groups,
    laminate: { outer, inner },
    hinges: {
      edge: { name: edgeHinge ? String(edgeHinge.product_name ?? "") : null, qty: edgeQty, price: edgePrice },
      inner: { name: innerHinge ? String(innerHinge.product_name ?? "") : null, qty: innerQty, price: innerHingePrice },
    },
    channels: { qty: channelQty, price: channelPrice, names: [...channelUse.keys()] },
    handles: { qty: handleQty, price: handlePrice, table: handleTable },
    special: { total: specialTotal, table: specialTable },
    labour: { total: labourTotal, table: labourTable },
    category_sqft: categorySqft,
    totals: {
      material: materialTotal,
      hardware: hardwareTotal,
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
      laminate_brand: laminateBrand,
      outer_laminate_id: body.outer_laminate_id ? String(body.outer_laminate_id) : null,
      inner_laminate_id: body.inner_laminate_id ? String(body.inner_laminate_id) : null,
      edge_hinge_id: body.edge_hinge_id ? String(body.edge_hinge_id) : null,
      inner_hinge_id: body.inner_hinge_id ? String(body.inner_hinge_id) : null,
      channel_id: null,
      handle_id: null,
      handle_ids: handleIds,
      special_additions: specialTable,
      labour_lines: labourTable,
      special_price: specialTotal,
      labour_price: labourTotal,
      total_material_price: materialTotal,
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

// Rebuilds the project BOQ from every unit's stored boq_lines.
async function rebuildBoq(admin: Any, projectId: string) {
  const { data: units } = await admin.from("turnkey_quote_box_units").select("computed").eq("project_id", projectId);
  const agg = new Map<string, { product_name: string; category: string; quantity: number }>();
  (units ?? []).forEach((u: Any) => {
    const lines = (u.computed && u.computed.boq_lines) || [];
    lines.forEach((l: Any) => {
      const key = `${l.category}||${l.product_name}`;
      const cur = agg.get(key) ?? { product_name: l.product_name, category: l.category, quantity: 0 };
      cur.quantity += Number(l.quantity) || 0;
      agg.set(key, cur);
    });
  });
  await admin.from("turnkey_project_boq").delete().eq("project_id", projectId);
  const rows = [...agg.values()].map((r) => ({ project_id: projectId, ...r }));
  if (rows.length) await admin.from("turnkey_project_boq").insert(rows);
}

// ---------------------------------------------------------------------------
interface Panel { partCat: string; length: number; width: number; thickness: number; qty: number; }

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
  if (iLen < 0 || iWid < 0 || iThk < 0) throw new Error(`need columns Length, Width, Thickness — found: ${header.join(", ") || "none"}`);
  const panels: Panel[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(delim);
    const des = iDes >= 0 ? String(cells[iDes] ?? "") : "";
    const hy = des.indexOf("-");
    const partCat = normPart(hy >= 0 ? des.slice(0, hy) : des);
    const L = num(cells[iLen]), W = num(cells[iWid]), T = num(cells[iThk]);
    const q = iQty >= 0 ? Math.max(1, Math.round(num(cells[iQty])) || 1) : 1;
    if (!(L > 0) || !(W > 0) || !Number.isFinite(T)) continue;
    panels.push({ partCat, length: L, width: W, thickness: T, qty: q });
  }
  if (!panels.length) throw new Error("no valid panel rows");
  return panels;
}
