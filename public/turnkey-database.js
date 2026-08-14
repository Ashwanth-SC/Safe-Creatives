// ============================================================================
// Safe Creatives — Turnkey database window
// ============================================================================
//
// The reference data behind the quotation builder, each table on its own tab.
// For now: the supplier list. Every table is an always-editable grid — add a
// row, edit any cell (saved on change), or delete a row.
//
// Needs migration 022-turnkey-database-suppliers.sql (turnkey_suppliers + RLS).
// Admin only, like the dashboard.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const bodyEl = document.querySelector("#db-body");
  const panel = document.querySelector("#db-panel");
  const messageEl = document.querySelector("#db-message");

  if (!SC.isAdmin) {
    denied.hidden = false;
    return;
  }
  bodyEl.hidden = false;

  function message(text, isError) {
    messageEl.textContent = text || "";
    messageEl.className = `admin-message${isError ? " is-error" : text ? " is-ok" : ""}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes ("")
  // and newlines inside quotes. Returns an array of string arrays.
  function parseCSV(text) {
    const rows = [];
    let row = [], field = "", inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += ch;
      } else if (ch === '"') inQuotes = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (ch !== "\r") field += ch;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  const normalizeHeader = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");

  // ------------------------------------------------------------------
  // Generic editable grid
  // ------------------------------------------------------------------
  // Renders a table for `table` with the given columns. Each cell is an input
  // that saves that one field on change; a footer button adds a blank row; each
  // row has a delete control. Built generically so the next reference tables
  // (labour, rate databases) can reuse it.

  function editableGrid({ table, columns, orderBy, deferSave }) {
    const defer = !!deferSave;
    const liveRows = [];   // defer mode: row objects currently shown
    const deletedIds = []; // defer mode: existing ids removed, committed on save

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table db-grid");

    const thead = el("thead");
    const hr = el("tr");
    columns.forEach((c) => hr.appendChild(el("th", null, c.label)));
    hr.appendChild(el("th", null, ""));
    thead.appendChild(hr);

    const tbody = el("tbody");
    t.append(thead, tbody);
    scroll.appendChild(t);

    const dirtyNote = el("span", "db-dirty", "");
    function markDirty() { if (defer) dirtyNote.textContent = "Unsaved changes"; }
    function markClean() { dirtyNote.textContent = ""; }
    function rowPayload(r) {
      const p = {};
      columns.forEach((c) => {
        if (c.readonly) return;
        const v = r[c.key];
        p[c.key] = v == null || v === "" ? null : v;
      });
      return p;
    }

    function makeRow(row) {
      const tr = el("tr");
      columns.forEach((c) => {
        const td = el("td");
        if (c.readonly) {
          // Computed / non-editable cell (e.g. generated area). Shown as text.
          const v = row[c.key];
          td.className = "db-readonly";
          td.textContent = v == null || v === "" ? "—" : v;
          tr.appendChild(td);
          return;
        }
        let control;
        if (c.type === "select") {
          // Dropdown cell — options come from the column config. Any value not
          // in the list (e.g. imported) is kept as an extra option so it shows.
          control = document.createElement("select");
          control.className = "grid-input grid-select";
          control.appendChild(new Option("—", ""));
          const opts = (c.options || []).slice();
          const cur = row[c.key];
          if (cur != null && cur !== "" && !opts.includes(cur)) opts.unshift(cur);
          opts.forEach((o) => control.appendChild(new Option(o, o)));
          control.value = cur == null ? "" : cur;
        } else {
          control = document.createElement("input");
          control.type = c.type || "text";
          control.className = "grid-input";
          control.value = row[c.key] == null ? "" : row[c.key];
          if (c.placeholder) control.placeholder = c.placeholder;
        }
        control.addEventListener("change", async () => {
          const value = String(control.value).trim() === "" ? null : String(control.value).trim();
          if (defer) {
            row[c.key] = value;
            if (!row.__new) row.__dirty = true;
            markDirty();
            return;
          }
          control.disabled = true;
          const { error } = await sb.from(table).update({ [c.key]: value }).eq("id", row.id);
          control.disabled = false;
          if (error) {
            message(`Could not save: ${error.message}`, true);
            control.focus();
            return;
          }
          row[c.key] = value;
          message("Saved.");
        });
        td.appendChild(control);
        tr.appendChild(td);
      });

      const delTd = el("td", "db-grid-del");
      const del = el("button", "tk-delete-link", "✕");
      del.type = "button";
      del.title = "Delete this row";
      del.addEventListener("click", async () => {
        if (!window.confirm("Delete this row?" + (defer ? "" : " This cannot be undone."))) return;
        if (defer) {
          if (row.id && !row.__new) deletedIds.push(row.id);
          const idx = liveRows.indexOf(row);
          if (idx >= 0) liveRows.splice(idx, 1);
          tr.remove();
          if (!tbody.children.length) tbody.appendChild(emptyRow());
          markDirty();
          return;
        }
        del.disabled = true;
        const { error } = await sb.from(table).delete().eq("id", row.id);
        if (error) {
          del.disabled = false;
          message(`Could not delete: ${error.message}`, true);
          return;
        }
        tr.remove();
        if (!tbody.children.length) tbody.appendChild(emptyRow());
        message("Row deleted.");
      });
      delTd.appendChild(del);
      tr.appendChild(delTd);
      return tr;
    }

    function emptyRow() {
      const tr = el("tr", "db-empty-row");
      const td = el("td", "dash-empty", "No rows yet — add one below.");
      td.colSpan = columns.length + 1;
      tr.appendChild(td);
      return tr;
    }

    async function load(filters) {
      let query = sb.from(table).select("*");
      if (filters) {
        Object.entries(filters).forEach(([k, v]) => {
          if (v) query = query.eq(k, v);
        });
      }
      if (orderBy) query = query.order(orderBy, { ascending: true });
      const { data, error } = await query;
      if (error) throw error;
      tbody.textContent = "";
      const rows = data || [];
      if (defer) { liveRows.length = 0; deletedIds.length = 0; markClean(); }
      if (!rows.length) tbody.appendChild(emptyRow());
      else rows.forEach((row) => { if (defer) liveRows.push(row); tbody.appendChild(makeRow(row)); });
    }

    const addBtn = el("button", "admin-primary", "+ Add row");
    addBtn.type = "button";
    addBtn.addEventListener("click", async () => {
      if (defer) {
        const row = { __new: true };
        liveRows.push(row);
        const empty = tbody.querySelector(".db-empty-row");
        if (empty) empty.remove();
        const tr = makeRow(row);
        tbody.appendChild(tr);
        const first = tr.querySelector("input,select");
        if (first) first.focus();
        markDirty();
        return;
      }
      addBtn.disabled = true;
      const { data, error } = await sb.from(table).insert({}).select("*").single();
      addBtn.disabled = false;
      if (error) return void message(`Could not add row: ${error.message}`, true);
      const empty = tbody.querySelector(".db-empty-row");
      if (empty) empty.remove();
      const tr = makeRow(data);
      tbody.appendChild(tr);
      const first = tr.querySelector("input,select");
      if (first) first.focus();
      message("Row added — fill it in.");
    });

    // --- Import CSV (append only — never edits or removes existing rows) ----
    const importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".csv,text/csv";
    importInput.style.display = "none";

    const importBtn = el("button", "admin-primary-small", "Import CSV");
    importBtn.type = "button";
    importBtn.addEventListener("click", () => importInput.click());

    importInput.addEventListener("change", async () => {
      const file = importInput.files && importInput.files[0];
      importInput.value = ""; // let the same file be picked again later
      if (!file) return;

      let text;
      try {
        text = await file.text();
      } catch {
        return void message("Could not read the file.", true);
      }

      const grid = parseCSV(text).filter((r) => r.some((c) => String(c).trim() !== ""));
      if (grid.length < 2) return void message("The CSV has no data rows.", true);

      // Map each CSV column (by header) to one of our fields; ignore the rest.
      const headers = grid[0].map(normalizeHeader);
      const idxToKey = {};
      headers.forEach((h, i) => {
        const col = columns.find(
          (c) =>
            !c.readonly &&
            (normalizeHeader(c.label) === h ||
              normalizeHeader(c.key) === h ||
              (c.aliases || []).some((a) => normalizeHeader(a) === h))
        );
        if (col) idxToKey[i] = col.key;
      });
      if (!Object.keys(idxToKey).length) {
        return void message(
          `No columns matched. The CSV's first row should be headers like: ${columns
            .map((c) => c.label)
            .join(", ")}.`,
          true
        );
      }

      const payloads = grid
        .slice(1)
        .map((r) => {
          const obj = {};
          r.forEach((val, i) => {
            const key = idxToKey[i];
            if (!key) return;
            const v = String(val).trim();
            if (v !== "") obj[key] = v;
          });
          return obj;
        })
        .filter((obj) => Object.keys(obj).length > 0);

      if (!payloads.length) return void message("No filled-in rows found in the CSV.", true);
      if (
        !window.confirm(
          `Add ${payloads.length} row(s) from “${file.name}”?` +
            (defer ? " They save when you click Save changes." : " Existing rows won't be changed.")
        )
      )
        return;

      const empty = tbody.querySelector(".db-empty-row");
      if (empty) empty.remove();

      if (defer) {
        payloads.forEach((p) => {
          const row = { __new: true, ...p };
          liveRows.push(row);
          tbody.appendChild(makeRow(row));
        });
        markDirty();
        message(`Added ${payloads.length} row(s) from ${file.name} — not saved yet.`);
        return;
      }

      importBtn.disabled = true;
      const { data, error } = await sb.from(table).insert(payloads).select("*");
      importBtn.disabled = false;
      if (error) return void message(`Import failed: ${error.message}`, true);
      (data || []).forEach((row) => tbody.appendChild(makeRow(row)));
      message(`Appended ${data ? data.length : payloads.length} row(s) from ${file.name}.`);
    });

    const actions = el("div", "admin-row-actions");
    actions.append(addBtn, importBtn, importInput);

    if (defer) {
      const saveBtn = el("button", "admin-primary", "Save changes");
      saveBtn.type = "button";
      saveBtn.addEventListener("click", async () => {
        saveBtn.disabled = true;
        try {
          const inserts = liveRows.filter((r) => r.__new).map(rowPayload);
          if (inserts.length) {
            const { error } = await sb.from(table).insert(inserts);
            if (error) throw error;
          }
          const updates = liveRows.filter((r) => r.id && r.__dirty);
          for (const r of updates) {
            const { error } = await sb.from(table).update(rowPayload(r)).eq("id", r.id);
            if (error) throw error;
          }
          if (deletedIds.length) {
            const { error } = await sb.from(table).delete().in("id", deletedIds);
            if (error) throw error;
          }
          await load();
          message("Changes saved.");
        } catch (saveError) {
          message(`Save failed: ${saveError.message}`, true);
        }
        saveBtn.disabled = false;
      });
      actions.append(saveBtn, dirtyNote);
    }

    const frag = document.createDocumentFragment();
    frag.append(scroll, actions);
    return { frag, load };
  }

  // ------------------------------------------------------------------
  // Panels
  // ------------------------------------------------------------------

  async function suppliersPanel() {
    const grid = editableGrid({
      table: "turnkey_suppliers",
      orderBy: "created_at",
      columns: [
        { key: "supplier_company_name", label: "Supplier company name" },
        { key: "spoc", label: "SPOC" },
        { key: "spoc_contact", label: "SPOC contact" },
        { key: "spoc_mail", label: "SPOC mail ID" },
        { key: "address", label: "Address" },
        { key: "gst_number", label: "GST number" },
      ],
    });
    const wrap = document.createDocumentFragment();
    wrap.appendChild(
      el("p", "dash-note", "Your suppliers/vendors. Add a row, edit any cell (saved as you go), or delete a row.")
    );
    wrap.appendChild(grid.frag);
    await grid.load();
    return wrap;
  }

  async function loadCategoryList(table) {
    const { data, error } = await sb
      .from(table)
      .select("id, name")
      .order("name", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // Distinct supplier names (from the Supplier database) for the products
  // Supplier dropdown and the supplier filter.
  async function loadSupplierNames() {
    const { data, error } = await sb
      .from("turnkey_suppliers")
      .select("supplier_company_name")
      .order("supplier_company_name", { ascending: true });
    if (error) throw error;
    return [...new Set((data || []).map((s) => s.supplier_company_name).filter(Boolean))];
  }

  // A labelled "All / …" filter dropdown.
  function filterSelect(labelText, options) {
    const wrap = el("label", "admin-field");
    wrap.appendChild(el("span", null, labelText));
    const select = document.createElement("select");
    select.appendChild(new Option("All", ""));
    options.forEach((o) => select.appendChild(new Option(o, o)));
    wrap.appendChild(select);
    return { wrap, select };
  }

  // Reusable add/delete manager for a dropdown's options (product categories,
  // labour categories, ...). `table` is the options table, `tab` the panel to
  // reload after a change.
  function renderCategoryManager(cats, { table, tab, label, placeholder }) {
    const box = el("div", "tk-cat-manager");
    box.appendChild(el("span", "admin-field-label", label));

    const chips = el("div", "tk-chips");
    if (!cats.length) chips.appendChild(el("span", "dash-note", "None yet — add one below."));
    cats.forEach((cat) => {
      const chip = el("span", "tk-cat-chip");
      chip.appendChild(el("span", null, cat.name));
      const x = el("button", "tk-cat-x", "✕");
      x.type = "button";
      x.title = "Delete";
      x.addEventListener("click", async () => {
        if (!window.confirm(`Delete “${cat.name}”? Rows already using it keep the value.`)) return;
        const { error } = await sb.from(table).delete().eq("id", cat.id);
        if (error) return void message(`Could not delete: ${error.message}`, true);
        show(tab);
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    box.appendChild(chips);

    const addWrap = el("div", "tk-space-add");
    const addI = document.createElement("input");
    addI.type = "text";
    addI.placeholder = placeholder;
    const addBtn = el("button", "admin-primary-small", "Add");
    addBtn.type = "button";
    const add = async () => {
      const name = addI.value.trim();
      if (!name) return;
      addBtn.disabled = true;
      const { error } = await sb.from(table).insert({ name });
      addBtn.disabled = false;
      if (error)
        return void message(
          /duplicate|unique/i.test(error.message) ? "That entry already exists." : `Could not add: ${error.message}`,
          true
        );
      show(tab);
    };
    addBtn.addEventListener("click", add);
    addI.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); add(); }
    });
    addWrap.append(addI, addBtn);
    box.appendChild(addWrap);
    return box;
  }

  async function productsPanel() {
    const [cats, supplierNames] = await Promise.all([
      loadCategoryList("turnkey_product_categories"),
      loadSupplierNames(),
    ]);
    const catNames = cats.map((c) => c.name);

    const grid = editableGrid({
      table: "turnkey_products",
      orderBy: "created_at",
      deferSave: true, // products save in a batch on "Save changes"
      columns: [
        { key: "supplier", label: "Supplier", type: "select", options: supplierNames, aliases: ["supplier company name"] },
        { key: "product_name", label: "Product name" },
        { key: "brand", label: "Brand" },
        { key: "category", label: "Product category", type: "select", options: catNames },
        { key: "sub_category", label: "Sub category", aliases: ["subcategory"] },
        { key: "std_width", label: "Standard width", type: "number", aliases: ["std width"] },
        { key: "std_height", label: "Standard height", type: "number", aliases: ["std height"] },
        { key: "area_sqft", label: "Area (sqft)", readonly: true },
        { key: "thickness", label: "Thickness" },
        { key: "price_per_sqft", label: "Price/sqft", type: "number", aliases: ["cost/sqft", "cost per sqft", "price per sqft"] },
      ],
    });

    const wrap = document.createDocumentFragment();
    wrap.appendChild(
      el(
        "p",
        "dash-note",
        "Your product specs and pricing. Manage the categories below (they fill the Product category dropdown), then add rows, edit cells, or import a CSV."
      )
    );
    wrap.appendChild(
      renderCategoryManager(cats, {
        table: "turnkey_product_categories",
        tab: "products",
        label: "Product categories",
        placeholder: "Add a category (e.g. Plywood)",
      })
    );

    // Filters — narrow the grid by supplier and/or category (server-side).
    const filters = { supplier: "", category: "" };
    const supplierF = filterSelect("Filter by supplier", supplierNames);
    const categoryF = filterSelect("Filter by category", catNames);
    supplierF.select.addEventListener("change", () => {
      filters.supplier = supplierF.select.value;
      grid.load(filters);
    });
    categoryF.select.addEventListener("change", () => {
      filters.category = categoryF.select.value;
      grid.load(filters);
    });
    const filterRow = el("div", "tk-filter-row");
    filterRow.append(supplierF.wrap, categoryF.wrap);
    wrap.appendChild(filterRow);

    wrap.appendChild(grid.frag);
    await grid.load(filters);
    return wrap;
  }

  async function labourPanel() {
    const cats = await loadCategoryList("turnkey_labour_categories");
    const catNames = cats.map((c) => c.name);

    const grid = editableGrid({
      table: "turnkey_labour",
      orderBy: "created_at",
      columns: [
        { key: "category", label: "Labour category", type: "select", options: catNames },
        { key: "name", label: "Name" },
        { key: "contact_number", label: "Contact number", aliases: ["contact", "phone", "spoc contact"] },
        { key: "cost_per_day", label: "Cost per day", type: "number", aliases: ["cost/day", "cost per day"] },
        { key: "cost_per_sqft", label: "Cost per sqft", type: "number", aliases: ["cost/sqft", "cost per sqft"] },
      ],
    });

    const wrap = document.createDocumentFragment();
    wrap.appendChild(
      el(
        "p",
        "dash-note",
        "Your labourers/contractors and their rates. Manage the labour categories below (they fill the Labour category dropdown), then add rows, edit cells, or import a CSV."
      )
    );
    wrap.appendChild(
      renderCategoryManager(cats, {
        table: "turnkey_labour_categories",
        tab: "labour",
        label: "Labour categories",
        placeholder: "Add a category (e.g. Carpenter)",
      })
    );
    wrap.appendChild(grid.frag);
    await grid.load();
    return wrap;
  }

  async function hardwaresPanel() {
    const cats = await loadCategoryList("turnkey_hardware_categories");
    const catNames = cats.map((c) => c.name);

    const grid = editableGrid({
      table: "turnkey_hardwares",
      orderBy: "created_at",
      columns: [
        { key: "supplier", label: "Supplier" },
        { key: "product_name", label: "Product name" },
        { key: "category", label: "Product category", type: "select", options: catNames },
        { key: "size", label: "Size" },
        { key: "price", label: "Price", type: "number" },
      ],
    });

    const wrap = document.createDocumentFragment();
    wrap.appendChild(
      el(
        "p",
        "dash-note",
        "Handles, hinges, drawer channels and other hardware. Manage the categories below (they fill the Product category dropdown), then add rows, edit cells, or import a CSV."
      )
    );
    wrap.appendChild(
      renderCategoryManager(cats, {
        table: "turnkey_hardware_categories",
        tab: "hardwares",
        label: "Hardware categories",
        placeholder: "Add a category (e.g. Edge hinges)",
      })
    );
    wrap.appendChild(grid.frag);
    await grid.load();
    return wrap;
  }

  const PANELS = {
    suppliers: suppliersPanel,
    products: productsPanel,
    labour: labourPanel,
    hardwares: hardwaresPanel,
  };

  async function show(tab) {
    panel.textContent = "";
    panel.appendChild(el("p", "dash-note", "Loading…"));
    try {
      const content = await PANELS[tab]();
      panel.textContent = "";
      panel.appendChild(content);
      message("");
    } catch (error) {
      panel.textContent = "";
      message(
        `Could not load: ${error.message}. If this says the table does not exist or permission denied, run migration 022-turnkey-database-suppliers.sql in Supabase.`,
        true
      );
    }
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("is-active", b === btn));
      show(btn.dataset.tab);
    });
  });

  await show("suppliers");
})();
