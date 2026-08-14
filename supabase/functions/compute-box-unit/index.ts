// ============================================================================
// compute-box-unit — price a Box & Shutters cutlist unit (backend maths)
// ============================================================================
//
// The Box & Shutters builder posts a unit's inputs here; the function does ALL
// the parsing + arithmetic and returns the computed groups. With { save: true }
// it also stores the inputs + computed values (turnkey_quote_box_units + groups)
// so the unit can be reopened and compared later.
//
// Logic (as specified):
//   * parse CSV (Designation; Quantity; Length; Width; Thickness), semicolons,
//   * group panels by thickness, add +2mm to each length & width (bit clearance),
//   * group area = sum over panels of (L+2)(W+2)*qty, mm^2 -> sqft,
//   * for a chosen board/laminate product (area = std_width*std_height sqft):
//       plywoodQty  = ceil(groupArea / productArea)
//       laminateQty = ceil(groupArea / laminateArea) * 2   (both faces)
//       plywoodPrice  = plywoodQty  * (productArea  * price_per_sqft)
//       laminatePrice = laminateQty * (laminateArea * price_per_sqft)
//   * total = sum over groups of (plywoodPrice + laminatePrice).
//
// Needs migration 027. Deploy:
//   supabase functions deploy compute-box-unit
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SQFT_PER_MM2 = 92903.04; // mm^2 in one square foot

function corsHeadersFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get("SITE_ORIGIN") ?? "*")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  const allow = configured.includes("*")
    ? "*"
    : configured.includes(origin)
    ? origin
    : configured[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // Caller must be a signed-in admin.
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

  // Per-thickness material/laminate selections: { "16": { material_id, laminate_id } }
  const selections = (body.groups ?? {}) as Record<string, { material_id?: string; laminate_id?: string }>;

  // -- 1. Parse + group the cutlist -----------------------------------------
  let parsed: Record<string, { count: number; areaMm2: number }>;
  try {
    parsed = groupCutlist(csvText);
  } catch (e) {
    return json({ error: `Could not read the CSV: ${(e as Error).message}` }, 400);
  }
  const thicknesses = Object.keys(parsed).sort((a, b) => Number(b) - Number(a));

  // -- 2. Load any selected products in one query ---------------------------
  const ids = new Set<string>();
  for (const t of thicknesses) {
    const sel = selections[t];
    if (sel?.material_id) ids.add(sel.material_id);
    if (sel?.laminate_id) ids.add(sel.laminate_id);
  }
  const productById = new Map<string, { area: number; rate: number; name: string }>();
  if (ids.size) {
    const { data: prods, error } = await admin
      .from("turnkey_products")
      .select("id, product_name, area_sqft, price_per_sqft")
      .in("id", [...ids]);
    if (error) return json({ error: `Product lookup failed: ${error.message}` }, 500);
    (prods ?? []).forEach((p: Record<string, unknown>) =>
      productById.set(String(p.id), {
        area: Number(p.area_sqft) || 0,
        rate: Number(p.price_per_sqft) || 0,
        name: String(p.product_name ?? ""),
      })
    );
  }

  // -- 3. Compute each group -------------------------------------------------
  const ceilDiv = (a: number, b: number) => (b > 0 && a > 0 ? Math.ceil(a / b) : 0);
  let total = 0;
  const groups = thicknesses.map((t) => {
    const g = parsed[t];
    const groupArea = g.areaMm2 / SQFT_PER_MM2;
    const sel = selections[t] ?? {};
    const mat = sel.material_id ? productById.get(sel.material_id) : undefined;
    const lam = sel.laminate_id ? productById.get(sel.laminate_id) : undefined;

    let plywoodQty: number | null = null, laminateQty: number | null = null;
    let plywoodPrice: number | null = null, laminatePrice: number | null = null;

    if (mat && mat.area > 0) {
      plywoodQty = ceilDiv(groupArea, mat.area);
      plywoodPrice = round2(plywoodQty * (mat.area * mat.rate));
    }
    if (lam && lam.area > 0) {
      laminateQty = ceilDiv(groupArea, lam.area) * 2;
      laminatePrice = round2(laminateQty * (lam.area * lam.rate));
    }
    total += (plywoodPrice ?? 0) + (laminatePrice ?? 0);

    return {
      thickness: Number(t),
      panel_count: g.count,
      group_area_sqft: round2(groupArea),
      material_product_id: sel.material_id ?? null,
      laminate_product_id: sel.laminate_id ?? null,
      material_name: mat?.name ?? null,
      laminate_name: lam?.name ?? null,
      plywood_qty: plywoodQty,
      laminate_qty: laminateQty,
      plywood_price: plywoodPrice,
      laminate_price: laminatePrice,
    };
  });
  const totalMaterialPrice = round2(total);

  // -- 4. Optionally persist -------------------------------------------------
  let unitId = body.unit_id ? String(body.unit_id) : null;
  if (body.save) {
    const projectId = String(body.project_id ?? "");
    if (!projectId) return json({ error: "Missing project." }, 400);

    const unitRow = {
      project_id: projectId,
      space: body.space ? String(body.space) : null,
      unit_name: body.unit_name ? String(body.unit_name) : null,
      csv_text: csvText,
      material_category: body.material_category ? String(body.material_category) : null,
      laminate_category: body.laminate_category ? String(body.laminate_category) : null,
      total_material_price: totalMaterialPrice,
    };

    if (unitId) {
      const { error } = await admin.from("turnkey_quote_box_units").update(unitRow).eq("id", unitId);
      if (error) return json({ error: `Save failed: ${error.message}` }, 500);
      await admin.from("turnkey_quote_box_groups").delete().eq("unit_id", unitId);
    } else {
      const { data, error } = await admin.from("turnkey_quote_box_units").insert(unitRow).select("id").single();
      if (error) return json({ error: `Save failed: ${error.message}` }, 500);
      unitId = data.id;
    }

    const groupRows = groups.map((g) => ({
      unit_id: unitId,
      thickness: g.thickness,
      panel_count: g.panel_count,
      group_area_sqft: g.group_area_sqft,
      material_product_id: g.material_product_id,
      laminate_product_id: g.laminate_product_id,
      plywood_qty: g.plywood_qty,
      laminate_qty: g.laminate_qty,
      plywood_price: g.plywood_price,
      laminate_price: g.laminate_price,
    }));
    if (groupRows.length) {
      const { error } = await admin.from("turnkey_quote_box_groups").insert(groupRows);
      if (error) return json({ error: `Save failed (groups): ${error.message}` }, 500);
    }
  }

  return json({ ok: true, groups, total_material_price: totalMaterialPrice, unit_id: unitId, saved: Boolean(body.save) });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// Parses the semicolon cutlist and returns { thickness: { count, areaMm2 } }.
// areaMm2 sums (Length+2)(Width+2)*Quantity across the group's panels.
function groupCutlist(text: string): Record<string, { count: number; areaMm2: number }> {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) throw new Error("empty file");

  const header = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.findIndex((h) => h === name);
  const iLen = col("length"), iWid = col("width"), iThk = col("thickness"), iQty = col("quantity");
  if (iLen < 0 || iWid < 0 || iThk < 0) {
    throw new Error("expected columns Length, Width, Thickness");
  }

  const num = (v: string) => Number(String(v ?? "").replace(/[^\d.\-]/g, ""));
  const out: Record<string, { count: number; areaMm2: number }> = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(";");
    const L = num(cells[iLen]), W = num(cells[iWid]), T = num(cells[iThk]);
    const q = iQty >= 0 ? Math.max(1, Math.round(num(cells[iQty])) || 1) : 1;
    if (!Number.isFinite(L) || !Number.isFinite(W) || !Number.isFinite(T) || L <= 0 || W <= 0) continue;
    const key = String(T);
    if (!out[key]) out[key] = { count: 0, areaMm2: 0 };
    out[key].count += q;
    out[key].areaMm2 += (L + 2) * (W + 2) * q;
  }
  if (!Object.keys(out).length) throw new Error("no valid panel rows");
  return out;
}
