// ============================================================================
// rebuild-boq — rebuild a project's aggregated Bill of Quantities
// ============================================================================
//
// The project BOQ (turnkey_project_boq) is the sum of every unit's stored
// computed.boq_lines, across ALL quotation categories that contribute to it:
//   * turnkey_quote_box_units  (Box & Shutters)
//   * turnkey_quote_wall_panels (Wall Panels)
//
// Each line carries supplier + unit_price (for the Vendor BOQ). Lines saved
// before that change lack them, so they're backfilled by matching product_name
// against the products / hardwares databases (best-effort — name-based).
//
// Called after any contributing category is saved/deleted, so whichever writes
// last still produces a complete BOQ. Resilient: a missing category table or a
// failed write is swallowed, so a BOQ hiccup never breaks a unit save.
// ============================================================================

// deno-lint-ignore no-explicit-any
type Any = any;

interface Line { product_name: string; category: string; quantity: number; supplier: string | null; unit_price: number | null; }

export async function rebuildBoq(admin: Any, projectId: string) {
  try {
    // Name -> {supplier, price} backfill map from the catalogs (for older lines).
    const backfill = new Map<string, { supplier: string | null; price: number | null }>();
    const put = (name: Any, supplier: Any, price: Any) => {
      const key = String(name ?? "").trim().toLowerCase();
      if (key && !backfill.has(key)) backfill.set(key, { supplier: supplier ?? null, price: price == null ? null : Number(price) });
    };
    const prod = await admin.from("turnkey_products").select("product_name, supplier, price_per_sqft");
    if (!prod.error) (prod.data ?? []).forEach((p: Any) => put(p.product_name, p.supplier, p.price_per_sqft));
    const hw = await admin.from("turnkey_hardwares").select("product_name, supplier, price");
    if (!hw.error) (hw.data ?? []).forEach((h: Any) => put(h.product_name, h.supplier, h.price));

    const agg = new Map<string, Line>();
    const addRows = (rows: Any[] | null) => {
      (rows ?? []).forEach((u: Any) => {
        const lines = (u.computed && u.computed.boq_lines) || [];
        lines.forEach((l: Any) => {
          const name = String(l.product_name ?? "");
          const bf = backfill.get(name.trim().toLowerCase());
          const supplier = l.supplier ?? bf?.supplier ?? null;
          const unitPrice = l.unit_price != null ? Number(l.unit_price) : (bf?.price ?? null);
          const key = `${l.category}||${name}||${supplier ?? ""}`;
          const cur = agg.get(key) ?? { product_name: name, category: l.category, quantity: 0, supplier, unit_price: unitPrice };
          cur.quantity += Number(l.quantity) || 0;
          agg.set(key, cur);
        });
      });
    };

    for (const table of ["turnkey_quote_box_units", "turnkey_quote_wall_panels"]) {
      const { data, error } = await admin.from(table).select("computed").eq("project_id", projectId);
      if (!error) addRows(data);
    }

    await admin.from("turnkey_project_boq").delete().eq("project_id", projectId);
    const rows = [...agg.values()].map((r) => ({ project_id: projectId, ...r }));
    if (rows.length) await admin.from("turnkey_project_boq").insert(rows);
  } catch (_e) {
    // Best-effort: a BOQ rebuild failure must not fail the unit save.
  }
}
