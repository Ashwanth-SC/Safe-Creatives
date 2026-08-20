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
    if (currentProject && currentTab === "furniture") {
      renderManualSegment(panel, FURNITURE_SEG);
      return;
    }
    if (currentProject && currentTab === "accessories") {
      renderManualSegment(panel, ACCESSORIES_SEG);
      return;
    }
    if (currentProject && currentTab === "paint") {
      renderManualSegment(panel, PAINT_SEG);
      return;
    }
    if (currentProject && currentTab === "civil") {
      renderCompositeSegment(panel, CIVIL_SEG);
      return;
    }
    if (currentProject && currentTab === "electrical") {
      renderCompositeSegment(panel, ELECTRICAL_SEG);
      return;
    }
    if (currentProject && currentTab === "export") {
      renderExport(panel);
      return;
    }
    if (currentProject && currentTab === "vendor-boq") {
      renderVendorBoq(panel);
      return;
    }
    if (currentProject && currentTab === "labour-boq") {
      renderLabourBoq(panel);
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
      .select("id, product_name, supplier, category, size, price");
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
      .select("id, space, panel_type, length_ft, height_ft, material_spec, design_spec, total_price, margin_price, margin_amount, discount_price, gst_price, created_at")
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
  async function loadFurniture(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_furniture")
      .select("id, space, supplier, unit_name, material_spec, design_spec, quantity, unit_price, total_price, margin_price, margin_amount, discount_price, gst_price, sort_order")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function loadAccessories(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_accessories")
      .select("id, supplier, accessory_id, unit_name, specification, quantity, margin_percent, unit_price, total_price, margin_price, margin_amount, discount_price, gst_price, sort_order")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function loadSuppliers() {
    const { data, error } = await sb
      .from("turnkey_suppliers")
      .select("supplier_company_name")
      .order("supplier_company_name", { ascending: true });
    if (error) throw error;
    return [...new Set((data || []).map((s) => s.supplier_company_name).filter(Boolean))];
  }
  async function loadPaint(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_paint")
      .select("id, supplier, product_id, description, sqft, unit_price, total_price, margin_price, margin_amount, discount_price, gst_price, sort_order")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }
  // Products with supplier + rate, for the product-dropdown segment columns (Paint).
  async function loadCatalogProducts() {
    const { data, error } = await sb
      .from("turnkey_products")
      .select("id, product_name, supplier, category, price_per_sqft");
    if (error) throw error;
    return data || [];
  }
  // The accessories catalogue (turnkey_accessories) for the Accessories segment.
  async function loadAccessoriesCatalog() {
    const { data, error } = await sb
      .from("turnkey_accessories")
      .select("id, supplier, product_name, product_category, price_per_piece")
      .order("product_name", { ascending: true });
    if (error) throw error;
    return data || [];
  }
  async function loadSellerSettings() {
    const { data, error } = await sb
      .from("seller_settings")
      .select("legal_name, trade_name, gstin, pan, address_line, city, state_name, state_code, pin_code, email, phone")
      .maybeSingle();
    if (error) throw error;
    return data || {};
  }
  async function loadProjectFull(id) {
    const { data, error } = await sb
      .from("turnkey_projects")
      .select("project_number, client_name, client_phone, client_email, project_name, site_address")
      .eq("id", id)
      .single();
    if (error) throw error;
    return data;
  }
  async function loadProjectBoq(projectId) {
    const { data, error } = await sb
      .from("turnkey_project_boq")
      .select("product_name, category, quantity, supplier, unit_price")
      .eq("project_id", projectId);
    if (error) throw error;
    return data || [];
  }
  async function loadCompositeUnits(table, projectId) {
    const { data, error } = await sb.from(table).select("*").eq("project_id", projectId).order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  // Every labour line across the segments that carry labour, for the Labour BOQ.
  async function loadAllLabourLines(projectId) {
    const tables = ["turnkey_quote_box_units", "turnkey_quote_wall_panels", "turnkey_quote_civil", "turnkey_quote_electrical"];
    const out = [];
    for (const table of tables) {
      const { data, error } = await sb.from(table).select("labour_lines").eq("project_id", projectId);
      if (error) continue; // resilient to a table not existing yet
      (data || []).forEach((u) => (u.labour_lines || []).forEach((l) => out.push(l)));
    }
    return out;
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

    // Reference sets derived from the databases.
    const plywood = ref.products.filter((p) => normCat(p.category) === "plywood");
    const laminate = ref.products.filter((p) => normCat(p.category) === "laminate");
    const materialBrands = distinctVals(plywood.map((p) => p.brand)).sort();
    const subsForBrand = (brand) => distinctVals(plywood.filter((p) => p.brand === brand).map((p) => p.sub_category)).sort();
    const lamOptions = laminate.map((p) => [p.id, p.product_name || "unnamed"]);
    const handleOptions = (ref.hardware || []).filter((h) => normCat(h.category) === "handle").map((h) => [h.id, h.product_name || "unnamed"]);

    // Main inputs
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

    // Main: plywood brand/type + one common inner laminate (outer laminate is
    // chosen per panel below; hinges/minifix/legs/channels are automatic).
    const matBrandS = selectEl(materialBrands, u.material_brand || "", "Plywood brand…");
    const subS = selectEl(subsForBrand(u.material_brand || ""), u.material_sub_category || "", "Plywood type…");
    const innerS = selectEl(lamOptions, u.inner_laminate_id || "", "Inner laminate…");
    matBrandS.addEventListener("change", () => { replaceOptions(subS, subsForBrand(matBrandS.value), "", "Plywood type…"); compute(false); });
    [subS, innerS].forEach((s) => s.addEventListener("change", () => compute(false)));

    const grid = el("div", "admin-inline");
    grid.append(field("Space", spaceS), field("Unit name", nameI), field("Plywood brand", matBrandS), field("Plywood type", subS), field("Inner laminate", innerS), field("Cutlist", importBtn));
    grid.appendChild(fileInput);

    // Per-panel selections (keyed by panel index), filled in the Outer laminate
    // and Handles sections that render after a compute.
    const outerLamSel = (u.outer_laminate_ids && typeof u.outer_laminate_ids === "object") ? { ...u.outer_laminate_ids } : {};
    const handleSel = (u.handle_ids && typeof u.handle_ids === "object") ? { ...u.handle_ids } : {};

    // Special additions (hardware product + qty) and Labour.
    const special = (Array.isArray(u.special_additions) ? u.special_additions : []).map((s) => ({ hardware_id: s.hardware_id || "", product_name: s.product_name || "", quantity: s.quantity ?? "" }));
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

    const sectionsWrap = el("div", "tk-box-sections");
    const materialsWrap = el("div", "tk-box-sections");
    const totalsWrap = el("div");
    const msg = el("p", "admin-hint", "");

    // Passed to renderSections so the Outer laminate + Handles sections can offer
    // a dropdown per applicable panel; changing one recomputes the unit.
    const ctx = {
      lamOptions,
      handleOptions,
      outerLamSel,
      handleSel,
      onOuterChange: (idx, id) => { if (id) outerLamSel[idx] = id; else delete outerLamSel[idx]; compute(false); },
      onHandleChange: (idx, id) => { if (id) handleSel[idx] = id; else delete handleSel[idx]; compute(false); },
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
      inner_laminate_id: innerS.value || null,
      outer_laminate_ids: outerLamSel,
      handle_ids: handleSel,
      special_additions: special
        .map((s) => ({ hardware_id: s.hardware_id || null, quantity: Number(s.quantity) || 0, product_name: s.product_name || null }))
        .filter((s) => s.hardware_id || s.quantity),
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
    const specialSection = buildSpecialProductSection(special, ref.hardware, () => compute(false));

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
        materialsWrap.textContent = "";
        materialsWrap.appendChild(renderMaterialsTable(res.computed));
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
    // Order: Main → Outer laminate + Handles → Special additions → Materials → Labour → totals.
    block.append(grid, sectionsWrap, specialSection, materialsWrap, labourUI.node, totalsWrap, actions, msg);

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

  // Special additions as a hardware Product (any category) + Quantity table.
  // Mutates `special` = [{ hardware_id, product_name, quantity }]; price = qty ×
  // the hardware's price. Used by Wall Panels / Civil / Electrical / Box.
  function buildSpecialProductSection(special, hardware, onChange) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Special additions"));
    wrap.appendChild(el("p", "dash-note", "Pick any hardware product and a quantity — price = Quantity × the product's price. The names are appended to the design spec and the cost adds into the total."));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Product", "Quantity", "Price", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    t.append(thead, tbody);
    scroll.appendChild(t);

    const hwOptions = (hardware || []).map((h) => [h.id, `${h.product_name || "unnamed"}${h.category ? " · " + h.category : ""}`]);
    const hwById = new Map((hardware || []).map((h) => [h.id, h]));
    const rowCost = (r) => { const hw = r.hardware_id ? hwById.get(r.hardware_id) : null; return (Number(r.quantity) || 0) * (hw ? Number(hw.price) || 0 : 0); };
    const subtotal = el("p", "tk-box-total", "");
    const refreshSubtotal = () => { subtotal.textContent = `Special additions total: ${money(special.reduce((s, r) => s + rowCost(r), 0))}`; };

    function addRowDom(row) {
      const tr = el("tr");
      const cell = (c) => { const td = el("td"); td.appendChild(c); return td; };
      const opts = row.hardware_id && !hwById.has(row.hardware_id) && row.product_name ? [[row.hardware_id, row.product_name], ...hwOptions] : hwOptions;
      const prodSel = selectEl(opts, row.hardware_id || "", hwOptions.length ? "Product…" : "No hardware");
      prodSel.className = "grid-input grid-select";
      const qtyI = document.createElement("input"); qtyI.type = "number"; qtyI.min = "0"; qtyI.className = "grid-input"; qtyI.placeholder = "0";
      qtyI.value = (row.quantity === "" || row.quantity == null) ? "" : row.quantity;
      const priceCell = el("td");
      const update = () => { priceCell.textContent = money(rowCost(row)); refreshSubtotal(); onChange(); };
      prodSel.addEventListener("change", () => { row.hardware_id = prodSel.value; const hw = hwById.get(prodSel.value); row.product_name = hw ? (hw.product_name || "") : ""; update(); });
      qtyI.addEventListener("input", () => { row.quantity = qtyI.value; update(); });
      const delTd = el("td", "db-grid-del");
      const del = el("button", "tk-delete-link", "✕"); del.type = "button"; del.title = "Remove";
      del.addEventListener("click", () => { const i = special.indexOf(row); if (i >= 0) special.splice(i, 1); tr.remove(); refreshSubtotal(); onChange(); });
      delTd.appendChild(del);
      tr.append(cell(prodSel), cell(qtyI), priceCell, delTd);
      priceCell.textContent = money(rowCost(row));
      tbody.appendChild(tr);
      return prodSel;
    }
    special.forEach(addRowDom);

    const addBtn = el("button", "admin-primary-small", "+ Add addition");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => { const row = { hardware_id: "", product_name: "", quantity: "" }; special.push(row); addRowDom(row).focus(); });

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
    const { labour, labourCategories, namesForCat, tasksForCatName, labourCost, rowSqft, hasLabour, catSqftBox, getCatSqft, showCatSqft = true, manualSqft = false } = cfg;
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Labour"));
    if (!hasLabour) {
      wrap.appendChild(el("p", "dash-note", "No labour in the database yet — add labourers (with their task and rates) in the Turnkey database first."));
      if (showCatSqft) wrap.appendChild(catSqftBox);
      return { node: wrap, refresh: () => {} };
    }
    wrap.appendChild(el("p", "dash-note", manualSqft
      ? "Pick a labourer by category → name → task, then enter the days and total sqft. Cost = days × cost/day + sqft × cost/sqft; it adds into the total (margin, discount & GST apply)."
      : "Pick a labourer by category → name → task, enter the days, then tick the material categories this task covers — their sqft is summed automatically. Cost = days × cost/day + sqft × cost/sqft; it adds into the total (margin, discount & GST apply)."));

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Labour category", "Name", "Task", "Total days", manualSqft ? "Total sqft" : "Total sqft (pick categories)", "Cost", ""].forEach((h) => hr.appendChild(el("th", null, h)));
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
      let sqftControl, sqftRefresh = () => {};
      if (manualSqft) {
        const sqftI = document.createElement("input");
        sqftI.type = "number"; sqftI.min = "0"; sqftI.className = "grid-input"; sqftI.placeholder = "0";
        sqftI.value = row.total_sqft === "" || row.total_sqft == null ? "" : row.total_sqft;
        sqftI.addEventListener("input", () => { row.total_sqft = sqftI.value; updateCost(); });
        sqftI.addEventListener("change", onChange);
        sqftControl = sqftI;
      } else {
        const sqftPick = buildSqftPicker(row, getCatSqft, () => rowSqft(row), () => { updateCost(); onChange(); });
        sqftControl = sqftPick.node; sqftRefresh = sqftPick.refresh;
      }

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
      const refresher = () => { sqftRefresh(); updateCost(); };
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

      tr.append(cell(catSel), cell(nameSel), cell(taskSel), cell(daysI), cell(sqftControl), costCell, delTd);
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

    wrap.append(scroll, addBtn, subtotal);
    if (showCatSqft) wrap.appendChild(catSqftBox);
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

  // Renders the per-panel Outer laminate + Handles sections. `ctx` makes them
  // interactive (a laminate / handle dropdown per applicable panel).
  function renderSections(container, computed, ctx) {
    container.textContent = "";
    if (!computed) {
      container.appendChild(el("p", "dash-note", "Import a cutlist and pick the plywood + inner laminate, then Compute."));
      return;
    }
    const perPanel = (title, note, panels, options, sel, onChange) => {
      const s = el("div", "tk-box-section");
      s.appendChild(el("div", "tk-box-section-head", title));
      s.appendChild(el("p", "dash-note", note));
      if (!panels.length) { s.appendChild(el("p", "dash-note", "No applicable panels.")); return s; }
      const scroll = el("div", "table-scroll");
      const t = el("table", "dash-table");
      const hr = el("tr"); ["Panel", "Category", title.split(" ")[0]].forEach((h) => hr.appendChild(el("th", null, h))); t.appendChild(hr);
      panels.forEach((p) => {
        const tr = el("tr");
        const c1 = el("td"); c1.textContent = p.name || "—"; tr.appendChild(c1);
        const c2 = el("td"); c2.textContent = p.category || "—"; tr.appendChild(c2);
        const c3 = el("td");
        const dd = selectEl(options, sel[p.index] || "", "Select…");
        dd.className = "grid-input grid-select";
        dd.addEventListener("change", () => onChange(p.index, dd.value));
        c3.appendChild(dd); tr.appendChild(c3);
        t.appendChild(tr);
      });
      scroll.appendChild(t); s.appendChild(scroll);
      return s;
    };
    container.appendChild(perPanel("Outer laminate", "Choose the outer laminate for each applicable panel.", computed.outer_panels || [], ctx.lamOptions, ctx.outerLamSel, ctx.onOuterChange));
    container.appendChild(perPanel("Handles", "Choose the handle for each applicable panel.", computed.handle_panels || [], ctx.handleOptions, ctx.handleSel, ctx.onHandleChange));
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
    let spaces, products, hardware, labour, panels;
    try {
      [spaces, products, hardware, labour, panels] = await Promise.all([
        loadSelectedSpaces(currentProject),
        loadProducts(),
        loadHardware(),
        loadLabour(),
        loadWallPanels(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table/column, run migrations 027–039.`)
      );
      return;
    }
    const ref = { spaces, products, hardware, labour };
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
    block.appendChild(el("summary", null, existing ? `Edit panel — ${u.panel_type || ""} ${u.length_ft || ""}×${u.height_ft || ""} ft` : "Add a wall panel"));

    let panelId = u.id || null;

    // Reference sets from the products database.
    const plywood = ref.products.filter((p) => normCat(p.category) === "plywood");
    const lamPanel = ref.products.filter((p) => ["laminate", "panel"].includes(normCat(p.category)));
    const plyBrands = distinctVals(plywood.map((p) => p.brand)).sort();
    const plySubsForBrand = (b) => distinctVals(plywood.filter((p) => p.brand === b).map((p) => p.sub_category)).sort();
    const lamOptions = lamPanel.map((p) => [p.id, p.product_name || "unnamed"]);

    // Inputs
    const spaceS = selectEl(ref.spaces, u.space || "", ref.spaces.length ? "Select area…" : "No spaces — set them up first");
    const panelTypeS = selectEl(PANEL_TYPES, u.panel_type || "", "Panel type…");
    const lengthI = document.createElement("input");
    lengthI.type = "number"; lengthI.min = "0"; lengthI.step = "0.01"; lengthI.placeholder = "Length (ft)";
    if (u.length_ft != null) lengthI.value = u.length_ft;
    const heightI = document.createElement("input");
    heightI.type = "number"; heightI.min = "0"; heightI.step = "0.01"; heightI.placeholder = "Height (ft)";
    if (u.height_ft != null) heightI.value = u.height_ft;

    const plyBrandS = selectEl(plyBrands, u.plywood_brand || "", "Plywood brand…");
    const plySubS = selectEl(plySubsForBrand(u.plywood_brand || ""), u.plywood_sub_category || "", "Plywood type…");
    const lamS = selectEl(lamOptions, u.laminate_id || "", "Laminate / panel…");

    const grid = el("div", "admin-inline");
    grid.append(field("Space", spaceS), field("Panel type", panelTypeS), field("Length (ft)", lengthI), field("Height (ft)", heightI));
    const selRow = el("div", "admin-inline tk-sel-grid");
    selRow.append(field("Plywood brand", plyBrandS), field("Plywood type", plySubS), field("Laminate / panel", lamS));

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

    // Special additions (hardware product + qty) + Labour state.
    const special = (Array.isArray(u.special_additions) ? u.special_additions : []).map((s) => ({ hardware_id: s.hardware_id || "", product_name: s.product_name || "", quantity: s.quantity ?? "" }));
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
      laminate_id: lamS.value || null,
      length_ft: Number(lengthI.value) || null,
      height_ft: Number(heightI.value) || null,
      special_additions: special
        .map((s) => ({ hardware_id: s.hardware_id || null, quantity: Number(s.quantity) || 0, product_name: s.product_name || null }))
        .filter((s) => s.hardware_id || s.quantity),
      labour_lines: labour
        .map((l) => ({
          labour_id: l.labour_id || null,
          total_days: Number(l.total_days) || 0,
          sqft_categories: Array.isArray(l.sqft_categories) ? l.sqft_categories : [],
          total_sqft: Number(l.total_sqft) || 0,
        }))
        .filter((l) => l.labour_id || l.total_days || l.sqft_categories.length || l.total_sqft),
    });

    const specialSection = buildSpecialProductSection(special, ref.hardware, () => recompute());
    // Wall panels don't show the per-category sqft reference table (there's no
    // cutlist); the labour sqft picker still uses the panel's own areas.
    const labourUI = buildLabourSection(
      {
        labour, labourCategories, namesForCat, tasksForCatName, labourCost, rowSqft,
        hasLabour: labourRows.length > 0, getCatSqft: () => catSqftList, showCatSqft: false,
      },
      () => recompute()
    );

    const coreReady = () => panelTypeS.value && Number(lengthI.value) > 0 && Number(heightI.value) > 0 && lamS.value;

    async function compute(save) {
      if (save && !coreReady()) return void (msg.textContent = "Pick a panel type, a laminate/panel and enter the length & height first.");
      msg.textContent = save ? "Saving…" : "Computing…";
      try {
        const res = await computeWallPanel(inputs(save));
        if (save) panelId = res.unit_id;
        catSqftList = (res.computed && res.computed.category_sqft) || [];
        renderWallSections(sectionsWrap, res.computed);
        renderTotals(totalsWrap, res.computed);
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
    panelTypeS.addEventListener("change", () => { syncPlyEnabled(); recompute(); });
    [plySubS, lamS].forEach((s) => s.addEventListener("change", recompute));
    [spaceS, lengthI, heightI].forEach((c) => c.addEventListener("change", recompute));

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

    renderTotals(totalsWrap, null);
    if (existing && coreReady()) compute(false);
    else renderWallSections(sectionsWrap, null);
    return block;
  }

  // The Materials breakdown for a wall panel (computed supplier/category/product).
  function renderWallSections(container, computed) {
    container.textContent = "";
    if (!computed) {
      container.appendChild(el("p", "dash-note", "Pick a panel type, a laminate/panel and enter the length & height, then Compute."));
      return;
    }
    container.appendChild(renderMaterialsTable(computed));
    if (computed.dimensions && computed.dimensions.frame_sqft > 0) {
      container.appendChild(el("p", "tk-box-line", `Framed: 12 mm face ${computed.dimensions.face_sqft} sqft + 16 mm frame ${computed.dimensions.frame_sqft} sqft.`));
    }
  }

  // A read-only Materials breakdown table (supplier / category / product / qty /
  // price) built from the computed.materials the backend returns. Shared by Wall
  // Panels and Box & Shutters; it's what feeds the vendor BOQ.
  function renderMaterialsTable(computed) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Materials"));
    const rows = (computed && computed.materials) || [];
    if (!rows.length) { wrap.appendChild(el("p", "dash-note", "No materials computed yet.")); return wrap; }
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Supplier", "Category", "Product", "Quantity", "Price"].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tb = el("tbody");
    rows.forEach((r) => {
      const tr = el("tr");
      [r.supplier || "—", r.category || "—", r.product || "—", r.quantity, money(r.price)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    const trT = el("tr", "tk-cat-sqft-total");
    const span = el("td"); span.colSpan = 4; span.textContent = "Material total";
    const totTd = el("td"); totTd.textContent = money((computed.totals && computed.totals.material) || 0);
    trT.append(span, totTd);
    tb.appendChild(trT);
    t.append(thead, tb);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    return wrap;
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
          const ref = { spaces: await loadSelectedSpaces(currentProject), products: await loadProducts(), hardware: await loadHardware(), labour: await loadLabour() };
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

      const dims = p.length_ft && p.height_ft ? `${p.length_ft}×${p.height_ft} ft` : "";
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

  // ------------------------------------------------------------------
  // Manual line-entry segments (Furniture, Accessories) — no material
  // computation. An editable table with per-row margin/discount/GST columns
  // and the totals cards below; rows persist straight to the segment's table.
  // ------------------------------------------------------------------
  const FURNITURE_SEG = {
    table: "turnkey_quote_furniture", load: loadFurniture, migration: "034",
    title: "Furniture", addLabel: "+ Add furniture", saveLabel: "Save furniture",
    note: "Enter each item — no material computation, the line total is Quantity × Price. Supplier, Unit, Quantity, specs and price are stored for the vendor BOQ; the totals below carry the project margin, discount & GST.",
    cols: [
      { key: "space", label: "Space", kind: "space" },
      { key: "supplier", label: "Supplier", kind: "supplier" },
      { key: "unit_name", label: "Unit", kind: "text", ph: "Unit" },
      { key: "material_spec", label: "Material specification", kind: "text", ph: "Material spec" },
      { key: "design_spec", label: "Design specification", kind: "text", ph: "Design spec" },
      { key: "quantity", label: "Quantity", kind: "number" },
      { key: "unit_price", label: "Price", kind: "number" },
    ],
  };
  const ACCESSORIES_SEG = {
    table: "turnkey_quote_accessories", load: loadAccessories, migration: "041",
    title: "Accessories", addLabel: "+ Add accessory", saveLabel: "Save accessories",
    supplierFrom: "accessories", marginKey: "margin_percent",
    note: "Pick a supplier, then an accessory from the accessories database (Database → Accessories) and a quantity. Set a Margin % per line — accessories override the project margin; discount & GST use the project rates. Supplier/product/qty/price feed the vendor BOQ.",
    cols: [
      { key: "supplier", label: "Supplier", kind: "supplier" },
      { key: "accessory_id", label: "Product", kind: "product", source: "accessories", filterBy: "supplier", nameKey: "unit_name", priceField: "price_per_piece" },
      { key: "specification", label: "Specification", kind: "text", ph: "Specification" },
      { key: "quantity", label: "Quantity", kind: "number" },
      { key: "margin_percent", label: "Margin (%)", kind: "number" },
      { key: "unit_price", label: "Price", kind: "readonly" },
    ],
  };

  const PAINT_SEG = {
    table: "turnkey_quote_paint", load: loadPaint, migration: "036",
    title: "Paint work", addLabel: "+ Add paint work", saveLabel: "Save paint work",
    totalLabel: "Price", qtyKey: "sqft",
    note: "Pick a supplier, then a paint from the products database; enter the total applicable sqft. Price = Sqft × the product's per-sqft cost. The totals below carry the project margin, discount & GST.",
    cols: [
      { key: "supplier", label: "Supplier", kind: "supplier" },
      { key: "product_id", label: "Description", kind: "product", category: "paint", filterBy: "supplier", nameKey: "description" },
      { key: "sqft", label: "Sqft", kind: "number" },
    ],
  };

  const round2q = (n) => Math.round(n * 100) / 100;

  async function renderManualSegment(container, seg) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    const needSpaces = seg.cols.some((c) => c.kind === "space");
    const needSuppliers = seg.cols.some((c) => c.kind === "supplier");
    const needCatalog = seg.cols.some((c) => c.kind === "product" && c.source !== "accessories");
    const needAccessories = seg.cols.some((c) => c.kind === "product" && c.source === "accessories") || seg.supplierFrom === "accessories";
    let spaces = [], suppliers = [], products = [], accessories = [], saved = [];
    try {
      [spaces, suppliers, products, accessories, saved] = await Promise.all([
        needSpaces ? loadSelectedSpaces(currentProject) : Promise.resolve([]),
        needSuppliers ? loadSuppliers() : Promise.resolve([]),
        needCatalog ? loadCatalogProducts() : Promise.resolve([]),
        needAccessories ? loadAccessoriesCatalog() : Promise.resolve([]),
        seg.load(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table/column, run migration ${seg.migration}.`)
      );
      return;
    }
    container.textContent = "";
    if (seg.supplierFrom === "accessories") suppliers = distinctVals(accessories.map((a) => a.supplier)).sort();

    const proj = projectsById.get(currentProject) || {};
    const m = Number(proj.margin_percent) || 0, d = Number(proj.discount_percent) || 0, g = Number(proj.gst_percent) || 0;
    const qtyKey = seg.qtyKey || "quantity";      // the multiplier column
    const priceKey = seg.priceKey || "unit_price"; // the per-unit rate (a column, or set by a product pick)
    const rateIsColumn = seg.cols.some((c) => c.key === priceKey && c.kind !== "readonly");
    const rowMargin = (r) => (seg.marginKey ? (Number(r[seg.marginKey]) || 0) : m);
    const rowTotals = (r) => {
      const total = round2q((Number(r[qtyKey]) || 0) * (Number(r[priceKey]) || 0));
      const withMargin = round2q(total * (1 + rowMargin(r) / 100));
      const marginAmount = round2q(withMargin - total);
      const withDiscount = round2q(withMargin * (1 - d / 100));
      const withGst = round2q(withDiscount * (1 + g / 100));
      return { total, withMargin, marginAmount, withDiscount, withGst };
    };

    // Editable working set, seeded from the saved rows.
    const rows = saved.map((r) => {
      const o = { id: r.id };
      seg.cols.forEach((c) => { o[c.key] = r[c.key] ?? ""; if (c.kind === "product") o[c.nameKey] = r[c.nameKey] ?? ""; });
      if (!rateIsColumn) o[priceKey] = r[priceKey] ?? "";
      return o;
    });

    const section = el("div", "tk-box-section");
    section.appendChild(el("div", "tk-box-section-head", seg.title));
    section.appendChild(el("p", "dash-note", seg.note));

    const scroll = el("div", "table-scroll");
    const table = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    [...seg.cols.map((c) => c.label), seg.totalLabel || "Total", "With margin", "Margin", "With discount", "With GST", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    table.append(thead, tbody);
    scroll.appendChild(table);

    const totalsWrap = el("div");
    const refreshTotals = () => {
      const sum = { total: 0, with_margin: 0, margin_amount: 0, with_discount: 0, with_gst: 0 };
      rows.forEach((r) => {
        const t = rowTotals(r);
        sum.total += t.total; sum.with_margin += t.withMargin; sum.margin_amount += t.marginAmount;
        sum.with_discount += t.withDiscount; sum.with_gst += t.withGst;
      });
      Object.keys(sum).forEach((k) => (sum[k] = round2q(sum[k])));
      renderTotals(totalsWrap, { totals: sum });
    };

    function addRowDom(row) {
      const tr = el("tr");
      const cell = (c) => { const td = el("td"); td.appendChild(c); return td; };
      const totCell = el("td"), mpCell = el("td"), mCell = el("td"), dCell = el("td"), gCell = el("td");
      const readonlyUpdaters = [];
      const updateLine = () => {
        readonlyUpdaters.forEach((fn) => fn());
        const t = rowTotals(row);
        totCell.textContent = money(t.total); mpCell.textContent = money(t.withMargin);
        mCell.textContent = money(t.marginAmount); dCell.textContent = money(t.withDiscount); gCell.textContent = money(t.withGst);
        refreshTotals();
      };

      let firstControl = null;
      const controlByKey = {};
      seg.cols.forEach((c) => {
        if (c.kind === "readonly") {
          const td = el("td", "db-readonly");
          const set = () => { td.textContent = money(Number(row[c.key]) || 0); };
          set();
          readonlyUpdaters.push(set);
          tr.appendChild(td);
          return;
        }
        let control;
        if (c.kind === "space") {
          control = selectEl(spaces, row[c.key] || "", spaces.length ? "Area…" : "No spaces");
          control.className = "grid-input grid-select";
          control.addEventListener("change", () => { row[c.key] = control.value; });
        } else if (c.kind === "supplier") {
          const opts = row[c.key] && !suppliers.includes(row[c.key]) ? [row[c.key], ...suppliers] : suppliers;
          control = selectEl(opts, row[c.key] || "", suppliers.length ? "Supplier…" : "No suppliers");
          control.className = "grid-input grid-select";
          control.addEventListener("change", () => {
            row[c.key] = control.value;
            // Refresh any product dropdowns filtered by this supplier.
            seg.cols.forEach((cc) => {
              if (cc.kind === "product" && cc.filterBy === c.key && controlByKey[cc.key]) {
                row[cc.key] = ""; row[cc.nameKey] = ""; if (!rateIsColumn) row[priceKey] = "";
                controlByKey[cc.key]._fill();
                updateLine();
              }
            });
          });
        } else if (c.kind === "product") {
          const catalog = c.source === "accessories" ? accessories : products;
          const priceField = c.priceField || "price_per_sqft";
          const matches = (p) => (c.source === "accessories" ? true : normCat(p.category) === normCat(c.category));
          control = document.createElement("select");
          control.className = "grid-input grid-select";
          const fill = () => {
            const sup = c.filterBy ? row[c.filterBy] : null;
            const opts = catalog.filter((p) => matches(p) && (!sup || p.supplier === sup));
            control.textContent = "";
            control.appendChild(new Option(c.filterBy && !sup ? "Pick a supplier first" : "Select…", ""));
            opts.forEach((p) => control.appendChild(new Option(p.product_name || "unnamed", p.id)));
            control.value = row[c.key] || "";
          };
          fill();
          control._fill = fill;
          control.addEventListener("change", () => {
            row[c.key] = control.value;
            const p = catalog.find((x) => String(x.id) === control.value);
            row[c.nameKey] = p ? (p.product_name || "") : "";
            row[priceKey] = p ? (Number(p[priceField]) || 0) : "";
            updateLine();
          });
        } else if (c.kind === "number") {
          control = document.createElement("input");
          control.type = "number"; control.min = "0"; control.className = "grid-input"; control.placeholder = "0";
          control.value = (row[c.key] === "" || row[c.key] == null) ? "" : row[c.key];
          control.addEventListener("input", () => { row[c.key] = control.value; updateLine(); });
        } else {
          control = document.createElement("input");
          control.type = "text"; control.className = "grid-input"; control.placeholder = c.ph || c.label;
          control.value = row[c.key] || "";
          control.addEventListener("input", () => { row[c.key] = control.value; });
        }
        controlByKey[c.key] = control;
        if (!firstControl) firstControl = control;
        tr.appendChild(cell(control));
      });

      tr.append(totCell, mpCell, mCell, dCell, gCell);

      const delTd = el("td", "db-grid-del");
      const del = el("button", "tk-delete-link", "✕");
      del.type = "button"; del.title = "Remove";
      del.addEventListener("click", () => {
        const i = rows.indexOf(row); if (i >= 0) rows.splice(i, 1);
        tr.remove(); refreshTotals();
      });
      delTd.appendChild(del);
      tr.appendChild(delTd);

      const t0 = rowTotals(row);
      totCell.textContent = money(t0.total); mpCell.textContent = money(t0.withMargin);
      mCell.textContent = money(t0.marginAmount); dCell.textContent = money(t0.withDiscount); gCell.textContent = money(t0.withGst);

      tbody.appendChild(tr);
      return firstControl;
    }
    rows.forEach(addRowDom);

    const addBtn = el("button", "admin-primary-small", seg.addLabel);
    addBtn.type = "button";
    addBtn.addEventListener("click", () => {
      const row = { id: crypto.randomUUID() };
      seg.cols.forEach((c) => { row[c.key] = ""; });
      rows.push(row);
      const first = addRowDom(row);
      if (first) first.focus();
    });
    section.append(scroll, addBtn);

    const msg = el("p", "admin-hint", "");
    const saveBtn = el("button", "admin-primary", seg.saveLabel);
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      msg.textContent = "Saving…";
      const nonEmpty = (r) => seg.cols.some((c) => (c.kind === "number" ? Number(r[c.key]) : String(r[c.key] || "").trim()));
      const records = rows.filter(nonEmpty).map((r, i) => {
        const t = rowTotals(r);
        const rec = {
          id: r.id, project_id: currentProject, sort_order: i,
          total_price: t.total, margin_price: t.withMargin, margin_amount: t.marginAmount, discount_price: t.withDiscount, gst_price: t.withGst,
        };
        seg.cols.forEach((c) => {
          if (c.kind === "readonly") return; // the priceKey it shows is stored below
          if (c.kind === "number") rec[c.key] = Number(r[c.key]) || 0;
          else if (c.kind === "product") { rec[c.key] = r[c.key] || null; rec[c.nameKey] = (String(r[c.nameKey] || "").trim()) || null; }
          else rec[c.key] = String(r[c.key] || "").trim() || null;
        });
        if (!rateIsColumn) rec[priceKey] = Number(r[priceKey]) || 0;
        return rec;
      });
      try {
        if (records.length) {
          const { error } = await sb.from(seg.table).upsert(records);
          if (error) throw error;
        }
        const keepIds = records.map((r) => r.id);
        let delQ = sb.from(seg.table).delete().eq("project_id", currentProject);
        if (keepIds.length) delQ = delQ.not("id", "in", `(${keepIds.join(",")})`);
        const { error: delErr } = await delQ;
        if (delErr) throw delErr;
        msg.textContent = "";
        message(`Saved ${seg.title.toLowerCase()} — ${records.length} row${records.length === 1 ? "" : "s"}.`);
      } catch (error) {
        msg.textContent = `Save failed: ${error.message}`;
      } finally {
        saveBtn.disabled = false;
      }
    });

    const actions = el("div", "admin-row-actions");
    actions.append(saveBtn);

    const block = el("div", "admin-package tk-add");
    block.append(section, totalsWrap, actions, msg);
    container.appendChild(block);
    refreshTotals();
  }

  // ------------------------------------------------------------------
  // Quotation export — a customer-facing table per category + PDF window
  // ------------------------------------------------------------------
  // Customer columns per segment (descriptive only — no supplier / cost). The
  // money columns are always Price (= margin_price), Price with discount
  // (= discount_price) and Price with GST (= gst_price).
  const EXPORT_SEGMENTS = [
    { title: "Box & Shutters", load: loadBoxUnits, cols: [
      { label: "Space", get: (r) => r.space }, { label: "Unit", get: (r) => r.unit_name },
      { label: "Material specifications", get: (r) => r.material_spec }, { label: "Design specifications", get: (r) => r.design_spec },
    ] },
    { title: "Wall Panels", load: loadWallPanels, cols: [
      { label: "Space", get: (r) => r.space },
      { label: "Panel", get: (r) => `${r.panel_type || ""}${r.length_ft && r.height_ft ? ` · ${r.length_ft}×${r.height_ft} ft` : ""}`.trim() },
      { label: "Material specifications", get: (r) => r.material_spec }, { label: "Design specifications", get: (r) => r.design_spec },
    ] },
    { title: "Furniture", load: loadFurniture, cols: [
      { label: "Space", get: (r) => r.space }, { label: "Unit", get: (r) => r.unit_name },
      { label: "Material specifications", get: (r) => r.material_spec }, { label: "Design specifications", get: (r) => r.design_spec },
      { label: "Qty", get: (r) => r.quantity },
    ] },
    { title: "Accessories", load: loadAccessories, cols: [
      { label: "Unit", get: (r) => r.unit_name }, { label: "Specification", get: (r) => r.specification }, { label: "Qty", get: (r) => r.quantity },
    ] },
    { title: "Paint work", load: loadPaint, cols: [
      { label: "Description", get: (r) => r.description }, { label: "Sqft", get: (r) => r.sqft },
    ] },
    { title: "Civil Work", load: (pid) => loadCompositeUnits("turnkey_quote_civil", pid), cols: [
      { label: "Space", get: (r) => r.space }, { label: "Unit", get: (r) => r.unit_name },
      { label: "Material specifications", get: (r) => r.material_spec }, { label: "Design specifications", get: (r) => r.design_spec },
    ] },
    { title: "Electrical Work", load: (pid) => loadCompositeUnits("turnkey_quote_electrical", pid), cols: [
      { label: "Space", get: (r) => r.space }, { label: "Unit", get: (r) => r.unit_name },
      { label: "Material specifications", get: (r) => r.material_spec }, { label: "Design specifications", get: (r) => r.design_spec },
    ] },
  ];

  const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  async function renderExport(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let seller, project, segData;
    try {
      const res = await Promise.all([
        loadSellerSettings(),
        loadProjectFull(currentProject),
        ...EXPORT_SEGMENTS.map((s) => s.load(currentProject)),
      ]);
      [seller, project] = res;
      segData = res.slice(2);
    } catch (error) {
      container.textContent = "";
      container.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If a table/column is missing, run migrations 027–036.`));
      return;
    }
    container.textContent = "";

    const segments = EXPORT_SEGMENTS.map((s, i) => {
      const rows = segData[i] || [];
      const totals = rows.reduce((a, r) => {
        a.price += Number(r.margin_price) || 0;
        a.disc += Number(r.discount_price) || 0;
        a.gst += Number(r.gst_price) || 0;
        return a;
      }, { price: 0, disc: 0, gst: 0 });
      return { title: s.title, cols: s.cols, rows, totals };
    }).filter((s) => s.rows.length);

    const grand = segments.reduce((a, s) => { a.price += s.totals.price; a.disc += s.totals.disc; a.gst += s.totals.gst; return a; }, { price: 0, disc: 0, gst: 0 });

    const head = el("div", "admin-package");
    head.appendChild(el("p", "eyebrow", "QUOTATION EXPORT"));
    head.appendChild(el("p", "dash-note", `Project #${project.project_number} — ${project.client_name}. The customer quotation: each category as its own table, showing Price, Price with discount and Price with GST. Supplier and cost are not shown.`));
    const exportBtn = el("button", "admin-primary", "Open printable quotation");
    exportBtn.type = "button";
    exportBtn.disabled = !segments.length;
    exportBtn.addEventListener("click", () => openQuotationWindow(seller, project, segments, grand));
    head.appendChild(exportBtn);
    if (!project.client_email) head.appendChild(el("p", "dash-note", "Note: this project has no client email — add one in the dashboard to email the quotation."));
    container.appendChild(head);

    // Called back by the printable window's "Email to customer" button: it hands
    // us the generated PDF (base64); we email it via the edge function (auth here).
    window.__scSendQuotationPdf = async (base64, filename) => {
      if (!project.client_email) return { ok: false, message: "No email on file for this project — add it in the dashboard." };
      try {
        const { data, error } = await sb.functions.invoke("send-turnkey-quotation", { body: { project_id: currentProject, pdf_base64: base64, filename: filename || `Quotation-${project.project_number}.pdf` } });
        if (error) {
          let detail = error.message;
          try { const b = await error.context.json(); if (b && b.error) detail = b.error; } catch (_ignored) { /* no body */ }
          throw new Error(detail);
        }
        if (data && data.error) throw new Error(data.error);
        if (data && data.ok === false && data.reason === "no_email") return { ok: false, message: "No email on file for this project." };
        if (data && data.ok === false && data.reason === "email_not_configured") return { ok: false, message: "Email isn't configured on the server (RESEND_API_KEY)." };
        message(`Quotation emailed to ${project.client_email}.`);
        return { ok: true, message: `Sent to ${project.client_email}.` };
      } catch (e) {
        return { ok: false, message: `Send failed: ${e.message}` };
      }
    };

    if (!segments.length) {
      container.appendChild(el("p", "dash-note", "No saved quotation lines in any category yet."));
      return;
    }
    segments.forEach((s) => container.appendChild(exportPreviewTable(s)));
    container.appendChild(exportSummaryTable(segments, grand));
  }

  function exportPreviewTable(s) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", s.title));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    [...s.cols.map((c) => c.label), "Price", "Price with discount", "Price with GST"].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tb = el("tbody");
    s.rows.forEach((r) => {
      const tr = el("tr");
      s.cols.forEach((c) => { const td = el("td"); const v = c.get(r); td.textContent = (v == null || v === "") ? "—" : v; tr.appendChild(td); });
      [r.margin_price, r.discount_price, r.gst_price].forEach((v) => { const td = el("td"); td.textContent = money(v); tr.appendChild(td); });
      tb.appendChild(tr);
    });
    const trT = el("tr", "tk-cat-sqft-total");
    const span = el("td"); span.colSpan = s.cols.length; span.textContent = "Total";
    trT.appendChild(span);
    [s.totals.price, s.totals.disc, s.totals.gst].forEach((v) => { const td = el("td"); td.textContent = money(v); trT.appendChild(td); });
    tb.appendChild(trT);
    t.append(thead, tb);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    return wrap;
  }

  function exportSummaryTable(segments, grand) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Summary — by category"));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const hr = el("tr");
    ["Category", "Total", "Total with discount", "Total with GST"].forEach((h) => hr.appendChild(el("th", null, h)));
    t.appendChild(hr);
    segments.forEach((s) => {
      const tr = el("tr");
      [s.title, money(s.totals.price), money(s.totals.disc), money(s.totals.gst)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
      t.appendChild(tr);
    });
    const trG = el("tr", "tk-cat-sqft-total");
    ["Grand total", money(grand.price), money(grand.disc), money(grand.gst)].forEach((c) => { const td = el("td"); td.textContent = c; trG.appendChild(td); });
    t.appendChild(trG);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    return wrap;
  }

  function quotationHtml(seller, project, segments, grand) {
    const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const sellerName = seller.trade_name || seller.legal_name || "Safe Creatives";
    const sellerAddr = [seller.address_line, [seller.city, seller.state_name].filter(Boolean).join(", "), seller.pin_code].filter(Boolean).join(", ");
    const seg = segments.map((s) => {
      const heads = [...s.cols.map((c) => `<th>${escHtml(c.label)}</th>`), `<th class="num">Price</th>`, `<th class="num">Price with discount</th>`, `<th class="num">Price with GST</th>`].join("");
      const body = s.rows.map((r) => {
        const tds = s.cols.map((c) => { const v = c.get(r); return `<td>${escHtml(v == null || v === "" ? "—" : v)}</td>`; }).join("");
        return `<tr>${tds}<td class="num">${escHtml(money(r.margin_price))}</td><td class="num">${escHtml(money(r.discount_price))}</td><td class="num">${escHtml(money(r.gst_price))}</td></tr>`;
      }).join("");
      const total = `<tr class="total"><td colspan="${s.cols.length}">Total</td><td class="num">${escHtml(money(s.totals.price))}</td><td class="num">${escHtml(money(s.totals.disc))}</td><td class="num">${escHtml(money(s.totals.gst))}</td></tr>`;
      return `<h2>${escHtml(s.title)}</h2><table><thead><tr>${heads}</tr></thead><tbody>${body}${total}</tbody></table>`;
    }).join("");
    const summary = segments.map((s) => `<tr><td>${escHtml(s.title)}</td><td class="num">${escHtml(money(s.totals.price))}</td><td class="num">${escHtml(money(s.totals.disc))}</td><td class="num">${escHtml(money(s.totals.gst))}</td></tr>`).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Quotation — ${escHtml(project.client_name)} (#${escHtml(project.project_number)})</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 "DM Sans", Arial, sans-serif; color: #171717; background: #f4f4f2; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 18px; background: #0c4444; color: #fff; }
  .toolbar button { padding: 9px 16px; border: 0; border-radius: 6px; background: #fff; color: #0c4444; font: 600 13px "DM Sans", sans-serif; cursor: pointer; }
  .toolbar .muted { color: #cfe3e3; font-size: 12px; }
  .doc { max-width: 900px; margin: 20px auto; padding: 40px; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #0c4444; padding-bottom: 16px; }
  header h1 { margin: 0 0 6px; font-size: 22px; color: #0c4444; }
  header p { margin: 2px 0; font-size: 12px; color: #444; }
  .meta { text-align: right; }
  .meta h3 { margin: 0 0 6px; letter-spacing: .1em; color: #6f222a; }
  .cust { margin: 18px 0 6px; }
  .cust h4 { margin: 0 0 4px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #777; }
  .cust p { margin: 2px 0; }
  h2 { margin: 26px 0 8px; font-size: 14px; color: #6f222a; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e6e6e2; text-align: left; vertical-align: top; }
  th { font: 600 10px "DM Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: #777; background: #fafaf8; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr.total td { font-weight: 700; color: #0c4444; border-top: 2px solid #0c4444; background: #f4f6f3; }
  .note { margin-top: 24px; font-size: 11px; color: #888; }
  @media print { body { background: #fff; } .toolbar { display: none; } .doc { box-shadow: none; margin: 0; max-width: none; padding: 0; } }
</style>
<script src="https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.2/dist/html2pdf.bundle.min.js"></script></head><body>
  <div class="toolbar">
    <button onclick="window.print()">Download / Print (PDF)</button>
    <button id="sc-email-btn" type="button">Email to customer</button>
    <span class="muted" id="sc-email-status"></span>
  </div>
  <div class="doc">
    <header>
      <div class="seller"><h1>${escHtml(sellerName)}</h1><p>${escHtml(sellerAddr)}</p>${seller.gstin ? `<p>GSTIN: ${escHtml(seller.gstin)}</p>` : ""}${seller.phone || seller.email ? `<p>${escHtml([seller.phone, seller.email].filter(Boolean).join(" · "))}</p>` : ""}</div>
      <div class="meta"><h3>QUOTATION</h3><p>Project #${escHtml(project.project_number)}</p><p>${escHtml(today)}</p></div>
    </header>
    <section class="cust"><h4>Prepared for</h4><p><strong>${escHtml(project.client_name)}</strong></p>${project.client_phone ? `<p>${escHtml(project.client_phone)}</p>` : ""}${project.client_email ? `<p>${escHtml(project.client_email)}</p>` : ""}${project.site_address ? `<p>${escHtml(project.site_address)}</p>` : ""}${project.project_name ? `<p>Project: ${escHtml(project.project_name)}</p>` : ""}</section>
    ${seg}
    <h2>Summary</h2>
    <table><thead><tr><th>Category</th><th class="num">Total</th><th class="num">Total with discount</th><th class="num">Total with GST</th></tr></thead><tbody>${summary}<tr class="total"><td>Grand total</td><td class="num">${escHtml(money(grand.price))}</td><td class="num">${escHtml(money(grand.disc))}</td><td class="num">${escHtml(money(grand.gst))}</td></tr></tbody></table>
    <p class="note">This is a quotation, not a tax invoice. Amounts shown as Price include the applicable margin; GST is shown where applicable. Valid subject to confirmation.</p>
  </div>
  <script>
    (function () {
      var RECIPIENT = ${JSON.stringify(project.client_email || "")};
      var FILENAME = ${JSON.stringify(`Quotation-${project.project_number || ""}.pdf`)};
      var btn = document.getElementById("sc-email-btn");
      var status = document.getElementById("sc-email-status");
      btn.addEventListener("click", async function () {
        if (!window.opener || !window.opener.__scSendQuotationPdf) { status.textContent = "Open the quotation from the Export tab to enable email."; return; }
        if (!RECIPIENT) { status.textContent = "No email on file for this project — add it in the dashboard."; return; }
        if (!window.confirm("Email this quotation to " + RECIPIENT + "?")) return;
        if (typeof window.html2pdf !== "function") { status.textContent = "PDF library still loading — try again in a second."; return; }
        btn.disabled = true;
        status.textContent = "Generating PDF…";
        try {
          var opt = { margin: 8, image: { type: "jpeg", quality: 0.95 }, html2canvas: { scale: 2, useCORS: true }, jsPDF: { unit: "mm", format: "a4", orientation: "portrait" }, pagebreak: { mode: ["css", "legacy"] } };
          var uri = await window.html2pdf().set(opt).from(document.querySelector(".doc")).outputPdf("datauristring");
          var b64 = uri.indexOf(",") >= 0 ? uri.split(",")[1] : uri;
          status.textContent = "Sending…";
          var res = await window.opener.__scSendQuotationPdf(b64, FILENAME);
          status.textContent = res && res.message ? res.message : (res && res.ok ? "Sent." : "Failed.");
        } catch (e) {
          status.textContent = "Failed: " + (e && e.message ? e.message : e);
        } finally {
          btn.disabled = false;
        }
      });
    })();
  </script>
</body></html>`;
  }

  function openQuotationWindow(seller, project, segments, grand) {
    const w = window.open("", "_blank");
    if (!w) { message("Pop-up blocked — allow pop-ups for this site to open the quotation.", true); return; }
    w.document.open();
    w.document.write(quotationHtml(seller, project, segments, grand));
    w.document.close();
    w.focus();
  }

  // ------------------------------------------------------------------
  // Vendor BOQ — everything you buy, grouped by supplier
  // ------------------------------------------------------------------
  async function renderVendorBoq(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    // Rebuild the material BOQ first so it reflects the latest units (and
    // backfills supplier/price for older lines). Best-effort.
    try { await computeUnit({ recompute_boq: true, project_id: currentProject }); } catch (_e) { /* keep going */ }

    let seller, boq, furniture, accessories, paint, civil, electrical;
    try {
      [seller, boq, furniture, accessories, paint, civil, electrical] = await Promise.all([
        loadSellerSettings(),
        loadProjectBoq(currentProject),
        loadFurniture(currentProject),
        loadAccessories(currentProject),
        loadPaint(currentProject),
        loadCompositeUnits("turnkey_quote_civil", currentProject),
        loadCompositeUnits("turnkey_quote_electrical", currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If a table/column is missing, run migrations 034–038.`));
      return;
    }
    container.textContent = "";

    const proj = projectsById.get(currentProject) || {};
    const gst = Number(proj.gst_percent) || 0;
    const round2 = (n) => Math.round(n * 100) / 100;
    const NO_SUPPLIER = "(supplier not set)";

    // Flatten every purchasable line into { supplier, product, detail, qty, unit_price, total }.
    const lines = [];
    boq.forEach((r) => {
      const qty = Number(r.quantity) || 0, up = Number(r.unit_price) || 0;
      lines.push({ supplier: r.supplier || NO_SUPPLIER, product: r.product_name || "—", detail: r.category || "", qty, unit_price: up, total: round2(qty * up) });
    });
    furniture.forEach((r) => {
      const qty = Number(r.quantity) || 0, up = Number(r.unit_price) || 0;
      const detail = [r.material_spec, r.design_spec].filter(Boolean).join(", ");
      lines.push({ supplier: r.supplier || NO_SUPPLIER, product: r.unit_name || "—", detail: detail || "Furniture", qty, unit_price: up, total: round2(qty * up) });
    });
    accessories.forEach((r) => {
      const qty = Number(r.quantity) || 0, up = Number(r.unit_price) || 0;
      const detail = ["Accessory", r.specification].filter(Boolean).join(" · ");
      lines.push({ supplier: r.supplier || NO_SUPPLIER, product: r.unit_name || "—", detail, qty, unit_price: up, total: round2(qty * up) });
    });
    paint.forEach((r) => {
      const qty = Number(r.sqft) || 0, up = Number(r.unit_price) || 0;
      lines.push({ supplier: r.supplier || NO_SUPPLIER, product: r.description || "—", detail: "Paint work (sqft)", qty, unit_price: up, total: round2(qty * up) });
    });
    [["Civil work", civil], ["Electrical work", electrical]].forEach(([label, units]) => {
      units.forEach((u) => {
        (u.material_lines || []).forEach((r) => {
          const qty = Number(r.quantity) || 0, up = Number(r.unit_price) || 0;
          lines.push({ supplier: r.supplier || NO_SUPPLIER, product: r.product_name || "—", detail: `${label}${u.unit_name ? " · " + u.unit_name : ""}`, qty, unit_price: up, total: round2(qty * up) });
        });
        (u.special_additions || []).forEach((r) => {
          const qty = Number(r.quantity) || 0, up = Number(r.unit_price) || 0;
          if (!qty && !r.hardware_id) return;
          lines.push({ supplier: r.supplier || NO_SUPPLIER, product: r.product_name || "—", detail: `${label} · special${u.unit_name ? " · " + u.unit_name : ""}`, qty, unit_price: up, total: round2(qty * up) });
        });
      });
    });

    // Group by supplier.
    const groups = new Map();
    lines.forEach((l) => {
      if (!groups.has(l.supplier)) groups.set(l.supplier, []);
      groups.get(l.supplier).push(l);
    });
    const suppliers = [...groups.entries()]
      .map(([supplier, rows]) => {
        const total = round2(rows.reduce((a, r) => a + r.total, 0));
        return { supplier, rows, total, totalWithGst: round2(total * (1 + gst / 100)) };
      })
      .sort((a, b) => (a.supplier === NO_SUPPLIER ? 1 : b.supplier === NO_SUPPLIER ? -1 : a.supplier.localeCompare(b.supplier)));

    const head = el("div", "admin-package");
    head.appendChild(el("p", "eyebrow", "VENDOR BOQ"));
    head.appendChild(el("p", "dash-note", `Project #${proj.project_number || ""}. What to buy, grouped by supplier — quantity, product, unit price, line total, and the total with GST (${gst}%). Export each supplier's list for procurement.`));
    container.appendChild(head);

    if (!suppliers.length) {
      container.appendChild(el("p", "dash-note", "Nothing to procure yet. Save some Box & Shutters / Wall Panels / Furniture / Accessories / Paint lines first."));
      return;
    }
    suppliers.forEach((s) => container.appendChild(vendorSupplierTable(s, seller, proj, gst)));
  }

  function vendorSupplierTable(s, seller, proj, gst) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", s.supplier));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Product", "Detail", "Quantity", "Unit price", "Line total"].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tb = el("tbody");
    s.rows.forEach((r) => {
      const tr = el("tr");
      [r.product, r.detail || "—", r.qty, money(r.unit_price), money(r.total)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    const trT = el("tr", "tk-cat-sqft-total");
    const span = el("td"); span.colSpan = 4; span.textContent = "Total";
    trT.appendChild(span);
    const totTd = el("td"); totTd.textContent = money(s.total); trT.appendChild(totTd);
    tb.appendChild(trT);
    const trG = el("tr", "tk-cat-sqft-total");
    const span2 = el("td"); span2.colSpan = 4; span2.textContent = `Total with GST (${gst}%)`;
    trG.appendChild(span2);
    const gstTd = el("td"); gstTd.textContent = money(s.totalWithGst); trG.appendChild(gstTd);
    tb.appendChild(trG);
    t.append(thead, tb);
    scroll.appendChild(t);
    wrap.appendChild(scroll);

    const exportBtn = el("button", "admin-primary-small", "Export vendor BOQ");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", () => openVendorBoqWindow(s, seller, proj, gst));
    wrap.appendChild(exportBtn);
    return wrap;
  }

  function vendorBoqHtml(s, seller, proj, gst) {
    const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const sellerName = seller.trade_name || seller.legal_name || "Safe Creatives";
    const sellerAddr = [seller.address_line, [seller.city, seller.state_name].filter(Boolean).join(", "), seller.pin_code].filter(Boolean).join(", ");
    const body = s.rows.map((r) => `<tr><td>${escHtml(r.product)}</td><td>${escHtml(r.detail || "—")}</td><td class="num">${escHtml(r.qty)}</td><td class="num">${escHtml(money(r.unit_price))}</td><td class="num">${escHtml(money(r.total))}</td></tr>`).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Vendor BOQ — ${escHtml(s.supplier)} (Project #${escHtml(proj.project_number || "")})</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 "DM Sans", Arial, sans-serif; color: #171717; background: #f4f4f2; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 18px; background: #6f222a; color: #fff; }
  .toolbar button { padding: 9px 16px; border: 0; border-radius: 6px; background: #fff; color: #6f222a; font: 600 13px "DM Sans", sans-serif; cursor: pointer; }
  .doc { max-width: 900px; margin: 20px auto; padding: 40px; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #6f222a; padding-bottom: 16px; }
  header h1 { margin: 0 0 6px; font-size: 20px; color: #6f222a; }
  header p { margin: 2px 0; font-size: 12px; color: #444; }
  .meta { text-align: right; }
  .meta h3 { margin: 0 0 6px; letter-spacing: .1em; color: #0c4444; }
  .vend { margin: 18px 0 6px; }
  .vend h4 { margin: 0 0 4px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #777; }
  .vend p { margin: 2px 0; font-size: 15px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e6e6e2; text-align: left; vertical-align: top; }
  th { font: 600 10px "DM Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: #777; background: #fafaf8; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; color: #6f222a; border-top: 2px solid #6f222a; background: #faf5f5; }
  .note { margin-top: 24px; font-size: 11px; color: #888; }
  @media print { body { background: #fff; } .toolbar { display: none; } .doc { box-shadow: none; margin: 0; max-width: none; padding: 0; } }
</style></head><body>
  <div class="toolbar"><button onclick="window.print()">Download / Print (PDF)</button></div>
  <div class="doc">
    <header>
      <div><h1>${escHtml(sellerName)}</h1><p>${escHtml(sellerAddr)}</p>${seller.gstin ? `<p>GSTIN: ${escHtml(seller.gstin)}</p>` : ""}${seller.phone || seller.email ? `<p>${escHtml([seller.phone, seller.email].filter(Boolean).join(" · "))}</p>` : ""}</div>
      <div class="meta"><h3>VENDOR BOQ</h3><p>Project #${escHtml(proj.project_number || "")}</p><p>${escHtml(today)}</p></div>
    </header>
    <section class="vend"><h4>Supplier</h4><p>${escHtml(s.supplier)}</p></section>
    <table>
      <thead><tr><th>Product</th><th>Detail</th><th class="num">Quantity</th><th class="num">Unit price</th><th class="num">Line total</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot>
        <tr><td colspan="4">Total</td><td class="num">${escHtml(money(s.total))}</td></tr>
        <tr><td colspan="4">Total with GST (${gst}%)</td><td class="num">${escHtml(money(s.totalWithGst))}</td></tr>
      </tfoot>
    </table>
    <p class="note">Procurement bill of quantities for internal tracking. GST at ${gst}% as per the project.</p>
  </div>
</body></html>`;
  }

  function openVendorBoqWindow(s, seller, proj, gst) {
    const w = window.open("", "_blank");
    if (!w) { message("Pop-up blocked — allow pop-ups for this site to open the BOQ.", true); return; }
    w.document.open();
    w.document.write(vendorBoqHtml(s, seller, proj, gst));
    w.document.close();
    w.focus();
  }

  // ------------------------------------------------------------------
  // Civil / Electrical — composite units (Material + Labour + Special)
  // ------------------------------------------------------------------
  const CIVIL_SEG = { table: "turnkey_quote_civil", category: "civil", title: "Civil Work", noun: "civil unit", addLabel: "Add a civil unit", migration: "038" };
  const ELECTRICAL_SEG = { table: "turnkey_quote_electrical", category: "electrical", title: "Electrical Work", noun: "electrical unit", addLabel: "Add an electrical unit", migration: "038" };

  async function renderCompositeSegment(container, seg) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let spaces, suppliers, products, hardware, labour, units;
    try {
      [spaces, suppliers, products, hardware, labour, units] = await Promise.all([
        loadSelectedSpaces(currentProject), loadSuppliers(), loadCatalogProducts(), loadHardware(), loadLabour(), loadCompositeUnits(seg.table, currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If a table/column is missing, run migration ${seg.migration}.`));
      return;
    }
    const ref = { spaces, suppliers, products, hardware, labour };
    container.textContent = "";
    container.appendChild(compositeEditor(seg, ref, null, () => renderCompositeSegment(container, seg)));
    container.appendChild(compositeList(seg, units, () => renderCompositeSegment(container, seg)));
  }

  function compositeEditor(seg, ref, existing, onSaved) {
    const u = existing?.unit || {};
    const block = el("details", "admin-package tk-add");
    block.open = !existing;
    block.appendChild(el("summary", null, existing ? `Edit ${seg.noun} — ${u.unit_name || "unnamed"}` : seg.addLabel));
    let unitId = u.id || null;

    const spaceS = selectEl(ref.spaces, u.space || "", ref.spaces.length ? "Select area…" : "No spaces");
    const nameI = document.createElement("input"); nameI.type = "text"; nameI.placeholder = "Unit name"; if (u.unit_name) nameI.value = u.unit_name;
    const designI = document.createElement("input"); designI.type = "text"; designI.placeholder = "Design specification"; if (u.design_spec) designI.value = u.design_spec;
    const grid = el("div", "admin-inline");
    grid.append(field("Space", spaceS), field("Unit name", nameI), field("Design specification", designI));

    const proj = projectsById.get(currentProject) || {};
    const m = Number(proj.margin_percent) || 0, d = Number(proj.discount_percent) || 0, g = Number(proj.gst_percent) || 0;
    const round2 = (n) => Math.round(n * 100) / 100;

    // Sub-section state.
    const materials = (Array.isArray(u.material_lines) ? u.material_lines : []).map((r) => ({ supplier: r.supplier || "", product_id: r.product_id || "", product_name: r.product_name || "", quantity: r.quantity ?? "", unit_price: r.unit_price ?? "" }));
    const special = (Array.isArray(u.special_additions) ? u.special_additions : []).map((s) => ({ hardware_id: s.hardware_id || "", product_name: s.product_name || "", quantity: s.quantity ?? "" }));
    const labour = (Array.isArray(u.labour_lines) ? u.labour_lines : []).map((l) => ({ labour_id: l.labour_id || "", category: l.category || "", name: l.name || "", task: l.task || "", total_days: l.total_days ?? "", total_sqft: l.total_sqft ?? "" }));

    const hwById = new Map((ref.hardware || []).map((h) => [h.id, h]));
    const specialCost = (r) => { const hw = r.hardware_id ? hwById.get(r.hardware_id) : null; return round2((Number(r.quantity) || 0) * (hw ? Number(hw.price) || 0 : 0)); };
    const labourRows = ref.labour || [];
    const labourById = new Map(labourRows.map((r) => [r.id, r]));
    const labourCategories = distinctVals(labourRows.map((r) => r.category)).sort();
    const namesForCat = (cat) => distinctVals(labourRows.filter((r) => r.category === cat).map((r) => r.name)).sort();
    const tasksForCatName = (cat, name) => labourRows.filter((r) => r.category === cat && r.name === name).map((r) => [r.id, r.task || "(no task)"]);
    const rowSqft = (row) => Number(row.total_sqft) || 0;
    const labourCost = (row) => { const lr = row.labour_id ? labourById.get(row.labour_id) : null; if (!lr) return 0; return (Number(row.total_days) || 0) * (Number(lr.cost_per_day) || 0) + rowSqft(row) * (Number(lr.cost_per_sqft) || 0); };
    const materialCost = (r) => round2((Number(r.quantity) || 0) * (Number(r.unit_price) || 0));

    const materialTotal = () => round2(materials.reduce((a, r) => a + materialCost(r), 0));
    const labourTotal = () => round2(labour.reduce((a, r) => a + labourCost(r), 0));
    const specialTotal = () => round2(special.reduce((a, r) => a + specialCost(r), 0));

    const totalsWrap = el("div");
    const refreshTotals = () => {
      const total = round2(materialTotal() + labourTotal() + specialTotal());
      const withMargin = round2(total * (1 + m / 100));
      const marginAmount = round2(withMargin - total);
      const withDiscount = round2(withMargin * (1 - d / 100));
      const withGst = round2(withDiscount * (1 + g / 100));
      renderTotals(totalsWrap, { totals: { total, with_margin: withMargin, margin_amount: marginAmount, with_discount: withDiscount, with_gst: withGst } });
    };

    const materialSection = buildMaterialSection({ materials, suppliers: ref.suppliers, products: ref.products, category: seg.category, materialCost }, refreshTotals);
    const labourUI = buildLabourSection({ labour, labourCategories, namesForCat, tasksForCatName, labourCost, rowSqft, hasLabour: labourRows.length > 0, manualSqft: true, showCatSqft: false }, refreshTotals);
    const specialSection = buildSpecialProductSection(special, ref.hardware, refreshTotals);

    const msg = el("p", "admin-hint", "");
    const saveBtn = el("button", "admin-primary", existing ? "Save changes" : "Save unit");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      msg.textContent = "Saving…";
      const matLines = materials.filter((r) => r.product_id || r.product_name || Number(r.quantity)).map((r) => ({ supplier: r.supplier || null, product_id: r.product_id || null, product_name: (r.product_name || "").trim() || null, quantity: Number(r.quantity) || 0, unit_price: Number(r.unit_price) || 0, total: materialCost(r) }));
      const labLines = labour.filter((l) => l.labour_id || l.total_days || l.total_sqft).map((l) => ({ labour_id: l.labour_id || null, category: l.category || null, name: l.name || null, task: l.task || null, total_days: Number(l.total_days) || 0, total_sqft: Number(l.total_sqft) || 0, cost: labourCost(l) }));
      const specLines = special.filter((s) => s.hardware_id || Number(s.quantity)).map((s) => {
        const hw = s.hardware_id ? hwById.get(s.hardware_id) : null;
        return { hardware_id: s.hardware_id || null, product_name: (s.product_name || (hw && hw.product_name) || "").trim() || null, supplier: hw ? (hw.supplier || null) : null, category: hw ? (hw.category || null) : null, quantity: Number(s.quantity) || 0, unit_price: hw ? Number(hw.price) || 0 : 0, cost: specialCost(s) };
      });
      const materialSpec = [...matLines.map((r) => r.product_name).filter(Boolean), ...specLines.map((s) => s.product_name).filter(Boolean)].join(", ");
      const total = round2(materialTotal() + labourTotal() + specialTotal());
      const withMargin = round2(total * (1 + m / 100));
      const record = {
        id: unitId || crypto.randomUUID(), project_id: currentProject,
        space: spaceS.value || null, unit_name: nameI.value.trim() || null, design_spec: designI.value.trim() || null,
        material_lines: matLines, labour_lines: labLines, special_additions: specLines, material_spec: materialSpec || null,
        total_material_price: materialTotal(), labour_price: labourTotal(), special_price: specialTotal(),
        total_price: total, margin_price: withMargin, margin_amount: round2(withMargin - total),
        discount_price: round2(withMargin * (1 - d / 100)), gst_price: round2(round2(withMargin * (1 - d / 100)) * (1 + g / 100)),
      };
      try {
        const { error } = await sb.from(seg.table).upsert(record);
        if (error) throw error;
        unitId = record.id;
        msg.textContent = "";
        message(`Saved ${seg.noun} — ${money(record.gst_price)} (with GST).`);
        onSaved();
      } catch (error) {
        msg.textContent = `Save failed: ${error.message}`;
      } finally {
        saveBtn.disabled = false;
      }
    });

    const actions = el("div", "admin-row-actions");
    actions.append(saveBtn);
    const extras = el("div", "tk-box-sections");
    extras.append(materialSection, labourUI.node, specialSection);
    block.append(grid, extras, totalsWrap, actions, msg);
    refreshTotals();
    return block;
  }

  // The Material sub-table: rows of supplier + product (filtered) + quantity,
  // with a computed price. Mutates the shared `materials` array.
  function buildMaterialSection(cfg, onChange) {
    const { materials, suppliers, products, category, materialCost } = cfg;
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", "Material"));
    wrap.appendChild(el("p", "dash-note", `Pick a supplier and a ${category} product from the database, then the quantity. Price = Quantity × the product's unit price.`));

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Supplier", "Product", "Quantity", "Price", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    t.append(thead, tbody);
    scroll.appendChild(t);

    const subtotal = el("p", "tk-box-total", "");
    const refreshSubtotal = () => { subtotal.textContent = `Material total: ${money(materials.reduce((a, r) => a + materialCost(r), 0))}`; };

    function addRowDom(row) {
      const tr = el("tr");
      const cell = (c) => { const td = el("td"); td.appendChild(c); return td; };
      const supOpts = row.supplier && !suppliers.includes(row.supplier) ? [row.supplier, ...suppliers] : suppliers;
      const supplierSel = selectEl(supOpts, row.supplier || "", suppliers.length ? "Supplier…" : "No suppliers");
      supplierSel.className = "grid-input grid-select";
      const productSel = document.createElement("select");
      productSel.className = "grid-input grid-select";
      const fillProducts = () => {
        const sup = row.supplier;
        const opts = products.filter((p) => normCat(p.category) === normCat(category) && (!sup || p.supplier === sup));
        productSel.textContent = "";
        productSel.appendChild(new Option(sup ? "Select…" : "Pick a supplier first", ""));
        opts.forEach((p) => productSel.appendChild(new Option(p.product_name || "unnamed", p.id)));
        productSel.value = row.product_id || "";
      };
      fillProducts();
      const qtyI = document.createElement("input"); qtyI.type = "number"; qtyI.min = "0"; qtyI.className = "grid-input"; qtyI.placeholder = "0";
      qtyI.value = (row.quantity === "" || row.quantity == null) ? "" : row.quantity;
      const priceCell = el("td");
      const updatePrice = () => { priceCell.textContent = money(materialCost(row)); refreshSubtotal(); onChange(); };

      supplierSel.addEventListener("change", () => {
        row.supplier = supplierSel.value; row.product_id = ""; row.product_name = ""; row.unit_price = "";
        fillProducts(); updatePrice();
      });
      productSel.addEventListener("change", () => {
        row.product_id = productSel.value;
        const p = products.find((x) => String(x.id) === productSel.value);
        row.product_name = p ? (p.product_name || "") : "";
        row.unit_price = p ? (Number(p.price_per_sqft) || 0) : "";
        updatePrice();
      });
      qtyI.addEventListener("input", () => { row.quantity = qtyI.value; updatePrice(); });

      const delTd = el("td", "db-grid-del");
      const del = el("button", "tk-delete-link", "✕"); del.type = "button"; del.title = "Remove";
      del.addEventListener("click", () => { const i = materials.indexOf(row); if (i >= 0) materials.splice(i, 1); tr.remove(); refreshSubtotal(); onChange(); });
      delTd.appendChild(del);

      tr.append(cell(supplierSel), cell(productSel), cell(qtyI), priceCell, delTd);
      priceCell.textContent = money(materialCost(row));
      tbody.appendChild(tr);
      return supplierSel;
    }
    materials.forEach(addRowDom);

    const addBtn = el("button", "admin-primary-small", "+ Add material");
    addBtn.type = "button";
    addBtn.addEventListener("click", () => { const row = { supplier: "", product_id: "", product_name: "", quantity: "", unit_price: "" }; materials.push(row); addRowDom(row).focus(); });

    wrap.append(scroll, addBtn, subtotal);
    refreshSubtotal();
    return wrap;
  }

  function compositeList(seg, units, onChanged) {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el("p", "dash-note", `Saved ${seg.title.toLowerCase()} units. Open to edit, or delete.`));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Space", "Unit", "Material specifications", "Design specifications", "Total", "With margin", "Margin", "With discount", "With GST", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    if (!units.length) { const tr = el("tr"); const td = el("td", "dash-empty", "No units yet."); td.colSpan = 10; tr.appendChild(td); tbody.appendChild(tr); }
    units.forEach((u) => {
      const open = el("button", "tk-email-link", "Open");
      open.type = "button";
      open.addEventListener("click", async () => {
        try {
          const ref = { spaces: await loadSelectedSpaces(currentProject), suppliers: await loadSuppliers(), products: await loadCatalogProducts(), hardware: await loadHardware(), labour: await loadLabour() };
          const units2 = await loadCompositeUnits(seg.table, currentProject);
          const unit = units2.find((x) => x.id === u.id) || u;
          panel.textContent = "";
          panel.appendChild(compositeEditor(seg, ref, { unit }, () => renderCompositeSegment(panel, seg)));
          panel.appendChild(compositeList(seg, units2, () => renderCompositeSegment(panel, seg)));
        } catch (error) { message(`Could not open: ${error.message}`, true); }
      });
      const del = el("button", "tk-delete-link", "Delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete this ${seg.noun}? This cannot be undone.`)) return;
        const { error } = await sb.from(seg.table).delete().eq("id", u.id);
        if (error) return void message(`Could not delete: ${error.message}`, true);
        message("Unit deleted.");
        onChanged();
      });
      const actions = el("div", "tk-cell-actions"); actions.append(open, del);
      const cells = [u.space || "—", u.unit_name || "—", u.material_spec || "—", u.design_spec || "—", money(u.total_price), money(u.margin_price), money(u.margin_amount), money(u.discount_price), money(u.gst_price), actions];
      const tr = el("tr");
      cells.forEach((c) => { const td = el("td"); if (c instanceof Node) td.appendChild(c); else td.textContent = c; tr.appendChild(td); });
      tbody.appendChild(tr);
    });
    t.append(thead, tbody);
    scroll.appendChild(t);
    wrap.appendChild(scroll);
    return wrap;
  }

  // ------------------------------------------------------------------
  // Labour BOQ — every labour line, grouped by labourer (name)
  // ------------------------------------------------------------------
  async function renderLabourBoq(container) {
    container.textContent = "";
    container.appendChild(el("p", "dash-note", "Loading…"));
    let seller, lines;
    try {
      [seller, lines] = await Promise.all([loadSellerSettings(), loadAllLabourLines(currentProject)]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If a table/column is missing, run migrations 025–038.`));
      return;
    }
    container.textContent = "";

    const proj = projectsById.get(currentProject) || {};
    const round2 = (n) => Math.round(n * 100) / 100;
    const NO_NAME = "(unnamed labour)";
    const groups = new Map();
    lines.forEach((l) => {
      const name = (l.name && String(l.name).trim()) || NO_NAME;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(l);
    });
    const labourers = [...groups.entries()]
      .map(([name, rows]) => ({
        name, rows,
        days: round2(rows.reduce((a, r) => a + (Number(r.total_days) || 0), 0)),
        sqft: round2(rows.reduce((a, r) => a + (Number(r.total_sqft) || 0), 0)),
        price: round2(rows.reduce((a, r) => a + (Number(r.cost) || 0), 0)),
      }))
      .sort((a, b) => (a.name === NO_NAME ? 1 : b.name === NO_NAME ? -1 : a.name.localeCompare(b.name)));

    const head = el("div", "admin-package");
    head.appendChild(el("p", "eyebrow", "LABOUR BOQ"));
    head.appendChild(el("p", "dash-note", `Project #${proj.project_number || ""}. Every labour line across Box & Shutters, Wall Panels, Civil and Electrical, grouped by labourer — category, task, days, sqft and cost. Export each labourer's sheet for tracking.`));
    container.appendChild(head);

    if (!labourers.length) {
      container.appendChild(el("p", "dash-note", "No labour lines yet. Add labour to a Box & Shutters / Wall Panels / Civil / Electrical unit first."));
      return;
    }
    labourers.forEach((l) => container.appendChild(labourBoqTable(l, seller, proj)));
  }

  function labourBoqTable(l, seller, proj) {
    const wrap = el("div", "tk-box-section");
    wrap.appendChild(el("div", "tk-box-section-head", l.name));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Labour category", "Labour name", "Labour task", "Days", "Sqft", "Price"].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tb = el("tbody");
    l.rows.forEach((r) => {
      const tr = el("tr");
      [r.category || "—", r.name || "—", r.task || "—", r.total_days ?? 0, r.total_sqft ?? 0, money(r.cost)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
      tb.appendChild(tr);
    });
    const trT = el("tr", "tk-cat-sqft-total");
    const span = el("td"); span.colSpan = 3; span.textContent = "Total";
    trT.appendChild(span);
    [l.days, l.sqft, money(l.price)].forEach((c) => { const td = el("td"); td.textContent = c; trT.appendChild(td); });
    tb.appendChild(trT);
    t.append(thead, tb);
    scroll.appendChild(t);
    wrap.appendChild(scroll);

    const exportBtn = el("button", "admin-primary-small", "Export labour sheet");
    exportBtn.type = "button";
    exportBtn.addEventListener("click", () => openLabourBoqWindow(l, seller, proj));
    wrap.appendChild(exportBtn);
    return wrap;
  }

  function labourBoqHtml(l, seller, proj) {
    const today = new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
    const sellerName = seller.trade_name || seller.legal_name || "Safe Creatives";
    const sellerAddr = [seller.address_line, [seller.city, seller.state_name].filter(Boolean).join(", "), seller.pin_code].filter(Boolean).join(", ");
    const body = l.rows.map((r) => `<tr><td>${escHtml(r.category || "—")}</td><td>${escHtml(r.task || "—")}</td><td class="num">${escHtml(r.total_days ?? 0)}</td><td class="num">${escHtml(r.total_sqft ?? 0)}</td><td class="num">${escHtml(money(r.cost))}</td></tr>`).join("");
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Labour sheet — ${escHtml(l.name)} (Project #${escHtml(proj.project_number || "")})</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 "DM Sans", Arial, sans-serif; color: #171717; background: #f4f4f2; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 18px; background: #0c4444; color: #fff; }
  .toolbar button { padding: 9px 16px; border: 0; border-radius: 6px; background: #fff; color: #0c4444; font: 600 13px "DM Sans", sans-serif; cursor: pointer; }
  .doc { max-width: 820px; margin: 20px auto; padding: 40px; background: #fff; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
  header { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #0c4444; padding-bottom: 16px; }
  header h1 { margin: 0 0 6px; font-size: 20px; color: #0c4444; }
  header p { margin: 2px 0; font-size: 12px; color: #444; }
  .meta { text-align: right; }
  .meta h3 { margin: 0 0 6px; letter-spacing: .1em; color: #6f222a; }
  .who { margin: 18px 0 6px; }
  .who h4 { margin: 0 0 4px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: #777; }
  .who p { margin: 2px 0; font-size: 15px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 14px; }
  th, td { padding: 8px 10px; border-bottom: 1px solid #e6e6e2; text-align: left; vertical-align: top; }
  th { font: 600 10px "DM Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: #777; background: #fafaf8; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: 700; color: #0c4444; border-top: 2px solid #0c4444; background: #f4f6f3; }
  .note { margin-top: 24px; font-size: 11px; color: #888; }
  @media print { body { background: #fff; } .toolbar { display: none; } .doc { box-shadow: none; margin: 0; max-width: none; padding: 0; } }
</style></head><body>
  <div class="toolbar"><button onclick="window.print()">Download / Print (PDF)</button></div>
  <div class="doc">
    <header>
      <div><h1>${escHtml(sellerName)}</h1><p>${escHtml(sellerAddr)}</p>${seller.phone || seller.email ? `<p>${escHtml([seller.phone, seller.email].filter(Boolean).join(" · "))}</p>` : ""}</div>
      <div class="meta"><h3>LABOUR SHEET</h3><p>Project #${escHtml(proj.project_number || "")}</p><p>${escHtml(today)}</p></div>
    </header>
    <section class="who"><h4>Labourer</h4><p>${escHtml(l.name)}</p></section>
    <table>
      <thead><tr><th>Labour category</th><th>Task</th><th class="num">Days</th><th class="num">Sqft</th><th class="num">Price</th></tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr><td colspan="2">Total</td><td class="num">${escHtml(l.days)}</td><td class="num">${escHtml(l.sqft)}</td><td class="num">${escHtml(money(l.price))}</td></tr></tfoot>
    </table>
    <p class="note">Labour work sheet for internal tracking.</p>
  </div>
</body></html>`;
  }

  function openLabourBoqWindow(l, seller, proj) {
    const w = window.open("", "_blank");
    if (!w) { message("Pop-up blocked — allow pop-ups for this site to open the labour sheet.", true); return; }
    w.document.open();
    w.document.write(labourBoqHtml(l, seller, proj));
    w.document.close();
    w.focus();
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
