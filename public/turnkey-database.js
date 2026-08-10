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
        const inp = document.createElement("input");
        inp.type = c.type || "text";
        inp.className = "grid-input";
        inp.value = row[c.key] == null ? "" : row[c.key];
        if (c.placeholder) inp.placeholder = c.placeholder;
        inp.addEventListener("change", async () => {
          const value = inp.value.trim() === "" ? null : inp.value.trim();
          inp.disabled = true;
          const { error } = await sb.from(table).update({ [c.key]: value }).eq("id", row.id);
          inp.disabled = false;
          if (error) {
            message(`Could not save: ${error.message}`, true);
            inp.focus();
            return;
          }
          row[c.key] = value;
          message("Saved.");
        });
        td.appendChild(inp);
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
          (c) => normalizeHeader(c.label) === h || normalizeHeader(c.key) === h
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
        { key: "supplier", label: "Supplier" },
        { key: "company_name", label: "Company name" },
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

  const PANELS = {
    suppliers: suppliersPanel,
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
