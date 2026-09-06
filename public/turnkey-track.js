// ============================================================================
// Safe Creatives — Customer project tracking
// ============================================================================
//
// A signed-in customer whose email matches a turnkey project (client_email set
// by staff) sees their project's build progress, read-only:
//   * Summary — overall progress bar (weighted by each line's cost vs the total
//     project value), a progress ring per phase, and status counts.
//   * Detail  — every tracked line grouped by phase, with status, completion
//     date and site photos (click to enlarge).
//
// Data comes from turnkey_my_projects() (safe columns) + the customer-read RLS
// on turnkey_project_tracking (migration 046). Photos are public URLs.
// ============================================================================

(async function () {
  await SC.ready;

  const body = document.querySelector("#ctrk-body");
  const projectRow = document.querySelector("#ctrk-project-row");
  const panel = document.querySelector("#ctrk-panel");
  const messageEl = document.querySelector("#ctrk-message");
  const lightbox = document.querySelector("#ctrk-lightbox");

  const BUCKET = "turnkey-tracking";
  const STATUS_LABEL = { not_started: "Not started", in_progress: "In progress", completed: "Completed" };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  const money = (n) => (n == null ? "—" : "₹" + Math.round(Number(n)).toLocaleString("en-IN"));
  const round1 = (n) => Math.round(n * 10) / 10;
  const photoUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  // Customer-friendly labels for the turnkey dashboard status values.
  const STATUS_FRIENDLY = {
    "lead": "Enquiry received",
    "closed": "Confirmed",
    "design initiated": "Design in progress",
    "dso": "Design sign-off",
    "execution commenced": "Execution in progress",
    "handed over": "Handed over",
  };
  const statusLabel = (s) => {
    const key = (s || "").trim().toLowerCase();
    return STATUS_FRIENDLY[key] || (s && String(s).trim()) || "In progress";
  };
  function message(text, isError) {
    messageEl.textContent = text || "";
    messageEl.className = `admin-message${isError ? " is-error" : text ? " is-ok" : ""}`;
  }

  // ---- lightbox ------------------------------------------------------------
  const lbImg = lightbox.querySelector("img");
  function openLightbox(url) { lbImg.src = url; lightbox.hidden = false; }
  function closeLightbox() { lightbox.hidden = true; lbImg.src = ""; }
  lightbox.querySelector(".ctrk-lightbox-close").addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !lightbox.hidden) closeLightbox(); });

  // ---- data ----------------------------------------------------------------
  async function loadMyProjects() {
    const { data, error } = await sb.rpc("turnkey_my_projects");
    if (error) throw error;
    return data || [];
  }
  async function loadTracking(projectId) {
    const { data, error } = await sb
      .from("turnkey_project_tracking")
      .select("id, category, area, product, price, phase, photos, completion_date, status, sort_order, updated_at")
      .eq("project_id", projectId)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // ---- progress ring (SVG donut) ------------------------------------------
  function ring(pct, label, sub) {
    const r = 26, circ = 2 * Math.PI * r, off = circ * (1 - Math.max(0, Math.min(100, pct)) / 100);
    const wrap = el("div", "ctrk-ring-wrap");
    wrap.innerHTML =
      `<svg viewBox="0 0 64 64" class="ctrk-ring" role="img" aria-label="${label}: ${Math.round(pct)}%">
        <circle cx="32" cy="32" r="${r}" class="ctrk-ring-bg"></circle>
        <circle cx="32" cy="32" r="${r}" class="ctrk-ring-fg" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 32 32)"></circle>
        <text x="32" y="36" class="ctrk-ring-pct">${Math.round(pct)}%</text>
      </svg>
      <span class="ctrk-ring-label">${label}</span>` +
      (sub ? `<span class="ctrk-ring-sub">${sub}</span>` : "");
    return wrap;
  }

  // ---- render one project --------------------------------------------------
  async function renderProject(project) {
    panel.textContent = "";
    panel.appendChild(el("p", "dash-note", "Loading…"));
    let rows;
    try { rows = await loadTracking(project.id); }
    catch (error) { panel.textContent = ""; panel.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}`)); return; }
    panel.textContent = "";

    // ---- Project header (always shown, carries the dashboard status) -------
    const summary = el("div", "admin-package ctrk-summary");
    const headRow = el("div", "ctrk-summary-head");
    headRow.appendChild(el("p", "eyebrow", "YOUR PROJECT"));
    headRow.appendChild(el("span", "ctrk-pill ctrk-pill-status", statusLabel(project.status)));
    summary.appendChild(headRow);
    summary.appendChild(el("h2", "ctrk-project-title", project.project_name || project.client_name || "Your project"));

    // Before any site work is logged: show the current stage only.
    if (!rows.length) {
      summary.appendChild(el("p", "dash-note", `Project #${project.project_number}`));
      summary.appendChild(el("p", "dash-note", `Your project is currently at the “${statusLabel(project.status)}” stage. Detailed tracking — phases, site photos and progress updates — will appear here once work begins on site.`));
      panel.appendChild(summary);
      return;
    }

    const val = (r) => Number(r.price) || 0;
    const isDone = (r) => r.status === "completed";
    const total = rows.reduce((a, r) => a + val(r), 0);
    const doneVal = rows.filter(isDone).reduce((a, r) => a + val(r), 0);
    const overallPct = total > 0 ? (doneVal / total) * 100 : (rows.length ? (rows.filter(isDone).length / rows.length) * 100 : 0);
    const counts = { completed: 0, in_progress: 0, not_started: 0 };
    rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
    const lastUpdated = rows.reduce((m, r) => (r.updated_at && r.updated_at > m ? r.updated_at : m), "");

    // Group by phase (null → "Unscheduled", ordered last).
    const byPhase = new Map();
    rows.forEach((r) => {
      const key = r.phase == null || r.phase === "" ? null : Number(r.phase);
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key).push(r);
    });
    const phaseKeys = [...byPhase.keys()].sort((a, b) => {
      if (a === null) return 1; if (b === null) return -1; return a - b;
    });

    summary.appendChild(el("p", "dash-note", `Project #${project.project_number}${lastUpdated ? " · Last updated " + new Date(lastUpdated).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : ""}`));

    // Overall bar
    const overall = el("div", "ctrk-overall");
    const barTop = el("div", "ctrk-overall-top");
    barTop.appendChild(el("span", "ctrk-overall-pct", `${round1(overallPct)}%`));
    barTop.appendChild(el("span", "ctrk-overall-cap", `complete · ${counts.completed} of ${rows.length} items done`));
    overall.appendChild(barTop);
    const bar = el("div", "ctrk-bar");
    const fill = el("div", "ctrk-bar-fill");
    fill.style.width = `${Math.max(0, Math.min(100, overallPct))}%`;
    bar.appendChild(fill);
    overall.appendChild(bar);
    overall.appendChild(el("p", "ctrk-overall-value", `${money(doneVal)} of ${money(total)} of work completed, by value`));
    summary.appendChild(overall);

    // Status counts
    const legend = el("div", "ctrk-legend");
    [["completed", "Completed", counts.completed], ["in_progress", "In progress", counts.in_progress], ["not_started", "Not started", counts.not_started]].forEach(([k, lab, n]) => {
      const item = el("span", "ctrk-legend-item");
      item.appendChild(el("span", `ctrk-dot ctrk-dot-${k}`));
      item.appendChild(el("span", null, `${lab}: ${n}`));
      legend.appendChild(item);
    });
    summary.appendChild(legend);

    // Phase rings
    const ringsWrap = el("div", "ctrk-rings");
    phaseKeys.forEach((key) => {
      const items = byPhase.get(key);
      const t = items.reduce((a, r) => a + val(r), 0);
      const d = items.filter(isDone).reduce((a, r) => a + val(r), 0);
      const pct = t > 0 ? (d / t) * 100 : (items.filter(isDone).length / items.length) * 100;
      const label = key === null ? "Unscheduled" : `Phase ${key}`;
      ringsWrap.appendChild(ring(pct, label, `${items.filter(isDone).length}/${items.length} items`));
    });
    summary.appendChild(el("p", "ctrk-rings-head", "Progress by phase"));
    summary.appendChild(ringsWrap);

    panel.appendChild(summary);

    // ---- Detail per phase --------------------------------------------------
    phaseKeys.forEach((key) => {
      const items = byPhase.get(key);
      const section = el("div", "tk-box-section");
      const t = items.reduce((a, r) => a + val(r), 0);
      const d = items.filter(isDone).reduce((a, r) => a + val(r), 0);
      const pct = t > 0 ? Math.round((d / t) * 100) : Math.round((items.filter(isDone).length / items.length) * 100);
      section.appendChild(el("div", "tk-box-section-head", `${key === null ? "Unscheduled" : "Phase " + key} — ${pct}% complete`));

      const scroll = el("div", "table-scroll");
      const table = el("table", "dash-table");
      const thead = el("thead");
      const hr = el("tr");
      ["Category", "Area", "Product", "Price", "Status", "Date of completion", "Photos"].forEach((h) => hr.appendChild(el("th", null, h)));
      thead.appendChild(hr);
      const tb = el("tbody");
      items.forEach((r) => {
        const tr = el("tr");
        [r.category || "—", r.area || "—", r.product || "—", money(r.price)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });

        const stTd = el("td");
        stTd.appendChild(el("span", `ctrk-badge ctrk-badge-${r.status}`, STATUS_LABEL[r.status] || r.status));
        tr.appendChild(stTd);

        const dateTd = el("td");
        dateTd.textContent = r.completion_date ? new Date(r.completion_date).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }) : "—";
        tr.appendChild(dateTd);

        const photoTd = el("td");
        const photos = Array.isArray(r.photos) ? r.photos : [];
        if (!photos.length) { photoTd.textContent = "—"; }
        else {
          const gallery = el("div", "tk-photo-gallery");
          photos.forEach((path) => {
            const url = photoUrl(path);
            const img = document.createElement("img");
            img.src = url; img.alt = "site photo"; img.className = "tk-photo-thumb ctrk-clickable";
            img.addEventListener("click", () => openLightbox(url));
            gallery.appendChild(img);
          });
          photoTd.appendChild(gallery);
        }
        tr.appendChild(photoTd);
        tb.appendChild(tr);
      });
      table.append(thead, tb);
      scroll.appendChild(table);
      section.appendChild(scroll);
      panel.appendChild(section);
    });
  }

  // ---- boot ----------------------------------------------------------------
  let projects = [];
  try { projects = await loadMyProjects(); }
  catch (error) { message(`Could not load your projects: ${error.message}`, true); return; }

  if (!projects.length) {
    panel.appendChild(el("div", "admin-package"));
    const box = panel.firstChild;
    box.appendChild(el("p", "eyebrow", "NO PROJECT FOUND"));
    box.appendChild(el("p", "dash-note", "We couldn't find a project linked to your email. If you've enquired with Safe Creatives using a different email, please contact us so we can link your project to this account."));
    return;
  }

  if (projects.length === 1) {
    message(`Project #${projects[0].project_number}`);
    renderProject(projects[0]);
  } else {
    const sel = document.createElement("select");
    sel.appendChild(el("option", null, "Select a project…"));
    projects.forEach((p) => {
      const o = el("option", null, `#${p.project_number}${p.project_name ? " — " + p.project_name : ""}`);
      o.value = p.id;
      sel.appendChild(o);
    });
    const label = el("label", "admin-field");
    label.appendChild(el("span", null, "Project"));
    label.appendChild(sel);
    projectRow.appendChild(label);
    sel.addEventListener("change", () => {
      const p = projects.find((x) => x.id === sel.value);
      if (p) renderProject(p); else panel.textContent = "";
    });
    // Preselect the most recent.
    sel.value = projects[0].id;
    renderProject(projects[0]);
  }
})();
