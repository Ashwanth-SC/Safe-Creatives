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
    if (currentProject && currentTab === "wall-panels") {
      renderWallPanels(panel);
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
  async function loadLabour() {
    const { data, error } = await sb
      .from("turnkey_labour")
      .select("id, category, name, task, cost_per_day, cost_per_sqft")
      .order("category", { ascending: true });
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
    return invokeCompute("compute-box-unit", payload);
  }
  async function computeWallPanel(payload) {
    return invokeCompute("compute-wall-panel", payload);
  }
  async function invokeCompute(fn, payload) {
    const { data, error } = await sb.functions.invoke(fn, { body: payload });
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
  async function loadWallPanels(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_wall_panels")
      .select("id, space, panel_type, length_mm, width_mm, material_spec, design_spec, total_price, margin_price, margin_amount, discount_price, gst_price, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function loadWallPanel(id) {
    const { data: unit, error } = await sb.from("turnkey_quote_wall_panels").select("*").eq("id", id).single();
    if (error) throw error;
    return { unit };
  }

  async function renderBoxShutters(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let spaces, products, hardware, labour, units;
    try {
      [spaces, products, hardware, labour, units] = await Promise.all([
        loadSelectedSpaces(currentProject),
        loadProducts(),
        loadHardware(),
        loadLabour(),
        loadBoxUnits(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table/column, run migrations 027–032.`)
      );
      return;
    }
    const ref = { spaces, products, hardware, labour };
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

    // Special additions (name + cost) and Labour (category -> name -> task +
    // days + sqft) — both editable below, both fold into the base total on save.
    const special = (Array.isArray(u.special_additions) ? u.special_additions : []).map((s) => ({ name: s.name || "", cost: s.cost ?? "" }));
    const labour = (Array.isArray(u.labour_lines) ? u.labour_lines : []).map((l) => ({
      labour_id: l.labour_id || "", category: l.category || "", name: l.name || "",
      task: l.task || "", total_days: l.total_days ?? "",
      sqft_categories: Array.isArray(l.sqft_categories) ? [...l.sqft_categories] : [],
      total_sqft: l.total_sqft ?? "",
    }));
    const labourRows = ref.labour || [];
    const labourById = new Map(labourRows.map((r) => [r.id, r]));
    const labourCategories = distinctVals(labourRows.map((r) => r.category)).sort();
    const namesForCat = (cat) => distinctVals(labourRows.filter((r) => r.category === cat).map((r) => r.name)).sort();
    const tasksForCatName = (cat, name) =>
      labourRows.filter((r) => r.category === cat && r.name === name).map((r) => [r.id, r.task || "(no task)"]);

    // Latest per-part-category sqft (from the last compute); the labour sqft
    // picker sums the selected categories from this. Seeded from a reopened
    // unit's stored breakdown so the picker shows numbers before recomputing.
    let catSqftList = (existing && u.computed && Array.isArray(u.computed.category_sqft)) ? u.computed.category_sqft : [];
    const rowSqft = (row) => {
      const cats = Array.isArray(row.sqft_categories) ? row.sqft_categories : [];
      if (cats.length) {
        const m = new Map(catSqftList.map((r) => [r.category, Number(r.sqft) || 0]));
        return cats.reduce((s, c) => s + (m.get(c) || 0), 0);
      }
      return Number(row.total_sqft) || 0;
    };
    const labourCost = (row) => {
      const lr = row.labour_id ? labourById.get(row.labour_id) : null;
      if (!lr) return 0;
      return (Number(row.total_days) || 0) * (Number(lr.cost_per_day) || 0) + rowSqft(row) * (Number(lr.cost_per_sqft) || 0);
    };

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
    const totalsWrap = el("div");
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
      special_additions: special
        .map((s) => ({ name: (s.name || "").trim(), cost: Number(s.cost) || 0 }))
        .filter((s) => s.name || s.cost),
      labour_lines: labour
        .map((l) => ({
          labour_id: l.labour_id || null,
          total_days: Number(l.total_days) || 0,
          sqft_categories: Array.isArray(l.sqft_categories) ? l.sqft_categories : [],
          total_sqft: Number(l.total_sqft) || 0,
        }))
        .filter((l) => l.labour_id || l.total_days || l.sqft_categories.length || l.total_sqft),
    });

    // ---- Special additions (interactive; persists across recomputes) -------
    const specialSection = buildSpecialSection(special, () => compute(false));

    // ---- Labour (interactive) + per-category sqft reference ----------------
    const catSqftBox = el("div", "tk-cat-sqft");
    const labourUI = buildLabourSection(
      {
        labour, labourCategories, namesForCat, tasksForCatName, labourCost, rowSqft,
        hasLabour: labourRows.length > 0, catSqftBox, getCatSqft: () => catSqftList,
      },
      () => compute(false)
    );

    async function compute(save) {
      if (!csvText) return void (msg.textContent = "Import a cutlist CSV first.");
      msg.textContent = save ? "Saving…" : "Computing…";
      try {
        const res = await computeUnit(inputs(save));
        if (save) unitId = res.unit_id;
        catSqftList = (res.computed && res.computed.category_sqft) || [];
        renderSections(sectionsWrap, res.computed, ctx);
        renderTotals(totalsWrap, res.computed);
        renderCatSqft(catSqftBox, res.computed);
        labourUI.refresh();
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
    const extrasWrap = el("div", "tk-box-sections");
    extrasWrap.append(specialSection, labourUI.node);
    block.append(grid, selRow, sectionsWrap, extrasWrap, totalsWrap, actions, msg);

    renderCatSqft(catSqftBox, null);
    renderTotals(totalsWrap, null);
    if (existing && csvText) compute(false);
    else renderSections(sectionsWrap, null, ctx);
    return block;
  }

  // The Special additions table: rows of { name, cost }, add / remove. Mutates
  // the shared `special` array in place; `onChange` recomputes the unit total.
  function buildSpecialSection(special, onChange) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Special additions"));
    wrap.appendChild(el("p", "dash-note", "Extra line items. Each name is appended to the Design specifications; the cost adds into the total (margin, discount & GST apply)."));

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Addition", "Cost", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    t.append(thead, tbody);
    scroll.appendChild(t);

    const subtotal = el("p", "tk-box-total", "");
    const refreshSubtotal = () => {
      const sum = special.reduce((s, r) => s + (Number(r.cost) || 0), 0);
      subtotal.textContent = `Special additions total: ${money(sum)}`;
    };

    function addRowDom(row) {
      const tr = el("tr");
      const nameTd = el("td");
      const nameI = document.createElement("input");
      nameI.type = "text";
      nameI.className = "grid-input";
      nameI.placeholder = "e.g. LED strip";
      nameI.value = row.name || "";
      nameI.addEventListener("input", () => { row.name = nameI.value; });
      nameI.addEventListener("change", onChange);
      nameTd.appendChild(nameI);

      const costTd = el("td");
      const costI = document.createElement("input");
      costI.type = "number";
      costI.min = "0";
      costI.className = "grid-input";
      costI.placeholder = "0";
      costI.value = row.cost === "" || row.cost == null ? "" : row.cost;
      costI.addEventListener("input", () => { row.cost = costI.value; refreshSubtotal(); });
      costI.addEventListener("change", onChange);
      costTd.appendChild(costI);

      const delTd = el("td", "db-grid-del");
      const del = el("button", "tk-delete-link", "✕");
      del.type = "button";
      del.title = "Remove";
      del.addEventListener("click", () => {
        const idx = special.indexOf(row);
        if (idx >= 0) special.splice(idx, 1);
        tr.remove();
        refreshSubtotal();
        onChange();
      });
      delTd.appendChild(del);

      tr.append(nameTd, costTd, delTd);
      tbody.appendChild(tr);
      return nameI;
    }
    special.forEach(addRowDom);

    const addBtn = el("button", "admin-primary-small", "+ Add addition");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      const row = { name: "", cost: "" };
      special.push(row);
      addRowDom(row).focus();
    });

    wrap.append(scroll, addBtn, subtotal);
    refreshSubtotal();
    return wrap;
  }

  // The Labour table: category -> name -> task cascade + days + a sqft picker
  // (sqft = sum of the chosen box & shutters categories), a live computed cost
  // per row, and the per-part-category sqft reference below. Returns
  // { node, refresh }; refresh() re-syncs the sqft pickers + costs after a
  // recompute changes the per-category sqft.
  function buildLabourSection(cfg, onChange) {
    const { labour, labourCategories, namesForCat, tasksForCatName, labourCost, rowSqft, hasLabour, catSqftBox, getCatSqft } = cfg;
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Labour"));
    if (!hasLabour) {
      wrap.appendChild(el("p", "dash-note", "No labour in the database yet — add labourers (with their task and rates) in the Turnkey database first."));
      wrap.appendChild(catSqftBox);
      return { node: wrap, refresh: () => {} };
    }
    wrap.appendChild(el("p", "dash-note", "Pick a labourer by category → name → task, enter the days, then tick the box & shutters categories this task covers — their sqft is summed automatically. Cost = days × cost/day + sqft × cost/sqft; it adds into the total (margin, discount & GST apply)."));

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Labour category", "Name", "Task", "Total days", "Total sqft (pick categories)", "Cost", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    t.append(thead, tbody);
    scroll.appendChild(t);

    const subtotal = el("p", "tk-box-total", "");
    const refreshSubtotal = () => {
      const sum = labour.reduce((s, r) => s + labourCost(r), 0);
      subtotal.textContent = `Labour total: ${money(sum)}`;
    };

    // Per-row re-sync hooks, so a recompute can refresh every row's picker + cost.
    const rowRefreshers = [];

    function addRowDom(row) {
      const tr = el("tr");
      const catSel = selectEl(labourCategories, row.category || "", "Category…");
      const nameSel = selectEl(namesForCat(row.category || ""), row.name || "", "Name…");
      const taskSel = selectEl(tasksForCatName(row.category || "", row.name || ""), row.labour_id || "", "Task…");
      const daysI = document.createElement("input");
      daysI.type = "number"; daysI.min = "0"; daysI.className = "grid-input"; daysI.placeholder = "0";
      daysI.value = row.total_days === "" || row.total_days == null ? "" : row.total_days;
      const costCell = el("td");
      const updateCost = () => { costCell.textContent = money(labourCost(row)); refreshSubtotal(); };
      const sqftPick = buildSqftPicker(row, getCatSqft, () => rowSqft(row), () => { updateCost(); onChange(); });

      catSel.addEventListener("change", () => {
        row.category = catSel.value; row.name = ""; row.labour_id = ""; row.task = "";
        replaceOptions(nameSel, namesForCat(row.category), "", "Name…");
        replaceOptions(taskSel, [], "", "Task…");
        updateCost(); onChange();
      });
      nameSel.addEventListener("change", () => {
        row.name = nameSel.value; row.labour_id = ""; row.task = "";
        replaceOptions(taskSel, tasksForCatName(row.category, row.name), "", "Task…");
        updateCost(); onChange();
      });
      taskSel.addEventListener("change", () => {
        row.labour_id = taskSel.value;
        row.task = taskSel.options[taskSel.selectedIndex]?.textContent || "";
        updateCost(); onChange();
      });
      daysI.addEventListener("input", () => { row.total_days = daysI.value; updateCost(); });
      daysI.addEventListener("change", onChange);

      const cell = (control) => { const td = el("td"); td.appendChild(control); return td; };
      const delTd = el("td", "db-grid-del");
      const del = el("button", "tk-delete-link", "✕");
      del.type = "button"; del.title = "Remove";
      const refresher = () => { sqftPick.refresh(); updateCost(); };
      del.addEventListener("click", () => {
        const li = labour.indexOf(row);
        if (li >= 0) labour.splice(li, 1);
        const ri = rowRefreshers.indexOf(refresher);
        if (ri >= 0) rowRefreshers.splice(ri, 1);
        tr.remove();
        refreshSubtotal();
        onChange();
      });
      delTd.appendChild(del);

      tr.append(cell(catSel), cell(nameSel), cell(taskSel), cell(daysI), cell(sqftPick.node), costCell, delTd);
      costCell.textContent = money(labourCost(row));
      rowRefreshers.push(refresher);
      tbody.appendChild(tr);
      return catSel;
    }
    labour.forEach(addRowDom);

    const addBtn = el("button", "admin-primary-small", "+ Add labour");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      const row = { labour_id: "", category: "", name: "", task: "", total_days: "", sqft_categories: [], total_sqft: "" };
      labour.push(row);
      addRowDom(row).focus();
    });

    wrap.append(scroll, addBtn, subtotal, catSqftBox);
    refreshSubtotal();
    return {
      node: wrap,
      refresh: () => { rowRefreshers.forEach((fn) => fn()); refreshSubtotal(); },
    };
  }

  // A per-row sqft control: a compact multi-select of the box & shutters
  // categories (each labelled with its sqft). The row's sqft is the sum of the
  // ticked categories. `getCatSqft()` returns the current [{category, sqft}];
  // `getSum()` returns the row's summed sqft. Returns { node, refresh } — call
  // refresh() when the per-category sqft changes.
  function buildSqftPicker(row, getCatSqft, getSum, onChange) {
    if (!Array.isArray(row.sqft_categories)) row.sqft_categories = [];
    const selected = new Set(row.sqft_categories);
    const box = el("div", "tk-msel tk-sqft-pick");
    const trigger = el("button", "tk-msel-trigger");
    trigger.type = "button";
    const panel = el("div", "tk-msel-panel");
    panel.hidden = true;

    const summary = () => {
      const n = selected.size;
      trigger.textContent = n ? `${Math.round(getSum() * 100) / 100} sqft · ${n} categor${n > 1 ? "ies" : "y"}` : "Pick categories…";
      trigger.classList.toggle("is-empty", n === 0);
    };

    const rebuild = () => {
      panel.textContent = "";
      const cats = getCatSqft() || [];
      if (cats.length) {
        // Drop selections no longer present in the current cutlist.
        const names = new Set(cats.map((c) => c.category));
        [...selected].forEach((c) => { if (!names.has(c)) selected.delete(c); });
        row.sqft_categories = [...selected];
        cats.forEach(({ category, sqft }) => {
          const opt = el("label", "tk-msel-opt");
          const cb = document.createElement("input");
          cb.type = "checkbox";
          cb.checked = selected.has(category);
          cb.addEventListener("change", () => {
            if (cb.checked) selected.add(category); else selected.delete(category);
            row.sqft_categories = [...selected];
            summary();
            onChange();
          });
          opt.append(cb, el("span", null, `${category} — ${sqft}`));
          panel.appendChild(opt);
        });
      } else {
        panel.appendChild(el("span", "dash-note", "Import a cutlist & Compute to list categories."));
      }
      summary();
    };

    trigger.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      box.classList.toggle("open", !panel.hidden);
    });
    document.addEventListener("click", (e) => {
      if (!box.contains(e.target)) { panel.hidden = true; box.classList.remove("open"); }
    });

    box.append(trigger, panel);
    rebuild();
    return { node: box, refresh: rebuild };
  }

  // The per-part-category sqft reference (from the cutlist) shown under Labour.
  function renderCatSqft(container, computed) {
    container.textContent = "";
    container.appendChild(el("p", "tk-box-line tk-cat-sqft-head", "Sqft by box & shutters category (from the cutlist):"));
    const rows = (computed && computed.category_sqft) || [];
    if (!rows.length) {
      container.appendChild(el("p", "dash-note", "Import a cutlist and Compute to see the per-category sqft."));
      return;
    }
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const hr = el("tr");
    ["Category", "Total sqft"].forEach((h) => hr.appendChild(el("th", null, h)));
    t.appendChild(hr);
    let total = 0;
    rows.forEach((r) => {
      total += Number(r.sqft) || 0;
      const tr = el("tr");
      const c1 = el("td"); c1.textContent = r.category;
      const c2 = el("td"); c2.textContent = r.sqft;
      tr.append(c1, c2);
      t.appendChild(tr);
    });
    const trT = el("tr", "tk-cat-sqft-total");
    const cT1 = el("td"); cT1.textContent = "All categories";
    const cT2 = el("td"); cT2.textContent = Math.round(total * 100) / 100;
    trT.append(cT1, cT2);
    t.appendChild(trT);
    scroll.appendChild(t);
    container.appendChild(scroll);
  }

  // The totals box (Total → With margin → Margin → With discount → With GST).
  function renderTotals(container, computed) {
    container.textContent = "";
    if (!computed) return;
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

    // Special additions, Labour and the totals box render after this, in their
    // own persistent sections (they stay editable across recomputes).
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
          const ref = { spaces: await loadSelectedSpaces(currentProject), products: await loadProducts(), hardware: await loadHardware(), labour: await loadLabour() };
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

  // ------------------------------------------------------------------
  // Wall Panels — Direct / Base / Framed (backend does the maths)
  // ------------------------------------------------------------------
  async function renderWallPanels(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let spaces, products, labour, panels;
    try {
      [spaces, products, labour, panels] = await Promise.all([
        loadSelectedSpaces(currentProject),
        loadProducts(),
        loadLabour(),
        loadWallPanels(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table/column, run migrations 027–033.`)
      );
      return;
    }
    const ref = { spaces, products, labour };
    container.textContent = "";
    container.appendChild(wallPanelEditor(ref, null, () => renderWallPanels(container)));
    container.appendChild(wallPanelsList(panels, () => renderWallPanels(container)));
  }

  const PANEL_TYPES = ["Direct", "Base", "Framed"];

  // The add / edit form for one wall panel. `existing` = { unit } to edit.
  function wallPanelEditor(ref, existing, onSaved) {
    const u = existing?.unit || {};
    const block = el("details", "admin-package tk-add");
    block.open = !existing;
    block.appendChild(el("summary", null, existing ? `Edit panel — ${u.panel_type || ""} ${u.length_mm || ""}×${u.width_mm || ""}` : "Add a wall panel"));

    let panelId = u.id || null;

    // Reference sets from the products database.
    const plywood = ref.products.filter((p) => normCat(p.category) === "plywood");
    const lamPanel = ref.products.filter((p) => ["laminate", "panel"].includes(normCat(p.category)));
    const plyBrands = distinctVals(plywood.map((p) => p.brand)).sort();
    const plySubsForBrand = (b) => distinctVals(plywood.filter((p) => p.brand === b).map((p) => p.sub_category)).sort();
    const lamBrands = distinctVals(lamPanel.map((p) => p.brand)).sort();
    const lamsForBrand = (b) => lamPanel.filter((p) => p.brand === b).map((p) => [p.id, p.product_name || "unnamed"]);

    // Inputs
    const spaceS = selectEl(ref.spaces, u.space || "", ref.spaces.length ? "Select area…" : "No spaces — set them up first");
    const panelTypeS = selectEl(PANEL_TYPES, u.panel_type || "", "Panel type…");
    const lengthI = document.createElement("input");
    lengthI.type = "number"; lengthI.min = "0"; lengthI.placeholder = "Length (mm)";
    if (u.length_mm != null) lengthI.value = u.length_mm;
    const widthI = document.createElement("input");
    widthI.type = "number"; widthI.min = "0"; widthI.placeholder = "Width (mm)";
    if (u.width_mm != null) widthI.value = u.width_mm;

    const plyBrandS = selectEl(plyBrands, u.plywood_brand || "", "Plywood brand…");
    const plySubS = selectEl(plySubsForBrand(u.plywood_brand || ""), u.plywood_sub_category || "", "Plywood type…");
    const lamBrandS = selectEl(lamBrands, u.laminate_brand || "", "Laminate brand…");
    const lamS = selectEl(lamsForBrand(u.laminate_brand || ""), u.laminate_id || "", "Laminate / panel…");

    const grid = el("div", "admin-inline");
    grid.append(field("Space", spaceS), field("Panel type", panelTypeS), field("Length (mm)", lengthI), field("Width (mm)", widthI));
    const selRow = el("div", "admin-inline tk-sel-grid");
    selRow.append(field("Plywood brand", plyBrandS), field("Plywood type", plySubS), field("Laminate brand", lamBrandS), field("Laminate / panel", lamS));

    const sectionsWrap = el("div", "tk-box-sections");
    const totalsWrap = el("div");
    const msg = el("p", "admin-hint", "");

    // Plywood inputs are irrelevant for Direct.
    const syncPlyEnabled = () => {
      const off = (panelTypeS.value || "").toLowerCase() === "direct";
      plyBrandS.disabled = off; plySubS.disabled = off;
      plyBrandS.title = off ? "Not needed for a Direct panel" : "";
    };
    syncPlyEnabled();

    // Special additions + Labour state (shared components; same model as Box).
    const special = (Array.isArray(u.special_additions) ? u.special_additions : []).map((s) => ({ name: s.name || "", cost: s.cost ?? "" }));
    const labour = (Array.isArray(u.labour_lines) ? u.labour_lines : []).map((l) => ({
      labour_id: l.labour_id || "", category: l.category || "", name: l.name || "",
      task: l.task || "", total_days: l.total_days ?? "",
      sqft_categories: Array.isArray(l.sqft_categories) ? [...l.sqft_categories] : [],
      total_sqft: l.total_sqft ?? "",
    }));
    const labourRows = ref.labour || [];
    const labourById = new Map(labourRows.map((r) => [r.id, r]));
    const labourCategories = distinctVals(labourRows.map((r) => r.category)).sort();
    const namesForCat = (cat) => distinctVals(labourRows.filter((r) => r.category === cat).map((r) => r.name)).sort();
    const tasksForCatName = (cat, name) => labourRows.filter((r) => r.category === cat && r.name === name).map((r) => [r.id, r.task || "(no task)"]);
    let catSqftList = (existing && u.computed && Array.isArray(u.computed.category_sqft)) ? u.computed.category_sqft : [];
    const rowSqft = (row) => {
      const cats = Array.isArray(row.sqft_categories) ? row.sqft_categories : [];
      if (cats.length) {
        const m = new Map(catSqftList.map((r) => [r.category, Number(r.sqft) || 0]));
        return cats.reduce((s, c) => s + (m.get(c) || 0), 0);
      }
      return Number(row.total_sqft) || 0;
    };
    const labourCost = (row) => {
      const lr = row.labour_id ? labourById.get(row.labour_id) : null;
      if (!lr) return 0;
      return (Number(row.total_days) || 0) * (Number(lr.cost_per_day) || 0) + rowSqft(row) * (Number(lr.cost_per_sqft) || 0);
    };

    const inputs = (save) => ({
      save,
      unit_id: panelId,
      project_id: currentProject,
      space: spaceS.value || null,
      panel_type: panelTypeS.value || null,
      plywood_brand: plyBrandS.value || null,
      plywood_sub_category: plySubS.value || null,
      laminate_brand: lamBrandS.value || null,
      laminate_id: lamS.value || null,
      length_mm: Number(lengthI.value) || null,
      width_mm: Number(widthI.value) || null,
      special_additions: special
        .map((s) => ({ name: (s.name || "").trim(), cost: Number(s.cost) || 0 }))
        .filter((s) => s.name || s.cost),
      labour_lines: labour
        .map((l) => ({
          labour_id: l.labour_id || null,
          total_days: Number(l.total_days) || 0,
          sqft_categories: Array.isArray(l.sqft_categories) ? l.sqft_categories : [],
          total_sqft: Number(l.total_sqft) || 0,
        }))
        .filter((l) => l.labour_id || l.total_days || l.sqft_categories.length || l.total_sqft),
    });

    const specialSection = buildSpecialSection(special, () => recompute());
    const catSqftBox = el("div", "tk-cat-sqft");
    const labourUI = buildLabourSection(
      {
        labour, labourCategories, namesForCat, tasksForCatName, labourCost, rowSqft,
        hasLabour: labourRows.length > 0, catSqftBox, getCatSqft: () => catSqftList,
      },
      () => recompute()
    );

    const coreReady = () => panelTypeS.value && Number(lengthI.value) > 0 && Number(widthI.value) > 0 && lamS.value;

    async function compute(save) {
      if (save && !coreReady()) return void (msg.textContent = "Pick a panel type, a laminate/panel and enter the length & width first.");
      msg.textContent = save ? "Saving…" : "Computing…";
      try {
        const res = await computeWallPanel(inputs(save));
        if (save) panelId = res.unit_id;
        catSqftList = (res.computed && res.computed.category_sqft) || [];
        renderWallSections(sectionsWrap, res.computed);
        renderTotals(totalsWrap, res.computed);
        renderCatSqft(catSqftBox, res.computed);
        labourUI.refresh();
        msg.textContent = "";
        if (save) {
          message(`Saved wall panel — ${money(res.computed.totals.with_gst)} (with GST).`);
          onSaved();
        }
      } catch (error) {
        msg.textContent = `${save ? "Save" : "Compute"} failed: ${error.message}`;
      }
    }
    // Auto-recompute once the core inputs are complete (keeps totals live).
    const recompute = () => { if (coreReady()) compute(false); };

    plyBrandS.addEventListener("change", () => { replaceOptions(plySubS, plySubsForBrand(plyBrandS.value), "", "Plywood type…"); recompute(); });
    lamBrandS.addEventListener("change", () => { replaceOptions(lamS, lamsForBrand(lamBrandS.value), "", "Laminate / panel…"); recompute(); });
    panelTypeS.addEventListener("change", () => { syncPlyEnabled(); recompute(); });
    [plySubS, lamS].forEach((s) => s.addEventListener("change", recompute));
    [spaceS, lengthI, widthI].forEach((c) => c.addEventListener("change", recompute));

    const computeBtn = el("button", "admin-primary-small", "Compute");
    computeBtn.type = "button";
    computeBtn.addEventListener("click", () => compute(false));
    const saveBtn = el("button", "admin-primary", existing ? "Save changes" : "Save panel");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", () => compute(true));

    const actions = el("div", "admin-row-actions");
    actions.append(computeBtn, saveBtn);
    const extrasWrap = el("div", "tk-box-sections");
    extrasWrap.append(specialSection, labourUI.node);
    block.append(grid, selRow, sectionsWrap, extrasWrap, totalsWrap, actions, msg);

    renderCatSqft(catSqftBox, null);
    renderTotals(totalsWrap, null);
    if (existing && coreReady()) compute(false);
    else renderWallSections(sectionsWrap, null);
    return block;
  }

  // The Materials breakdown for a wall panel (plywood + laminate/panel).
  function renderWallSections(container, computed) {
    container.textContent = "";
    if (!computed) {
      container.appendChild(el("p", "dash-note", "Pick a panel type, a laminate/panel and enter the length & width, then Compute."));
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

    const s1 = el("div", "tk-box-section");
    s1.appendChild(el("div", "tk-box-section-head", `Materials — ${computed.panel_type || "panel"}`));

    const ply = computed.plywood;
    if (ply && ply.applies) {
      s1.appendChild(el("p", "tk-box-line", `Plywood (${ply.thickness} mm)`));
      s1.appendChild(miniTable(["Board", "Cover (sqft)", "Qty", "Total"], [[
        ply.missing ? "⚠ no board found" : (ply.name || "—"), ply.cover_sqft ?? "—", ply.qty ?? "—", money(ply.price),
      ]]));
      if (computed.dimensions && computed.dimensions.frame_sqft > 0) {
        s1.appendChild(el("p", "tk-box-line", `(includes ${computed.dimensions.frame_sqft} sqft of frame strips)`));
      }
    }
    const lam = computed.laminate;
    s1.appendChild(el("p", "tk-box-line", "Laminate / panel"));
    s1.appendChild(miniTable(["Laminate / panel", "Cover (sqft)", "Qty", "Total"], [[
      lam.missing ? "⚠ not found" : (lam.name || "—"), lam.cover_sqft ?? "—", lam.qty ?? "—", money(lam.price),
    ]]));
    s1.appendChild(el("p", "tk-box-total", `Material total: ${money(computed.totals.material)}`));
    container.appendChild(s1);
  }

  function wallPanelsList(panels, onChanged) {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el("p", "dash-note", "Saved wall panels. Open to edit, or delete."));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Space", "Panel", "Material specifications", "Design specifications", "Total", "With margin", "Margin", "With discount", "With GST", ""].forEach(
      (h) => hr.appendChild(el("th", null, h))
    );
    thead.appendChild(hr);
    const tbody = el("tbody");
    if (!panels.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No wall panels yet.");
      td.colSpan = 10;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    panels.forEach((p) => {
      const open = el("button", "tk-email-link", "Open");
      open.type = "button";
      open.addEventListener("click", async () => {
        try {
          const existing = await loadWallPanel(p.id);
          const ref = { spaces: await loadSelectedSpaces(currentProject), products: await loadProducts(), labour: await loadLabour() };
          panel.textContent = "";
          panel.appendChild(wallPanelEditor(ref, existing, () => renderWallPanels(panel)));
          panel.appendChild(wallPanelsList(await loadWallPanels(currentProject), () => renderWallPanels(panel)));
        } catch (error) {
          message(`Could not open: ${error.message}`, true);
        }
      });
      const del = el("button", "tk-delete-link", "Delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete this ${p.panel_type || ""} wall panel? This cannot be undone.`)) return;
        const { error } = await sb.from("turnkey_quote_wall_panels").delete().eq("id", p.id);
        if (error) return void message(`Could not delete: ${error.message}`, true);
        try { await computeWallPanel({ recompute_boq: true, project_id: currentProject }); } catch (_e) { /* BOQ rebuild best-effort */ }
        message("Wall panel deleted.");
        onChanged();
      });
      const actions = el("div", "tk-cell-actions");
      actions.append(open, del);

      const dims = p.length_mm && p.width_mm ? `${p.length_mm}×${p.width_mm} mm` : "";
      const cells = [
        p.space || "—", `${p.panel_type || "—"}${dims ? " · " + dims : ""}`, p.material_spec || "—", p.design_spec || "—",
        money(p.total_price), money(p.margin_price), money(p.margin_amount), money(p.discount_price), money(p.gst_price), actions,
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
