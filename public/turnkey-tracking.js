// ============================================================================
// Safe Creatives — Project Tracking (admin)
// ============================================================================
//
// Pick a project → every quotation line becomes a tracking row
// (Category, Area, Product, Price). Set a Phase per row, Compute to order the
// rows by phase, then record up to 3 photos, a completion date and a status
// (Not started / In progress / Completed, default In progress). Save persists to
// turnkey_project_tracking; photos go to the public 'turnkey-tracking' bucket.
//
// Price = the quotation's "price with discount", computed live from each line's
// base total × the project margin (accessories use their per-line margin) ×
// discount — so it matches the quotation export.
//
// Needs migration 045. Admin only, like the quotation builder.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const bodyEl = document.querySelector("#tk-body");
  const projectRow = document.querySelector("#tk-project-row");
  const panel = document.querySelector("#tk-panel");
  const messageEl = document.querySelector("#tk-message");

  if (!SC.isAdmin) { denied.hidden = false; return; }
  bodyEl.hidden = false;

  const BUCKET = "turnkey-tracking";
  const STATUSES = [["not_started", "Not started"], ["in_progress", "In progress"], ["completed", "Completed"]];
  const MAX_PHOTOS = 3;

  // Quotation segments → tracking rows. `select` keeps the query light (no jsonb).
  const SEGMENTS = [
    { table: "turnkey_quote_box_units", category: "Box & Shutters", select: "id, space, unit_name, total_price", area: (r) => r.space, product: (r) => r.unit_name },
    { table: "turnkey_quote_wall_panels", category: "Wall Panels", select: "id, space, unit_name, panel_type, total_price", area: (r) => r.space, product: (r) => r.unit_name || r.panel_type },
    { table: "turnkey_quote_furniture", category: "Furniture", select: "id, space, unit_name, total_price", area: (r) => r.space, product: (r) => r.unit_name },
    { table: "turnkey_quote_accessories", category: "Accessories", perLineMargin: true, select: "id, unit_name, total_price, margin_percent", area: () => null, product: (r) => r.unit_name },
    { table: "turnkey_quote_paint", category: "Paint work", select: "id, space, description, total_price", area: (r) => r.space, product: (r) => r.description },
    { table: "turnkey_quote_civil", category: "Civil Work", select: "id, space, unit_name, total_price", area: (r) => r.space, product: (r) => r.unit_name },
    { table: "turnkey_quote_electrical", category: "Electrical Work", select: "id, space, unit_name, total_price", area: (r) => r.space, product: (r) => r.unit_name },
  ];

  // ---- small helpers -------------------------------------------------------
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function field(labelText, control) {
    const wrap = el("label", "admin-field");
    wrap.appendChild(el("span", null, labelText));
    wrap.appendChild(control);
    return wrap;
  }
  const money = (n) => (n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN"));
  const round2 = (n) => Math.round(n * 100) / 100;
  function message(text, isError) {
    messageEl.textContent = text || "";
    messageEl.className = `admin-message${isError ? " is-error" : text ? " is-ok" : ""}`;
  }

  let currentProject = null;
  let projectsById = new Map();

  // ---- data ----------------------------------------------------------------
  async function loadProjects() {
    const { data, error } = await sb
      .from("turnkey_projects")
      .select("id, project_number, client_name, project_name, margin_percent, discount_percent")
      .order("project_number", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // All quotation lines across the segments, as tracking rows (with live price).
  async function loadQuotationLines(project) {
    const margin = Number(project.margin_percent) || 0;
    const discount = Number(project.discount_percent) || 0;
    const out = [];
    for (const seg of SEGMENTS) {
      const { data, error } = await sb.from(seg.table).select(seg.select).eq("project_id", project.id);
      if (error) { if (/relation|column/i.test(error.message)) continue; throw error; }
      (data || []).forEach((r) => {
        const base = Number(r.total_price) || 0;
        const m = seg.perLineMargin && r.margin_percent != null && r.margin_percent !== "" ? Number(r.margin_percent) || 0 : margin;
        const price = round2(base * (1 + m / 100) * (1 - discount / 100));
        out.push({
          source_table: seg.table,
          source_id: r.id,
          category: seg.category,
          area: seg.area(r) || null,
          product: seg.product(r) || null,
          price,
        });
      });
    }
    return out;
  }

  async function loadTracking(projectId) {
    const { data, error } = await sb
      .from("turnkey_project_tracking")
      .select("id, source_table, source_id, phase, photos, completion_date, status, sort_order")
      .eq("project_id", projectId);
    if (error) throw error;
    return data || [];
  }

  const keyOf = (t, id) => `${t}:${id}`;
  const photoUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  // ---- render --------------------------------------------------------------
  async function render() {
    panel.textContent = "";
    if (!currentProject) { panel.appendChild(el("p", "dash-note", "Select a project above to begin.")); return; }
    panel.appendChild(el("p", "dash-note", "Loading…"));

    const project = projectsById.get(currentProject);
    let lines, tracking;
    try {
      [lines, tracking] = await Promise.all([loadQuotationLines(project), loadTracking(currentProject)]);
    } catch (error) {
      panel.textContent = "";
      panel.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If a table/bucket is missing, run migration 045.`));
      return;
    }
    panel.textContent = "";

    const savedByKey = new Map(tracking.map((t) => [keyOf(t.source_table, t.source_id), t]));
    const orphanIds = tracking
      .filter((t) => !lines.some((l) => l.source_table === t.source_table && l.source_id === t.source_id))
      .map((t) => t.id);

    // Working set = current lines merged with any saved tracking fields.
    const rows = lines.map((l) => {
      const s = savedByKey.get(keyOf(l.source_table, l.source_id));
      return {
        ...l,
        phase: s && s.phase != null ? s.phase : "",
        photos: s && Array.isArray(s.photos) ? [...s.photos] : [],
        completion_date: (s && s.completion_date) || "",
        status: (s && s.status) || "in_progress",
        _saved_sort: s && s.sort_order != null ? s.sort_order : null,
      };
    });
    // Initial order: any previously-saved sort order, else by phase, else as loaded.
    rows.sort((a, b) => {
      const sa = a._saved_sort == null ? Infinity : a._saved_sort;
      const sb2 = b._saved_sort == null ? Infinity : b._saved_sort;
      return sa - sb2;
    });

    const head = el("div", "admin-package");
    head.appendChild(el("p", "eyebrow", "PROJECT TRACKING"));
    head.appendChild(el("p", "dash-note", `Project #${project.project_number} — ${project.client_name}. Every quotation line below. Set a Phase for each, press Compute to order by phase, then record photos, completion date and status. Save to persist.`));
    panel.appendChild(head);

    if (!rows.length) {
      panel.appendChild(el("p", "dash-note", "No quotation lines for this project yet. Build the quotation first."));
      return;
    }

    const section = el("div", "tk-box-section");
    const scroll = el("div", "table-scroll");
    const table = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Category", "Area", "Product", "Price", "Phase", "Photos (up to 3)", "Date of completion", "Status"].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tbody = el("tbody");
    table.append(thead, tbody);
    scroll.appendChild(table);
    section.appendChild(scroll);

    const renderPhotoCell = (td, row) => {
      td.textContent = "";
      const gallery = el("div", "tk-photo-gallery");
      row.photos.forEach((path) => {
        const item = el("span", "tk-photo-item");
        const a = document.createElement("a");
        a.href = photoUrl(path); a.target = "_blank"; a.rel = "noopener";
        const img = document.createElement("img");
        img.src = photoUrl(path); img.alt = "progress photo"; img.className = "tk-photo-thumb";
        a.appendChild(img);
        const x = el("button", "tk-photo-del", "✕");
        x.type = "button"; x.title = "Remove photo";
        x.addEventListener("click", async () => {
          x.disabled = true;
          try { await sb.storage.from(BUCKET).remove([path]); } catch (_e) { /* best effort */ }
          row.photos = row.photos.filter((p) => p !== path);
          renderPhotoCell(td, row);
        });
        item.append(a, x);
        gallery.appendChild(item);
      });
      if (row.photos.length < MAX_PHOTOS) {
        const fileInput = document.createElement("input");
        fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.style.display = "none";
        const add = el("button", "admin-primary-small", "+ Photo");
        add.type = "button";
        add.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          add.disabled = true; add.textContent = "Uploading…";
          const path = `${currentProject}/${row.source_id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
          const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
          if (error) { message(`Photo upload failed: ${error.message}`, true); add.disabled = false; add.textContent = "+ Photo"; return; }
          row.photos.push(path);
          renderPhotoCell(td, row);
        });
        gallery.append(add, fileInput);
      }
      td.appendChild(gallery);
    };

    const drawRows = () => {
      tbody.textContent = "";
      rows.forEach((row) => {
        const tr = el("tr");
        [row.category || "—", row.area || "—", row.product || "—", money(row.price)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });

        const phaseTd = el("td");
        const phaseI = document.createElement("input");
        phaseI.type = "number"; phaseI.min = "1"; phaseI.step = "1"; phaseI.className = "grid-input"; phaseI.placeholder = "—";
        phaseI.style.maxWidth = "70px";
        phaseI.value = row.phase === "" || row.phase == null ? "" : row.phase;
        phaseI.addEventListener("input", () => { row.phase = phaseI.value; });
        phaseTd.appendChild(phaseI); tr.appendChild(phaseTd);

        const photoTd = el("td"); renderPhotoCell(photoTd, row); tr.appendChild(photoTd);

        const dateTd = el("td");
        const dateI = document.createElement("input");
        dateI.type = "date"; dateI.className = "grid-input";
        dateI.value = row.completion_date || "";
        dateI.addEventListener("change", () => { row.completion_date = dateI.value || ""; });
        dateTd.appendChild(dateI); tr.appendChild(dateTd);

        const statusTd = el("td");
        const statusSel = document.createElement("select");
        statusSel.className = "grid-input grid-select";
        STATUSES.forEach(([val, lab]) => statusSel.appendChild(new Option(lab, val)));
        statusSel.value = row.status || "in_progress";
        statusSel.addEventListener("change", () => { row.status = statusSel.value; });
        statusTd.appendChild(statusSel); tr.appendChild(statusTd);

        tbody.appendChild(tr);
      });
    };
    drawRows();

    const computeBtn = el("button", "admin-primary-small", "Compute (order by phase)");
    computeBtn.type = "button";
    computeBtn.addEventListener("click", () => {
      rows.sort((a, b) => {
        const pa = a.phase === "" || a.phase == null ? Infinity : Number(a.phase);
        const pb = b.phase === "" || b.phase == null ? Infinity : Number(b.phase);
        return pa - pb;
      });
      drawRows();
      message("Ordered by phase. Record photos / dates / status, then Save.");
    });

    const saveBtn = el("button", "admin-primary", "Save tracking");
    saveBtn.type = "button";
    const saveMsg = el("span", "admin-hint", "");
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true; saveMsg.textContent = "Saving…";
      const records = rows.map((r, i) => ({
        project_id: currentProject,
        source_table: r.source_table,
        source_id: r.source_id,
        category: r.category, area: r.area, product: r.product, price: r.price,
        phase: r.phase === "" || r.phase == null ? null : parseInt(r.phase, 10),
        photos: r.photos,
        completion_date: r.completion_date || null,
        status: r.status || "in_progress",
        sort_order: i,
      }));
      try {
        if (records.length) {
          const { error } = await sb.from("turnkey_project_tracking").upsert(records, { onConflict: "project_id,source_table,source_id" });
          if (error) throw error;
        }
        if (orphanIds.length) {
          const { error: delErr } = await sb.from("turnkey_project_tracking").delete().in("id", orphanIds);
          if (delErr) throw delErr;
        }
        saveMsg.textContent = `Saved — ${records.length} line${records.length === 1 ? "" : "s"}.`;
        message("Tracking saved.");
      } catch (e) {
        saveMsg.textContent = `Save failed: ${e.message}`;
      } finally {
        saveBtn.disabled = false;
      }
    });

    const actions = el("div", "admin-row-actions");
    actions.append(computeBtn, saveBtn, saveMsg);
    section.appendChild(actions);
    panel.appendChild(section);
  }

  function selectProject(id) {
    currentProject = id || null;
    if (currentProject) {
      const p = projectsById.get(currentProject);
      message(p ? `Project #${p.project_number} — ${p.client_name}` : "");
    } else {
      message("");
    }
    render();
  }

  // ---- boot ----------------------------------------------------------------
  const projectS = document.createElement("select");
  try {
    const projects = await loadProjects();
    projectsById = new Map(projects.map((p) => [p.id, p]));
    projectS.appendChild(el("option", null, projects.length ? "Select a project…" : "No projects yet"));
    projects.forEach((p) => {
      const o = el("option", null, `#${p.project_number} — ${p.client_name}` + (p.project_name ? ` — ${p.project_name}` : ""));
      o.value = p.id;
      projectS.appendChild(o);
    });
    projectRow.appendChild(field("Project", projectS));
    projectS.addEventListener("change", () => selectProject(projectS.value));

    const wanted = new URLSearchParams(location.search).get("project");
    if (wanted && projectsById.has(wanted)) { projectS.value = wanted; selectProject(wanted); }
    else { render(); }
  } catch (error) {
    message(`Could not load projects: ${error.message}`, true);
  }
})();
