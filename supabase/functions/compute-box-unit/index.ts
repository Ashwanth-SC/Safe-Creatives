// ============================================================================
// compute-box-unit — price a Box & Shutters cutlist unit (backend maths)
// ============================================================================
//
// The builder posts a unit's inputs; this function does ALL the parsing +
// arithmetic and returns the computed breakdown. With { save:true } it also
// stores the inputs + computed values so a unit can be reopened & compared.
//
// Inputs: csv_text, material_brand, material_sub_category, laminate_brand,
// outer_laminate_id, inner_laminate_id, project_id (for margin/GST/discount).
//
// Logic:
//   * CSV Designation = "PartCategory-Name" -> part category (before 1st '-').
//   * +2mm clearance on each L & W; panel area = (L+2)(W+2)*qty, mm^2 -> sqft.
//   * Plywood: group by thickness; board = product with the selected brand +
//     sub-category and that thickness; sheets = ceil(area / sheetArea);
//     price = sheets * (sheetArea * price/sqft).
//   * Laminate faces by part category:
//       one outer + one inner: carcass outer, skirting, partition, shelf,
//         drawer side, drawer shutter, special shutter, edge shutter, inner shutter
//       inner on both sides: back ply, drawer outer
//     outerArea = sum(one-plus-one areas); innerArea = one-plus-one + 2x inner-both.
//     qty = ceil(area / sheetArea); price = qty * (sheetArea * price/sqft).
//   * Hinges: edge shutter -> Edge-hinges product; inner shutter -> Inner-hinges.
//       count(size)= size<=600?2 : 2+ceil((size-600)/300); size = max(L,W).
//   * Channels: each drawer-side panel -> 1 channel, largest Channel size <=
//       max(L,W) (smallest if under all).
//   * total = plywood + laminate + hardware; withMargin = total*(1+m/100);
//     withDiscount = withMargin*(1-d/100); withGst = withDiscount*(1+g/100).
//
// Needs migrations 027-029. Deploy: supabase functions deploy compute-box-unit
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQFT_PER_MM2 = 92903.04;

