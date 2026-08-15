// ============================================================================
// Safe Creatives — Turnkey quotation builder (page shell)
// ============================================================================
//
// Select a project, then work through the category tabs (Box & Shutters, Wall
// Panels, ...), the Quotation export, and the Vendor BOQ.
//
// This file is the navigation shell only. Each category's input form + pricing
// is built next: the plan is that inputs are sent to a backend function which
// runs the formulas and stores ONLY the computed values (quotation lines, BOQ,
// price) — versioned, so every save keeps the previous quotation for
// comparison. Admin only, like the dashboard.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const bodyEl = document.querySelector("#qt-body");
  const projectRow = document.querySelector("#qt-project-row");
  const tabsEl = document.querySelector("#qt-tabs");
  const panel = document.querySelector("#qt-panel");
  const messageEl = document.querySelector("#qt-message");

  if (!SC.isAdmin) {
    denied.hidden = false;
    return;
  }
  bodyEl.hidden = false;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Short description shown in each tab until its builder is created.
  const TAB_INFO = {
    "box-shutters": "Box & Shutters line items — modules, materials, LED / glass / product add-ons and assembly labour.",
    "wall-panels": "Wall Panels — panel type, base material, dimensions and quantity.",
    "furniture": "Furniture — units, materials and cost.",
    "civil": "Civil Work — tasks, area and rates.",
    "electrical": "Electrical work — points, fittings and rates.",
    "paint": "Paint work — surfaces, paint type and area.",
    "accessories": "Accessories — units, specifications and quantity.",
    "export": "Preview and export the full customer quotation — a table per category — as a PDF.",
    "vendor-boq": "The procurement Bill of Quantities — what to buy from each supplier, and the labour, derived from the quotation.",
  };

  let currentProject = null;
  let currentTab = "box-shutters";

  // ------------------------------------------------------------------
  // Project selector
  // ------------------------------------------------------------------
  async function loadProjects() {
    const { data, error } = await sb
      .from("turnkey_projects")
      .select("id, project_number, client_name, project_name, margin_percent, gst_percent, discount_percent")
      .order("project_number", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  const projectS = document.createElement("select");

  function message(text, isError) {
    messageEl.textContent = text || "";
    messageEl.className = `admin-message${isError ? " is-error" : text ? " is-ok" : ""}`;
  }

  function placeholder(tab) {
    const wrap = el("div", "admin-package");
    wrap.appendChild(el("p", "eyebrow", (document.querySelector(`.tab[data-tab="${tab}"]`)?.textContent || tab).toUpperCase()));
    wrap.appendChild(el("p", "dash-note", TAB_INFO[tab] || ""));
    wrap.appendChild(
      el(
        "p",
        "dash-note",
        currentProject
          ? "Builder coming next. Once built, entries here are computed in the backend and saved to this project's quotation (previous versions kept)."
          : "Select a project above to begin."
      )
    );
    return wrap;
  }

  function render() {
    panel.textContent = "";
    if (currentProject && currentTab === "box-shutters") {
      renderBoxShutters(panel);
      return;
    }
    panel.appendChild(placeholder(currentTab));
  }

  // ------------------------------------------------------------------
  // Small helpers for the builders
  // ------------------------------------------------------------------
  function field(labelText, control) {
    const wrap = el("label", "admin-field");
    wrap.appendChild(el("span", null, labelText));
    wrap.appendChild(control);
    return wrap;
  }
  function selectEl(options, value, blankLabel) {
    const s = document.createElement("select");
    if (blankLabel != null) s.appendChild(new Option(blankLabel, ""));
    options.forEach((o) => {
      const [val, lab] = Array.isArray(o) ? o : [o, o];
      s.appendChild(new Option(lab, val));
    });
    if (value != null) s.value = value;
    return s;
  }
  const money = (n) => (n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN"));

  // A compact multi-select dropdown: a trigger showing the picks, opening a
  // scrollable checkbox panel (so a long category list stays tidy). Returns the
  // DOM box and a live Set of the ticked values.
  function categoryMultiSelect(options, preselected, onChange) {
    const selected = new Set((preselected || []).filter(Boolean));
    const box = el("div", "tk-msel");
    const trigger = el("button", "tk-msel-trigger");
    trigger.type = "button";
    const panel = el("div", "tk-msel-panel");
    panel.hidden = true;

    function summary() {
      trigger.textContent = selected.size ? [...selected].join(", ") : "Select…";
      trigger.classList.toggle("is-empty", selected.size === 0);
    }
    summary();

    if (!options.length) panel.appendChild(el("span", "dash-note", "No categories — add them in the database."));
    options.forEach((name) => {
      const opt = el("label", "tk-msel-opt");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(name);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(name);
        else selected.delete(name);
        summary();
        onChange();
      });
      opt.append(cb, el("span", null, name));
      panel.appendChild(opt);
    });

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      box.classList.toggle("open", !panel.hidden);
    });
    // Close when clicking anywhere outside this dropdown.
    document.addEventListener("click", (e) => {
      if (!box.contains(e.target)) {
        panel.hidden = true;
        box.classList.remove("open");
      }
    });

    box.append(trigger, panel);
    return { box, selected };
  }
  function labeledBlock(labelText, node) {
    const d = el("div");
    d.appendChild(el("span", "admin-field-label", labelText));
    d.appendChild(node);
    return d;
  }
  const splitCats = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

  // ------------------------------------------------------------------
  // Box & Shutters — cutlist unit builder (backend does the maths)
  // ------------------------------------------------------------------
  async function loadSelectedSpaces(projectId) {
    const { data, error } = await sb
      .from("turnkey_project_spaces")
      .select("name, is_selected")
      .eq("project_id", projectId)
      .eq("is_selected", true)
      .order("name", { ascending: true });
    if (error) throw error;
    return (data || []).map((s) => s.name);
  }
  async function loadProductCategories() {
    const { data, error } = await sb.from("turnkey_product_categories").select("name").order("name");
    if (error) throw error;
    return (data || []).map((c) => c.name);
  }
  async function loadProducts() {
    const { data, error } = await sb
      .from("turnkey_products")
      .select("id, product_name, category, brand, sub_category, area_sqft, price_per_sqft, thickness");
    if (error) throw error;
    return data || [];
  }
  async function loadHardware() {
    const { data, error } = await sb
      .from("turnkey_hardwares")
      .select("id, product_name, category, size, price");
    if (error) throw error;
    return data || [];
  }
  async function loadBoxUnits(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_box_units")
      .select("id, space, unit_name, material_spec, design_spec, total_price, margin_price, margin_amount, discount_price, gst_price, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function loadBoxUnit(unitId) {
    const { data: unit, error } = await sb.from("turnkey_quote_box_units").select("*").eq("id", unitId).single();
    if (error) throw error;
    return { unit };
  }
  async function computeUnit(payload) {
    const { data, error } = await sb.functions.invoke("compute-box-unit", { body: payload });
    if (error) {
      // Surface the function's real message (it lives in the response body).
      let detail = error.message;
      try {
        const body = await error.context.json();
        if (body && body.error) detail = body.error;
      } catch (_ignored) { /* no JSON body */ }
      throw new Error(detail);
    }
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  async function renderBoxShutters(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let spaces, products, hardware, units;
    try {
      [spaces, products, hardware, units] = await Promise.all([
        loadSelectedSpaces(currentProject),
        loadProducts(),
        loadHardware(),
        loadBoxUnits(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table/column, run migrations 027–030.`)
      );
      return;
    }
    const ref = { spaces, products, hardware };
    container.textContent = "";
    container.appendChild(unitEditor(ref, null, () => renderBoxShutters(container)));
    container.appendChild(unitsList(units, () => renderBoxShutters(container)));
  }

  const distinctVals = (arr) => [...new Set(arr.filter((x) => x != null && x !== ""))];
  const normCat = (s) => String(s || "").trim().toLowerCase();
  function replaceOptions(select, options, value, blankLabel) {
    select.textContent = "";
    if (blankLabel != null) select.appendChild(new Option(blankLabel, ""));
    options.forEach((o) => {
      const [val, lab] = Array.isArray(o) ? o : [o, o];
      select.appendChild(new Option(lab, val));
    });
    select.value = value || "";
  }

  // The add / edit form for one unit. `existing` = { unit } to edit.
  function unitEditor(ref, existing, onSaved) {
    const u = existing?.unit || {};
    const block = el("details", "admin-package tk-add");
    block.open = !existing;
    block.appendChild(el("summary", null, existing ? `Edit unit — ${u.unit_name || "unnamed"}` : "Add a unit"));

    let csvText = u.csv_text || "";
    let unitId = u.id || null;

    // Reference sets derived from the products database.
    const plywood = ref.products.filter((p) => normCat(p.category) === "plywood");
    const laminate = ref.products.filter((p) => normCat(p.category) === "laminate");
    const materialBrands = distinctVals(plywood.map((p) => p.brand)).sort();
    const laminateBrands = distinctVals(laminate.map((p) => p.brand)).sort();
    const subsForBrand = (brand) => distinctVals(plywood.filter((p) => p.brand === brand).map((p) => p.sub_category)).sort();
    const lamsForBrand = (brand) => laminate.filter((p) => p.brand === brand).map((p) => [p.id, p.product_name || "unnamed"]);

    // Top inputs
    const spaceS = selectEl(ref.spaces, u.space || "", ref.spaces.length ? "Select area…" : "No spaces — set them up first");
    const nameI = document.createElement("input");
    nameI.type = "text";
    nameI.placeholder = "Unit name (e.g. Aurem wardrobe)";
    if (u.unit_name) nameI.value = u.unit_name;

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = ".csv,text/csv";
    fileInput.style.display = "none";
    const importBtn = el("button", "admin-primary-small", existing ? "Replace CSV" : "Import cutlist CSV");
    importBtn.type = "button";
    importBtn.addEventListener("click", () => fileInput.click());

    const grid = el("div", "admin-inline");
    grid.append(field("Space", spaceS), field("Unit name", nameI), field("Cutlist", importBtn));
    grid.appendChild(fileInput);

    // Plywood / laminate selectors (single-select).
    const matBrandS = selectEl(materialBrands, u.material_brand || "", "Plywood brand…");
    const subS = selectEl(subsForBrand(u.material_brand || ""), u.material_sub_category || "", "Plywood type…");
    const lamBrandS = selectEl(laminateBrands, u.laminate_brand || "", "Laminate brand…");
    const outerS = selectEl(lamsForBrand(u.laminate_brand || ""), u.outer_laminate_id || "", "Outer laminate…");
    const innerS = selectEl(lamsForBrand(u.laminate_brand || ""), u.inner_laminate_id || "", "Inner laminate…");

    matBrandS.addEventListener("change", () => replaceOptions(subS, subsForBrand(matBrandS.value), "", "Plywood type…"));
    lamBrandS.addEventListener("change", () => {
      const lams = lamsForBrand(lamBrandS.value);
      replaceOptions(outerS, lams, "", "Outer laminate…");
      replaceOptions(innerS, lams, "", "Inner laminate…");
    });

    // Hardware selectors (from the free-text hardware categories).
    const hwOptions = (cat) => (ref.hardware || []).filter((h) => normCat(h.category) === cat).map((h) => [h.id, h.product_name || "unnamed"]);
    const edgeHingeS = selectEl(hwOptions("edge hinges"), u.edge_hinge_id || "", "Edge hinge…");
    const innerHingeS = selectEl(hwOptions("inner hinges"), u.inner_hinge_id || "", "Inner hinge…");
    // Handles are chosen per part-category row in the handles table below.
    const handleOptions = hwOptions("handle");
    const handleSel = u.handle_ids && typeof u.handle_ids === "object" ? { ...u.handle_ids } : {};

    const selRow = el("div", "admin-inline tk-sel-grid");
    selRow.append(
      field("Plywood brand", matBrandS),
      field("Plywood type", subS),
      field("Laminate brand", lamBrandS),
      field("Outer laminate", outerS),
      field("Inner laminate", innerS),
      field("Edge hinge", edgeHingeS),
      field("Inner hinge", innerHingeS)
    );

    const sectionsWrap = el("div", "tk-box-sections");
    const msg = el("p", "admin-hint", "");

    // Passed to renderSections so the handles table can offer a handle dropdown
    // per part category; changing one recomputes the unit.
    const ctx = {
      handleOptions,
      handleSel,
      onHandleChange: (cat, id) => { if (id) handleSel[cat] = id; else delete handleSel[cat]; compute(false); },
    };

    const inputs = (save) => ({
      save,
      unit_id: unitId,
      project_id: currentProject,
      space: spaceS.value || null,
      unit_name: nameI.value.trim() || null,
      csv_text: csvText,
      material_brand: matBrandS.value || null,
      material_sub_category: subS.value || null,
      laminate_brand: lamBrandS.value || null,
      outer_laminate_id: outerS.value || null,
      inner_laminate_id: innerS.value || null,
      edge_hinge_id: edgeHingeS.value || null,
      inner_hinge_id: innerHingeS.value || null,
      handle_ids: handleSel,
    });

    async function compute(save) {
      if (!csvText) return void (msg.textContent = "Import a cutlist CSV first.");
      msg.textContent = save ? "Saving…" : "Computing…";
      try {
        const res = await computeUnit(inputs(save));
        if (save) unitId = res.unit_id;
        renderSections(sectionsWrap, res.computed, ctx);
        msg.textContent = "";
        if (save) {
          message(`Saved ${nameI.value.trim() || "unit"} — ${money(res.computed.totals.with_gst)} (with GST).`);
          onSaved();
        }
      } catch (error) {
        msg.textContent = `${save ? "Save" : "Compute"} failed: ${error.message}`;
      }
    }

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      csvText = await file.text();
      await compute(false);
    });

    const computeBtn = el("button", "admin-primary-small", "Compute");
    computeBtn.type = "button";
    computeBtn.addEventListener("click", () => compute(false));
    const saveBtn = el("button", "admin-primary", existing ? "Save changes" : "Save unit");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => compute(true));

    const actions = el("div", "admin-row-actions");
    actions.append(computeBtn, saveBtn);
    block.append(grid, selRow, sectionsWrap, actions, msg);

    if (existing && csvText) compute(false);
    else renderSections(sectionsWrap, null, ctx);
    return block;
  }

  // Renders the material tables, hardware sections + totals. `ctx` (optional)
  // makes the handles table interactive (a handle dropdown per part category).
  function renderSections(container, computed, ctx) {
    container.textContent = "";
    if (!computed) {
      container.appendChild(el("p", "dash-note", "Import a cutlist and choose materials, then Compute."));
      return;
    }

    const miniTable = (headers, rows) => {
      const scroll = el("div", "table-scroll");
      const t = el("table", "dash-table");
      const hr = el("tr");
      headers.forEach((h) => hr.appendChild(el("th", null, h)));
      t.appendChild(hr);
      rows.forEach((r) => {
        const tr = el("tr");
        r.forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
        t.appendChild(tr);
      });
      scroll.appendChild(t);
      return scroll;
    };
    const thk = (v) => (v != null ? `${v} mm` : "—");

    // --- Materials: plywood + outer + inner laminate ---
    const s1 = el("div", "tk-box-section");
    s1.appendChild(el("div", "tk-box-section-head", "Materials"));
    const plyRows = (computed.groups || []).map((g) => [
      g.missing ? "⚠ no board found" : g.product_name || "—", g.qty ?? "—", thk(g.thickness), money(g.price),
    ]);
    if (!plyRows.length) plyRows.push(["—", "—", "—", money(0)]);
    s1.appendChild(el("p", "tk-box-line", "Plywood"));
    s1.appendChild(miniTable(["Board", "Qty", "Thickness", "Total"], plyRows));
    const lam = computed.laminate;
    s1.appendChild(el("p", "tk-box-line", "Outer laminate"));
    s1.appendChild(miniTable(["Laminate", "Qty", "Thickness", "Total"], [[lam.outer.name || "—", lam.outer.qty ?? "—", thk(lam.outer.thickness), money(lam.outer.price)]]));
    s1.appendChild(el("p", "tk-box-line", "Inner laminate"));
    s1.appendChild(miniTable(["Laminate", "Qty", "Thickness", "Total"], [[lam.inner.name || "—", lam.inner.qty ?? "—", thk(lam.inner.thickness), money(lam.inner.price)]]));
    s1.appendChild(el("p", "tk-box-total", `Material total: ${money(computed.totals.material)}`));
    container.appendChild(s1);

    // --- Hinges ---
    const hg = computed.hinges;
    const s2 = el("div", "tk-box-section");
    s2.appendChild(el("div", "tk-box-section-head", "Hinges"));
    s2.appendChild(el("p", "tk-box-line", `Edge hinges (${hg.edge.name || "—"}): ${hg.edge.qty} → ${money(hg.edge.price)}`));
    s2.appendChild(el("p", "tk-box-line", `Inner hinges (${hg.inner.name || "—"}): ${hg.inner.qty} → ${money(hg.inner.price)}`));
    container.appendChild(s2);

    // --- Channels ---
    const ch = computed.channels;
    const s3 = el("div", "tk-box-section");
    s3.appendChild(el("div", "tk-box-section-head", "Channels"));
    s3.appendChild(el("p", "tk-box-line", `Channels (${ch.names.join(", ") || "—"}): ${ch.qty} → ${money(ch.price)}`));
    container.appendChild(s3);

    // --- Handles (a handle dropdown per part category) ---
    const ha = computed.handles;
    const s4 = el("div", "tk-box-section");
    s4.appendChild(el("div", "tk-box-section-head", "Handles"));
    const hScroll = el("div", "table-scroll");
    const hT = el("table", "dash-table");
    const hHr = el("tr");
    ["Part", "Handles", "Handle", "Total"].forEach((h) => hHr.appendChild(el("th", null, h)));
    hT.appendChild(hHr);
    (ha.table || []).forEach((r) => {
      const tr = el("tr");
      const c1 = el("td"); c1.textContent = r.category; tr.appendChild(c1);
      const c2 = el("td"); c2.textContent = r.qty; tr.appendChild(c2);
      const c3 = el("td");
      if (ctx) {
        const sel = selectEl(ctx.handleOptions, ctx.handleSel[r.category] || "", "Select handle…");
        sel.addEventListener("change", () => ctx.onHandleChange(r.category, sel.value));
        c3.appendChild(sel);
      } else {
        c3.textContent = r.handle_name || "—";
      }
      tr.appendChild(c3);
      const c4 = el("td"); c4.textContent = money(r.price); tr.appendChild(c4);
      hT.appendChild(tr);
    });
    hScroll.appendChild(hT);
    s4.appendChild(hScroll);
    s4.appendChild(el("p", "tk-box-line", `Handles total: ${ha.qty} → ${money(ha.price)}`));
    container.appendChild(s4);

    // --- Special additions ---
    const s5 = el("div", "tk-box-section");
    s5.appendChild(el("div", "tk-box-section-head", "Special additions"));
    s5.appendChild(el("p", "dash-note", "To be added later."));
    container.appendChild(s5);

    // --- Totals ---
    const tot = computed.totals;
    const totBox = el("div", "tk-box-totals");
    [
      ["Total", tot.total], ["With margin", tot.with_margin], ["Margin", tot.margin_amount],
      ["With discount", tot.with_discount], ["With GST", tot.with_gst],
    ].forEach(([label, val]) => {
      const d = el("div", "tk-box-total-cell");
      d.appendChild(el("span", "tk-box-total-label", label));
      d.appendChild(el("span", "tk-box-total-val", money(val)));
      totBox.appendChild(d);
    });
    container.appendChild(totBox);
  }

  function unitsList(units, onChanged) {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el("p", "dash-note", "Saved Box & Shutters units. Open to edit, or delete."));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Space", "Unit", "Material specifications", "Design specifications", "Total", "With margin", "Margin", "With discount", "With GST", ""].forEach(
      (h) => hr.appendChild(el("th", null, h))
    );
    thead.appendChild(hr);
    const tbody = el("tbody");
    if (!units.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No units yet.");
      td.colSpan = 10;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    units.forEach((u) => {
      const open = el("button", "tk-email-link", "Open");
      open.type = "button";
      open.addEventListener("click", async () => {
        try {
          const existing = await loadBoxUnit(u.id);
          const ref = { spaces: await loadSelectedSpaces(currentProject), products: await loadProducts(), hardware: await loadHardware() };
          panel.textContent = "";
          panel.appendChild(unitEditor(ref, existing, () => renderBoxShutters(panel)));
          panel.appendChild(unitsList(await loadBoxUnits(currentProject), () => renderBoxShutters(panel)));
        } catch (error) {
          message(`Could not open: ${error.message}`, true);
        }
      });
      const del = el("button", "tk-delete-link", "Delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete unit "${u.unit_name || "unnamed"}"? This cannot be undone.`)) return;
        const { error } = await sb.from("turnkey_quote_box_units").delete().eq("id", u.id);
        if (error) return void message(`Could not delete: ${error.message}`, true);
        try { await computeUnit({ recompute_boq: true, project_id: currentProject }); } catch (_e) { /* BOQ rebuild best-effort */ }
        message("Unit deleted.");
        onChanged();
      });
      const actions = el("div", "tk-cell-actions");
      actions.append(open, del);

      const cells = [
        u.space || "—", u.unit_name || "—", u.material_spec || "—", u.design_spec || "—",
        money(u.total_price), money(u.margin_price), money(u.margin_amount), money(u.discount_price), money(u.gst_price), actions,
      ];
      const tr = el("tr");
      cells.forEach((c) => {
        const td = el("td");
        if (c instanceof Node) td.appendChild(c);
        else td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    t.append(thead, tbody);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    return wrap;
  }

  function selectProject(id) {
    currentProject = id || null;
    tabsEl.hidden = !currentProject;
    if (currentProject) {
      const p = projectsById.get(currentProject);
      message(
        p
          ? `Project #${p.project_number} — ${p.client_name}${p.margin_percent == null ? " · ⚠ set margin/GST/discount in the dashboard first" : ""}`
          : ""
      );
    } else {
      message("");
    }
    render();
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  let projectsById = new Map();
  try {
    const projects = await loadProjects();
    projectsById = new Map(projects.map((p) => [p.id, p]));

    projectS.appendChild(el("option", null, projects.length ? "Select a project…" : "No projects yet"));
    projects.forEach((p) => {
      const o = el("option", null, `#${p.project_number} — ${p.client_name}` + (p.project_name ? ` — ${p.project_name}` : ""));
      o.value = p.id;
      projectS.appendChild(o);
    });

    const label = el("label", "admin-field");
    label.appendChild(el("span", null, "Project"));
    label.appendChild(projectS);
    projectRow.appendChild(label);

    projectS.addEventListener("change", () => selectProject(projectS.value));

    // Optional ?project=<id> preselect (e.g. a link from the dashboard).
    const wanted = new URLSearchParams(location.search).get("project");
    if (wanted && projectsById.has(wanted)) {
      projectS.value = wanted;
      selectProject(wanted);
    } else {
      render();
    }
  } catch (error) {
    message(`Could not load projects: ${error.message}`, true);
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b === btn));
      currentTab = btn.dataset.tab;
      render();
    });
  });
})();
