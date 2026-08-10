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

    const actions = el("div", "admin-row-actions");
    actions.appendChild(addBtn);

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
