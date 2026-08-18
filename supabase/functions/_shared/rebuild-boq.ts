// ============================================================================
// rebuild-boq — rebuild a project's aggregated Bill of Quantities
// ============================================================================
//
// The project BOQ (turnkey_project_boq) is the sum of every unit's stored
// computed.boq_lines, across ALL quotation categories that contribute to it:
//   * turnkey_quote_box_units  (Box & Shutters)
//   * turnkey_quote_wall_panels (Wall Panels)
//
// Called after any of those is saved or deleted, so whichever category writes
// last still produces a complete BOQ. Resilient to a category table that does
// not exist yet (its query error is ignored, treated as no lines).
// ============================================================================

// deno-lint-ignore no-explicit-any
type Any = any;

export async function rebuildBoq(admin: Any, projectId: string) {
  const agg = new Map<string, { product_name: string; category: string; quantity: number }>();

  const addRows = (rows: Any[] | null) => {
    (rows ?? []).forEach((u: Any) => {
      const lines = (u.computed && u.computed.boq_lines) || [];
      lines.forEach((l: Any) => {
        const key = `${l.category}||${l.product_name}`;
        const cur = agg.get(key) ?? { product_name: l.product_name, category: l.category, quantity: 0 };
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
}
