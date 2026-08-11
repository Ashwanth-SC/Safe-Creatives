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

  function editableGrid({ table, columns, orderBy }) {
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

    function makeRow(row) {
      const tr = el("tr");
      columns.forEach((c) => {
        const td = el("td");
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
        if (!window.confirm("Delete this row? This cannot be undone.")) return;
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

    async function load() {
      let query = sb.from(table).select("*");
      if (orderBy) query = query.order(orderBy, { ascending: true });
      const { data, error } = await query;
      if (error) throw error;
      tbody.textContent = "";
      const rows = data || [];
      if (!rows.length) tbody.appendChild(emptyRow());
      else rows.forEach((row) => tbody.appendChild(makeRow(row)));
    }

    const addBtn = el("button", "admin-primary", "+ Add row");
    addBtn.type = "button";
    addBtn.addEventListener("click", async () => {
      addBtn.disabled = true;
      const { data, error } = await sb.from(table).insert({}).select("*").single();
      addBtn.disabled = false;
      if (error) return void message(`Could not add row: ${error.message}`, true);
      const empty = tbody.querySelector(".db-empty-row");
      if (empty) empty.remove();
      const tr = makeRow(data);
      tbody.appendChild(tr);
      const first = tr.querySelector("input");
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
            normalizeHeader(c.label) === h ||
            normalizeHeader(c.key) === h ||
            (c.aliases || []).some((a) => normalizeHeader(a) === h)
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
          `Append ${payloads.length} row(s) from “${file.name}”? Existing rows won't be changed.`
        )
      )
        return;

      importBtn.disabled = true;
      const { data, error } = await sb.from(table).insert(payloads).select("*");
      importBtn.disabled = false;
      if (error) return void message(`Import failed: ${error.message}`, true);

      const empty = tbody.querySelector(".db-empty-row");
      if (empty) empty.remove();
      (data || []).forEach((row) => tbody.appendChild(makeRow(row)));
      message(`Appended ${data ? data.length : payloads.length} row(s) from ${file.name}.`);
    });

    const actions = el("div", "admin-row-actions");
    actions.append(addBtn, importBtn, importInput);

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

  async function loadCategories() {
    const { data, error } = await sb
      .from("turnkey_product_categories")
      .select("id, name")
      .order("name", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // The add/delete manager for the Product category dropdown options.
  function renderCategoryManager(cats) {
    const box = el("div", "tk-cat-manager");
    box.appendChild(el("span", "admin-field-label", "Product categories"));

    const chips = el("div", "tk-chips");
    if (!cats.length) chips.appendChild(el("span", "dash-note", "No categories yet — add one below."));
    cats.forEach((cat) => {
      const chip = el("span", "tk-cat-chip");
      chip.appendChild(el("span", null, cat.name));
      const x = el("button", "tk-cat-x", "✕");
      x.type = "button";
      x.title = "Delete category";
      x.addEventListener("click", async () => {
        if (!window.confirm(`Delete the category “${cat.name}”? Products already using it keep the value.`)) return;
        const { error } = await sb.from("turnkey_product_categories").delete().eq("id", cat.id);
        if (error) return void message(`Could not delete: ${error.message}`, true);
        show("products");
      });
      chip.appendChild(x);
      chips.appendChild(chip);
    });
    box.appendChild(chips);

    const addWrap = el("div", "tk-space-add");
    const addI = document.createElement("input");
    addI.type = "text";
    addI.placeholder = "Add a category (e.g. Plywood)";
    const addBtn = el("button", "admin-primary-small", "Add category");
    addBtn.type = "button";
    const add = async () => {
      const name = addI.value.trim();
      if (!name) return;
      addBtn.disabled = true;
      const { error } = await sb.from("turnkey_product_categories").insert({ name });
      addBtn.disabled = false;
      if (error)
        return void message(
          /duplicate|unique/i.test(error.message) ? "That category already exists." : `Could not add: ${error.message}`,
          true
        );
      show("products");
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
    const cats = await loadCategories();
    const catNames = cats.map((c) => c.name);

    const grid = editableGrid({
      table: "turnkey_products",
      orderBy: "created_at",
      columns: [
        { key: "supplier", label: "Supplier" },
        { key: "product_name", label: "Product name", aliases: ["brand name"] },
        { key: "category", label: "Product category", type: "select", options: catNames },
        { key: "std_width", label: "Standard width", type: "number", aliases: ["std width"] },
        { key: "std_height", label: "Standard height", type: "number", aliases: ["std height"] },
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
    wrap.appendChild(renderCategoryManager(cats));
    wrap.appendChild(grid.frag);
    await grid.load();
    return wrap;
  }

  const PANELS = {
    suppliers: suppliersPanel,
    products: productsPanel,
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