const ONE_PLUS_ONE = new Set([
  "carcass outer", "skirting", "partition", "shelf", "drawer side",
  "drawer shutter", "special shutter", "edge shutter", "inner shutter",
]);
const INNER_BOTH = new Set(["back ply", "drawer outer"]);

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

  const csvText = String(body.csv_text ?? "");
  if (!csvText.trim()) return json({ error: "No cutlist CSV provided." }, 400);

  let panels: Panel[];
  try {
    panels = parseCutlist(csvText);
  } catch (e) {
    return json({ error: `Could not read the CSV: ${(e as Error).message}` }, 400);
  }

  const materialBrand = body.material_brand ? String(body.material_brand) : null;
  const materialSub = body.material_sub_category ? String(body.material_sub_category) : null;
  const laminateBrand = body.laminate_brand ? String(body.laminate_brand) : null;
  const outerLamId = body.outer_laminate_id ? String(body.outer_laminate_id) : null;
  const innerLamId = body.inner_laminate_id ? String(body.inner_laminate_id) : null;

  // ---- Plywood: group by thickness, look up the board per thickness --------
  const byThickness = new Map<string, { count: number; areaMm2: number }>();
  for (const p of panels) {
    const key = String(p.thickness);
    const g = byThickness.get(key) ?? { count: 0, areaMm2: 0 };
    g.count += p.qty;
    g.areaMm2 += (p.length + 2) * (p.width + 2) * p.qty;
    byThickness.set(key, g);
  }

  let plyProducts: Record<string, unknown>[] = [];
  if (materialBrand) {
    let q = admin
      .from("turnkey_products")
      .select("id, product_name, thickness, area_sqft, price_per_sqft")
      .eq("brand", materialBrand);
    if (materialSub) q = q.eq("sub_category", materialSub);
    const { data } = await q;
    plyProducts = data ?? [];
  }
  const plyByThickness = new Map<number, Record<string, unknown>>();
  plyProducts.forEach((p) => plyByThickness.set(num(p.thickness), p));

  let plywoodPrice = 0;
  const groups = [...byThickness.entries()]
    .sort((a, b) => num(b[0]) - num(a[0]))
    .map(([t, g]) => {
      const areaSqft = g.areaMm2 / SQFT_PER_MM2;
      const prod = plyByThickness.get(num(t));
      let qty: number | null = null, price: number | null = null;
      const sheetArea = prod ? Number(prod.area_sqft) || 0 : 0;
      const rate = prod ? Number(prod.price_per_sqft) || 0 : 0;
      if (prod && sheetArea > 0) {
        qty = ceilDiv(areaSqft, sheetArea);
        price = round2(qty * (sheetArea * rate));
        plywoodPrice += price;
      }
      return {
        thickness: num(t),
        panel_count: g.count,
        area_sqft: round2(areaSqft),
        product_id: prod ? String(prod.id) : null,
        product_name: prod ? String(prod.product_name ?? "") : null,
        ply_qty: qty,
        ply_price: price,
        missing: !prod,
      };
    });

  // ---- Laminate: outer + inner areas by part category ----------------------
  let outerMm2 = 0, innerMm2 = 0;
  for (const p of panels) {
    const a = (p.length + 2) * (p.width + 2) * p.qty;
    if (ONE_PLUS_ONE.has(p.partCat)) { outerMm2 += a; innerMm2 += a; }
    else if (INNER_BOTH.has(p.partCat)) { innerMm2 += a * 2; }
  }
  const outerArea = outerMm2 / SQFT_PER_MM2;
  const innerArea = innerMm2 / SQFT_PER_MM2;

  const lamIds = [outerLamId, innerLamId].filter(Boolean) as string[];
  const lamById = new Map<string, Record<string, unknown>>();
  if (lamIds.length) {
    const { data } = await admin
      .from("turnkey_products")
      .select("id, product_name, area_sqft, price_per_sqft")
      .in("id", lamIds);
    (data ?? []).forEach((p) => lamById.set(String(p.id), p));
  }
  const lamCalc = (id: string | null, area: number) => {
    const prod = id ? lamById.get(id) : undefined;
    const sheetArea = prod ? Number(prod.area_sqft) || 0 : 0;
    const rate = prod ? Number(prod.price_per_sqft) || 0 : 0;
    const qty = prod && sheetArea > 0 ? ceilDiv(area, sheetArea) : null;
    const price = qty != null ? round2(qty * (sheetArea * rate)) : null;
    return { name: prod ? String(prod.product_name ?? "") : null, area_sqft: round2(area), qty, price };
  };
  const outer = lamCalc(outerLamId, outerArea);
  const inner = lamCalc(innerLamId, innerArea);
  const laminatePrice = (outer.price ?? 0) + (inner.price ?? 0);

  // ---- Hardware: hinges + channels -----------------------------------------
  const { data: hw } = await admin.from("turnkey_hardwares").select("product_name, category, size, price");
  const hardware = hw ?? [];
  const inCat = (c: unknown, name: string) => normPart(c) === normPart(name);
  const edgeHinge = hardware.find((h) => inCat(h.category, "edge hinges"));
  const innerHinge = hardware.find((h) => inCat(h.category, "inner hinges"));
  const channels = hardware
    .filter((h) => inCat(h.category, "channel"))
    .map((h) => ({ name: String(h.product_name ?? ""), size: num(h.size), price: Number(h.price) || 0 }))
    .filter((c) => Number.isFinite(c.size));

  const pickChannel = (panelMax: number) => {
    if (!channels.length) return null;
    const sorted = channels.slice().sort((a, b) => a.size - b.size);
    let chosen = null as (typeof sorted)[number] | null;
    for (const c of sorted) if (c.size <= panelMax) chosen = c;
    return chosen ?? sorted[0];
  };

  let edgeHingeQty = 0, innerHingeQty = 0, channelQty = 0, channelPrice = 0;
  const channelNames = new Set<string>();
  for (const p of panels) {
    const size = Math.max(p.length, p.width);
    if (p.partCat === "edge shutter") edgeHingeQty += hingeCount(size);
    else if (p.partCat === "inner shutter") innerHingeQty += hingeCount(size);
    else if (p.partCat === "drawer side") {
      const c = pickChannel(size);
      if (c) { channelQty += 1; channelPrice += c.price; channelNames.add(c.name); }
    }
  }
  const edgeUnit = edgeHinge ? Number(edgeHinge.price) || 0 : 0;
  const innerUnit = innerHinge ? Number(innerHinge.price) || 0 : 0;
  const edgeHingePrice = round2(edgeHingeQty * edgeUnit);
  const innerHingePrice = round2(innerHingeQty * innerUnit);
  channelPrice = round2(channelPrice);
  const hardwarePrice = round2(edgeHingePrice + innerHingePrice + channelPrice);

  // ---- Totals through margin / discount / GST ------------------------------
  let margin = 0, gst = 0, discount = 0;
  if (body.project_id) {
    const { data: proj } = await admin
      .from("turnkey_projects")
      .select("margin_percent, gst_percent, discount_percent")
      .eq("id", String(body.project_id))
      .maybeSingle();
    margin = Number(proj?.margin_percent) || 0;
    gst = Number(proj?.gst_percent) || 0;
    discount = Number(proj?.discount_percent) || 0;
  }
  const total = round2(plywoodPrice + laminatePrice + hardwarePrice);
  const marginPrice = round2(total * (1 + margin / 100));
  const discountPrice = round2(marginPrice * (1 - discount / 100));
  const gstPrice = round2(discountPrice * (1 + gst / 100));

  // ---- Spec strings --------------------------------------------------------
  const hingeNames: string[] = [];
  if (edgeHingeQty > 0 && edgeHinge) hingeNames.push(String(edgeHinge.product_name ?? ""));
  if (innerHingeQty > 0 && innerHinge) hingeNames.push(String(innerHinge.product_name ?? ""));
  const clean = (arr: (string | null)[]) => arr.map((s) => (s ?? "").trim()).filter(Boolean);
  const materialSpec = clean([
    materialBrand, ...hingeNames, ...channelNames, laminateBrand, outer.name, inner.name,
  ]).join(", ");
  const designSpec = clean([laminateBrand, outer.name, inner.name]).join(", ");

  const computed = {
    groups,
    laminate: { outer, inner, price: round2(laminatePrice) },
    hardware: {
      edge_hinge: { name: edgeHinge ? String(edgeHinge.product_name ?? "") : null, qty: edgeHingeQty, unit: edgeUnit, price: edgeHingePrice },
      inner_hinge: { name: innerHinge ? String(innerHinge.product_name ?? "") : null, qty: innerHingeQty, unit: innerUnit, price: innerHingePrice },
      channels: { qty: channelQty, price: channelPrice, names: [...channelNames] },
      price: hardwarePrice,
    },
    totals: {
      plywood: round2(plywoodPrice),
      laminate: round2(laminatePrice),
      hardware: hardwarePrice,
      total,
      margin_price: marginPrice,
      discount_price: discountPrice,
      gst_price: gstPrice,
    },
    margin_percent: margin,
    discount_percent: discount,
    gst_percent: gst,
  };

  // ---- Save ----------------------------------------------------------------
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
      outer_laminate_id: outerLamId,
      inner_laminate_id: innerLamId,
      total_material_price: round2(plywoodPrice + laminatePrice),
      hardware_price: hardwarePrice,
      total_price: total,
      margin_price: marginPrice,
      discount_price: discountPrice,
      gst_price: gstPrice,
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
  }

  return json({ ok: true, computed, material_spec: materialSpec, design_spec: designSpec, unit_id: unitId, saved: Boolean(body.save) });
});

// ---------------------------------------------------------------------------
interface Panel { partCat: string; length: number; width: number; thickness: number; qty: number; }

function parseCutlist(text: string): Panel[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("empty file");
  const header = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const iDes = col("designation"), iLen = col("length"), iWid = col("width"), iThk = col("thickness"), iQty = col("quantity");
  if (iDes < 0 || iLen < 0 || iWid < 0 || iThk < 0) throw new Error("expected Designation, Length, Width, Thickness");
  const panels: Panel[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(";");
    const des = String(cells[iDes] ?? "");
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
