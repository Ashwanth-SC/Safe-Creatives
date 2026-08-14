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
  async function loadBoxUnits(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_box_units")
      .select("id, space, unit_name, material_spec, design_spec, total_price, margin_price, discount_price, gst_price, created_at")
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
    if (error) throw error;
    if (data && data.error) throw new Error(data.error);
    return data;
  }

  async function renderBoxShutters(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let spaces, products, units;
    try {
      [spaces, products, units] = await Promise.all([
        loadSelectedSpaces(currentProject),
        loadProducts(),
        loadBoxUnits(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table/column, run migrations 027–029.`)
      );
      return;
    }
    const ref = { spaces, products };
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
    grid.append(field("Area", spaceS), field("Unit name", nameI), field("Cutlist", importBtn));
    grid.appendChild(fileInput);

    // Material / laminate selectors (single-select).
    const matBrandS = selectEl(materialBrands, u.material_brand || "", "Material brand…");
    const subS = selectEl(subsForBrand(u.material_brand || ""), u.material_sub_category || "", "Sub category…");
    const lamBrandS = selectEl(laminateBrands, u.laminate_brand || "", "Laminate brand…");
    const outerS = selectEl(lamsForBrand(u.laminate_brand || ""), u.outer_laminate_id || "", "Outer laminate…");
    const innerS = selectEl(lamsForBrand(u.laminate_brand || ""), u.inner_laminate_id || "", "Inner laminate…");

    matBrandS.addEventListener("change", () => replaceOptions(subS, subsForBrand(matBrandS.value), "", "Sub category…"));
    lamBrandS.addEventListener("change", () => {
      const lams = lamsForBrand(lamBrandS.value);
      replaceOptions(outerS, lams, "", "Outer laminate…");
      replaceOptions(innerS, lams, "", "Inner laminate…");
    });

    const selRow = el("div", "admin-inline");
    selRow.append(
      field("Material brand", matBrandS),
      field("Sub category", subS),
      field("Laminate brand", lamBrandS),
      field("Outer laminate", outerS),
      field("Inner laminate", innerS)
    );

    const sectionsWrap = el("div", "tk-box-sections");
    const msg = el("p", "admin-hint", "");

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
    });

    async function compute(save) {
      if (!csvText) return void (msg.textContent = "Import a cutlist CSV first.");
      msg.textContent = save ? "Saving…" : "Computing…";
      try {
        const res = await computeUnit(inputs(save));
        if (save) unitId = res.unit_id;
        renderSections(sectionsWrap, res.computed);
        msg.textContent = "";
        if (save) {
          message(`Saved ${nameI.value.trim() || "unit"} — ${money(res.computed.totals.gst_price)} (with GST).`);
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
    else renderSections(sectionsWrap, null);
    return block;
  }

  // Renders the 3 bifurcations + totals from the computed breakdown.
  function renderSections(container, computed) {
    container.textContent = "";
    if (!computed) {
      container.appendChild(el("p", "dash-note", "Import a cutlist and choose materials, then Compute."));
      return;
    }

    // 1 — Cutlist grouped by thickness (+ laminate summary)
    const s1 = el("div", "tk-box-section");
    s1.appendChild(el("div", "tk-box-section-head", "1 · Cutlist by thickness"));
    const t1 = el("table", "dash-table");
    const h1 = el("tr");
    ["Thickness", "Panels", "Area (sqft)", "Board", "Sheets", "Plywood ₹"].forEach((h) => h1.appendChild(el("th", null, h)));
    t1.appendChild(h1);
    (computed.groups || []).forEach((g) => {
      const tr = el("tr");
      [
        `${g.thickness} mm`, String(g.panel_count), String(g.area_sqft),
        g.missing ? "⚠ no board found" : g.product_name || "—",
        g.ply_qty ?? "—", money(g.ply_price),
      ].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
      t1.appendChild(tr);
    });
    const sc1 = el("div", "table-scroll"); sc1.appendChild(t1); s1.appendChild(sc1);
    const lam = computed.laminate;
    s1.appendChild(el("p", "tk-box-line",
      `Laminate — outer: ${lam.outer.qty ?? "—"} sheet(s) ${money(lam.outer.price)} · inner: ${lam.inner.qty ?? "—"} sheet(s) ${money(lam.inner.price)}`));
    container.appendChild(s1);

    // 2 — Accessories & hardware
    const s2 = el("div", "tk-box-section");
    s2.appendChild(el("div", "tk-box-section-head", "2 · Accessories & hardware"));
    const hw = computed.hardware;
    const lines = [];
    if (hw.edge_hinge.qty) lines.push(`Edge hinges (${hw.edge_hinge.name || "—"}): ${hw.edge_hinge.qty} → ${money(hw.edge_hinge.price)}`);
    if (hw.inner_hinge.qty) lines.push(`Inner hinges (${hw.inner_hinge.name || "—"}): ${hw.inner_hinge.qty} → ${money(hw.inner_hinge.price)}`);
    if (hw.channels.qty) lines.push(`Channels (${hw.channels.names.join(", ") || "—"}): ${hw.channels.qty} → ${money(hw.channels.price)}`);
    if (!lines.length) lines.push("No hinges or channels for this unit.");
    lines.forEach((l) => s2.appendChild(el("p", "tk-box-line", l)));
    container.appendChild(s2);

    // 3 — Special additions (placeholder)
    const s3 = el("div", "tk-box-section");
    s3.appendChild(el("div", "tk-box-section-head", "3 · Special additions"));
    s3.appendChild(el("p", "dash-note", "To be added later."));
    container.appendChild(s3);

    // Totals
    const tot = computed.totals;
    const totBox = el("div", "tk-box-totals");
    [["Total", tot.total], ["With margin", tot.margin_price], ["With discount", tot.discount_price], ["With GST", tot.gst_price]].forEach(
      ([label, val]) => {
        const d = el("div", "tk-box-total-cell");
        d.appendChild(el("span", "tk-box-total-label", label));
        d.appendChild(el("span", "tk-box-total-val", money(val)));
        totBox.appendChild(d);
      }
    );
    container.appendChild(totBox);
  }

  function unitsList(units, onChanged) {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el("p", "dash-note", "Saved Box & Shutters units. Open to edit, or delete."));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Space", "Unit", "Material specifications", "Design specifications", "Total", "With margin", "With discount", "With GST", ""].forEach(
      (h) => hr.appendChild(el("th", null, h))
    );
    thead.appendChild(hr);
    const tbody = el("tbody");
    if (!units.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No units yet.");
      td.colSpan = 9;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    units.forEach((u) => {
      const open = el("button", "tk-email-link", "Open");
      open.type = "button";
      open.addEventListener("click", async () => {
        try {
          const existing = await loadBoxUnit(u.id);
          const ref = { spaces: await loadSelectedSpaces(currentProject), products: await loadProducts() };
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
        message("Unit deleted.");
        onChanged();
      });
      const actions = el("div", "tk-cell-actions");
      actions.append(open, del);

      const cells = [
        u.space || "—", u.unit_name || "—", u.material_spec || "—", u.design_spec || "—",
        money(u.total_price), money(u.margin_price), money(u.discount_price), money(u.gst_price), actions,
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
