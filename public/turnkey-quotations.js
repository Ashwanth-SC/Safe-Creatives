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

  // A wrapping checkbox group for choosing several categories. Returns the DOM
  // box and a live Set of the ticked values.
  function categoryMultiSelect(options, preselected, onChange) {
    const selected = new Set((preselected || []).filter(Boolean));
    const box = el("div", "tk-cat-multi");
    if (!options.length) box.appendChild(el("span", "dash-note", "No categories — add them in the database."));
    options.forEach((name) => {
      const lab = el("label", "tk-cat-check");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(name);
      cb.addEventListener("change", () => {
        if (cb.checked) selected.add(name);
        else selected.delete(name);
        onChange();
      });
      lab.append(cb, el("span", null, name));
      box.appendChild(lab);
    });
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
      .select("id, product_name, category, area_sqft, price_per_sqft");
    if (error) throw error;
    return data || [];
  }
  async function loadBoxUnits(projectId) {
    const { data, error } = await sb
      .from("turnkey_quote_box_units")
      .select("id, space, unit_name, total_material_price, created_at")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }
  async function loadBoxUnit(unitId) {
    const [{ data: unit, error: e1 }, { data: groups, error: e2 }] = await Promise.all([
      sb.from("turnkey_quote_box_units").select("*").eq("id", unitId).single(),
      sb.from("turnkey_quote_box_groups").select("*").eq("unit_id", unitId),
    ]);
    if (e1) throw e1;
    if (e2) throw e2;
    return { unit, groups: groups || [] };
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
    let spaces, categories, products, units;
    try {
      [spaces, categories, products, units] = await Promise.all([
        loadSelectedSpaces(currentProject),
        loadProductCategories(),
        loadProducts(),
        loadBoxUnits(currentProject),
      ]);
    } catch (error) {
      container.textContent = "";
      container.appendChild(
        el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table, run migration 027.`)
      );
      return;
    }
    const ref = { spaces, categories, products };
    container.textContent = "";
    container.appendChild(unitEditor(ref, null, () => renderBoxShutters(container)));
    container.appendChild(unitsList(units, () => renderBoxShutters(container)));
  }

  // The add / edit form for one unit. `existing` = a loaded unit to edit.
  function unitEditor(ref, existing, onSaved) {
    const block = el("details", "admin-package tk-add");
    block.open = !existing;
    block.appendChild(el("summary", null, existing ? `Edit unit — ${existing.unit.unit_name || "unnamed"}` : "Add a unit"));

    // State
    let csvText = existing?.unit.csv_text || "";
    let groups = []; // [{thickness, panel_count, group_area_sqft, ...computed}]
    let unitId = existing?.unit.id || null;
    const sel = {}; // thickness -> { material_id, laminate_id }
    if (existing) {
      existing.groups.forEach((g) => {
        sel[g.thickness] = { material_id: g.material_product_id || "", laminate_id: g.laminate_product_id || "" };
      });
    }

    // Top inputs
    const spaceS = selectEl(ref.spaces, existing?.unit.space || "", ref.spaces.length ? "Select area…" : "No spaces — set them up first");
    const nameI = document.createElement("input");
    nameI.type = "text";
    nameI.placeholder = "Unit name (e.g. Aurem wardrobe)";
    if (existing?.unit.unit_name) nameI.value = existing.unit.unit_name;

    // Multiple material / laminate categories may be ticked; the per-group
    // product dropdowns then list products from any of them.
    const matCat = categoryMultiSelect(ref.categories, splitCats(existing?.unit.material_category), () => renderGroups());
    const lamCat = categoryMultiSelect(ref.categories, splitCats(existing?.unit.laminate_category), () => renderGroups());

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

    const catRow = el("div", "tk-cat-row");
    catRow.append(labeledBlock("Material categories", matCat.box), labeledBlock("Laminate categories", lamCat.box));

    const groupsWrap = el("div", "tk-box-groups");
    const totalEl = el("p", "tk-box-total");
    const msg = el("p", "admin-hint", "");

    // Products in any of the ticked categories, as [id, label] options.
    const productOptions = (categorySet) =>
      ref.products
        .filter((p) => categorySet.has(p.category))
        .map((p) => [p.id, `${p.product_name || "unnamed"}${p.price_per_sqft != null ? ` — ₹${p.price_per_sqft}/sqft` : ""}`]);

    function renderGroups() {
      groupsWrap.textContent = "";
      if (!groups.length) {
        groupsWrap.appendChild(el("p", "dash-note", "Import a cutlist CSV to see the thickness groups."));
        return;
      }
      const matOpts = productOptions(matCat.selected);
      const lamOpts = productOptions(lamCat.selected);
      groups.forEach((g) => {
        const t = g.thickness;
        if (!sel[t]) sel[t] = { material_id: "", laminate_id: "" };
        const rowEl = el("div", "tk-box-group");
        rowEl.appendChild(
          el("div", "tk-box-group-head", `${t} mm · ${g.panel_count} panel(s) · ${g.group_area_sqft} sqft`)
        );

        const matS = selectEl(matOpts, sel[t].material_id, "Select material…");
        matS.addEventListener("change", () => { sel[t].material_id = matS.value; });
        const lamS = selectEl(lamOpts, sel[t].laminate_id, "Select laminate…");
        lamS.addEventListener("change", () => { sel[t].laminate_id = lamS.value; });
        const pick = el("div", "admin-inline");
        pick.append(field("Material", matS), field("Laminate", lamS));
        rowEl.appendChild(pick);

        if (g.plywood_qty != null || g.laminate_qty != null) {
          const out = el("div", "tk-box-out");
          out.appendChild(el("span", null, `Plywood: ${g.plywood_qty ?? "—"} sheet(s) → ${money(g.plywood_price)}`));
          out.appendChild(el("span", null, `Laminate: ${g.laminate_qty ?? "—"} sheet(s) → ${money(g.laminate_price)}`));
          rowEl.appendChild(out);
        }
        groupsWrap.appendChild(rowEl);
      });
    }

    async function firstCompute() {
      msg.textContent = "Reading cutlist…";
      try {
        const res = await computeUnit({ csv_text: csvText });
        groups = res.groups;
        totalEl.textContent = "";
        renderGroups();
        msg.textContent = "";
      } catch (error) {
        msg.textContent = `Could not read the cutlist: ${error.message}`;
      }
    }

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      fileInput.value = "";
      if (!file) return;
      csvText = await file.text();
      await firstCompute();
    });

    function selectionsPayload() {
      const out = {};
      groups.forEach((g) => {
        const s = sel[g.thickness] || {};
        out[g.thickness] = { material_id: s.material_id || null, laminate_id: s.laminate_id || null };
      });
      return out;
    }

    const computeBtn = el("button", "admin-primary-small", "Compute material");
    computeBtn.type = "button";
    computeBtn.addEventListener("click", async () => {
      if (!groups.length) return void (msg.textContent = "Import a cutlist first.");
      computeBtn.disabled = true;
      msg.textContent = "Computing…";
      try {
        const res = await computeUnit({ csv_text: csvText, groups: selectionsPayload() });
        groups = res.groups;
        renderGroups();
        totalEl.textContent = `Total material price: ${money(res.total_material_price)}`;
        msg.textContent = "";
      } catch (error) {
        msg.textContent = `Compute failed: ${error.message}`;
      }
      computeBtn.disabled = false;
    });

    const saveBtn = el("button", "admin-primary", existing ? "Save changes" : "Save unit");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      if (!groups.length) return void (msg.textContent = "Import a cutlist first.");
      saveBtn.disabled = true;
      msg.textContent = "Saving…";
      try {
        const res = await computeUnit({
          save: true,
          unit_id: unitId,
          project_id: currentProject,
          space: spaceS.value || null,
          unit_name: nameI.value.trim() || null,
          csv_text: csvText,
          material_category: [...matCat.selected].join(", ") || null,
          laminate_category: [...lamCat.selected].join(", ") || null,
          groups: selectionsPayload(),
        });
        unitId = res.unit_id;
        groups = res.groups;
        renderGroups();
        totalEl.textContent = `Total material price: ${money(res.total_material_price)}`;
        message(`Saved ${nameI.value.trim() || "unit"} — ${money(res.total_material_price)}.`);
        onSaved();
      } catch (error) {
        msg.textContent = `Save failed: ${error.message}`;
      }
      saveBtn.disabled = false;
    });

    const actions = el("div", "admin-row-actions");
    actions.append(computeBtn, saveBtn);
    block.append(grid, catRow, groupsWrap, totalEl, actions, msg);

    // If editing, load the CSV-derived groups immediately.
    if (existing && csvText) firstCompute().then(renderGroups);
    else renderGroups();
    return block;
  }

  function unitsList(units, onChanged) {
    const wrap = document.createDocumentFragment();
    wrap.appendChild(el("p", "dash-note", "Box & Shutters units in this project. Open to edit, or delete."));
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Area", "Unit", "Material total", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    if (!units.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No units yet.");
      td.colSpan = 4;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    units.forEach((u) => {
      const open = el("button", "tk-email-link", "Open");
      open.type = "button";
      open.addEventListener("click", async () => {
        try {
          const existing = await loadBoxUnit(u.id);
          const ref = {
            spaces: await loadSelectedSpaces(currentProject),
            categories: await loadProductCategories(),
            products: await loadProducts(),
          };
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

      const cells = [u.space || "—", u.unit_name || "—", money(u.total_material_price), actions];
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
