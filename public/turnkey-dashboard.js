// ============================================================================
// Safe Creatives — Turnkey Solutions dashboard
// ============================================================================
//
// The CRM for the bespoke/turnkey side of the business. Two tabs:
//
//   Customer database — every lead/project (one numbered row each, from 29).
//                       Website enquiries land here automatically; staff can
//                       also add leads from other channels, edit any field,
//                       and move a project's status forward.
//   Receipts          — issue a printable receipt against a project (built in
//                       the next step).
//
// Everything here needs migration 019-turnkey-crm.sql (tables + is_admin RLS).
// Without it the panels show "table does not exist / permission denied" rather
// than breaking, which is the failure to watch for.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const bodyEl = document.querySelector("#tk-body");
  const panel = document.querySelector("#tk-panel");
  const stats = document.querySelector("#tk-stats");
  const messageEl = document.querySelector("#tk-message");

  if (!SC.isAdmin) {
    denied.hidden = false;
    return;
  }
  bodyEl.hidden = false;

  // Standard channels offered in the dropdown. The column is free text, so a
  // new channel can be added here later without a migration.
  const PLATFORM_OPTIONS = [
    ["website", "Website"],
    ["meta", "Meta"],
    ["referral", "Referral"],
    ["word of mouth", "Word of mouth"],
  ];
  const PLATFORM_LABEL = Object.fromEntries(PLATFORM_OPTIONS);

  // Must match the CHECK constraint in migration 019 exactly.
  const STATUS_OPTIONS = [
    "Lead",
    "Closed",
    "Design initiated",
    "DSO",
    "Execution commenced",
    "Handed over",
  ];

  const MODE_OPTIONS = ["Cash", "UPI", "Bank transfer", "Cheque", "Card"];

  // The payment milestones a receipt can be issued for, in order. The 1-based
  // position in this list becomes the middle segment of the receipt number
  // (project no. / milestone no. / date), so the order here is significant.
  const RECEIPT_TYPES = [
    "Design Initiation",
    "DSO Payment",
    "Execution installment",
    "Accessories payment",
    "Handover payment",
  ];

  function statusTone(status) {
    if (status === "Lead") return "warn";
    if (status === "Closed") return "muted";
    return "ok";
  }

  function message(text, isError) {
    messageEl.textContent = text;
    messageEl.className = `admin-message${isError ? " is-error" : " is-ok"}`;
  }

  // ------------------------------------------------------------------
  // Small DOM + formatting helpers (same shapes as the sensory dashboard)
  // ------------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function when(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function pill(text, tone) {
    return el("span", `pill pill-${tone}`, text);
  }

  function contactCell(name, email, phone) {
    const box = el("div", "contact-cell");
    box.appendChild(el("strong", null, name || "—"));
    if (email) {
      const a = el("a", null, email);
      a.href = `mailto:${email}`;
      box.appendChild(a);
    }
    if (phone) {
      const a = el("a", null, phone);
      a.href = `tel:${String(phone).replace(/\s+/g, "")}`;
      box.appendChild(a);
    }
    return box;
  }

  // bigint columns come back from PostgREST as strings; normalise before maths.
  function money(paise) {
    return paise != null && paise !== "" ? SC.money(Number(paise)) : "—";
  }
  function rupeesToPaise(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
  }
  function todayISO() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  // A 'YYYY-MM-DD' date, formatted without a timezone shift.
  function fmtDate(ymd) {
    if (!ymd) return "—";
    const [y, m, d] = String(ymd).split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${d} ${months[Number(m) - 1] || m} ${y}`;
  }

  function field(labelText, control) {
    const wrap = el("label", "admin-field");
    wrap.appendChild(el("span", null, labelText));
    wrap.appendChild(control);
    return wrap;
  }
  function input(type, value) {
    const i = document.createElement("input");
    i.type = type;
    if (value != null) i.value = value;
    return i;
  }
  function textarea(value) {
    const t = document.createElement("textarea");
    t.rows = 2;
    if (value) t.value = value;
    return t;
  }
  function select(options, value) {
    const s = document.createElement("select");
    options.forEach((opt) => {
      const [val, label] = Array.isArray(opt) ? opt : [opt, opt];
      const o = el("option", null, label);
      o.value = val;
      if (val === value) o.selected = true;
      s.appendChild(o);
    });
    return s;
  }

  // ------------------------------------------------------------------
  // Data
  // ------------------------------------------------------------------

  async function loadProjects() {
    const { data, error } = await sb
      .from("turnkey_projects")
      .select(
        `id, project_number, client_name, client_phone, client_email, platform,
         project_name, budget_paise, site_address, status, pin_code, area_sqft,
         project_category, requirement, source, notes, created_at`
      )
      .order("project_number", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  // A shared field grid used by both the "add" form and the per-row editor.
  function projectFields(p) {
    const nameI = input("text", p?.client_name || "");
    nameI.required = true;
    const phoneI = input("tel", p?.client_phone || "");
    const emailI = input("email", p?.client_email || "");
    const platformS = select(PLATFORM_OPTIONS, p?.platform || "website");
    const projectI = input("text", p?.project_name || "");
    const budgetI = input(
      "number",
      p?.budget_paise != null ? String(Number(p.budget_paise) / 100) : ""
    );
    budgetI.min = "0";
    budgetI.step = "1";
    const siteI = textarea(p?.site_address || "");
    const statusS = select(STATUS_OPTIONS, p?.status || "Lead");
    const notesI = textarea(p?.notes || "");

    const grid = el("div", "admin-inline");
    grid.append(
      field("Client name", nameI),
      field("Phone", phoneI),
      field("Email", emailI),
      field("Platform", platformS),
      field("Project name", projectI),
      field("Budget (₹)", budgetI),
      field("Status", statusS)
    );
    const wide = el("div");
    wide.append(field("Site address", siteI), field("Notes", notesI));

    const read = () => {
      const payload = {
        client_name: nameI.value.trim(),
        client_phone: phoneI.value.trim() || null,
        client_email: emailI.value.trim() || null,
        platform: platformS.value,
        project_name: projectI.value.trim() || null,
        budget_paise: rupeesToPaise(budgetI.value),
        site_address: siteI.value.trim() || null,
        status: statusS.value,
        notes: notesI.value.trim() || null,
      };
      return payload;
    };

    return { grid, wide, read, nameI };
  }

  // ------------------------------------------------------------------
  // Add a customer / lead
  // ------------------------------------------------------------------

  function addForm(onSaved) {
    const block = el("details", "admin-package tk-add");
    block.appendChild(el("summary", null, "Add a customer / lead"));

    const f = projectFields(null);
    const msg = el("p", "admin-hint", "");
    const btn = el("button", "admin-primary", "Add customer");
    btn.type = "button";

    btn.addEventListener("click", async () => {
      const payload = f.read();
      if (!payload.client_name) {
        msg.textContent = "Client name is required.";
        return;
      }
      // Drop the empty keys so the row keeps its column defaults where blank.
      Object.keys(payload).forEach((k) => payload[k] == null && delete payload[k]);
      payload.source = "manual";

      btn.disabled = true;
      const { data, error } = await sb
        .from("turnkey_projects")
        .insert(payload)
        .select("project_number")
        .single();
      btn.disabled = false;

      if (error) {
        msg.textContent = `Could not add: ${error.message}`;
        return;
      }
      message(`Added #${data.project_number} — ${payload.client_name}.`);
      onSaved();
    });

    const actions = el("div", "admin-row-actions");
    actions.appendChild(btn);
    block.append(f.grid, f.wide, actions, msg);
    return block;
  }

  // ------------------------------------------------------------------
  // Per-row editor
  // ------------------------------------------------------------------

  function editRow(p, onSaved) {
    const wrap = el("div", "tk-edit");

    // What the enquiry form captured — shown for context, not edited here.
    const quals = [];
    if (p.project_category) quals.push(`Category: ${p.project_category}`);
    if (p.requirement) quals.push(`Requirement: ${p.requirement}`);
    if (p.area_sqft) quals.push(`Area: ${p.area_sqft} sq ft`);
    if (p.pin_code) quals.push(`PIN: ${p.pin_code}`);
    const meta = [`#${p.project_number}`, p.source === "website" ? "from website" : "added manually"];
    wrap.appendChild(el("p", "admin-hint", meta.join(" · ") + (quals.length ? " — " + quals.join(" · ") : "")));

    const f = projectFields(p);
    const msg = el("p", "admin-hint", "");
    const btn = el("button", "admin-primary-small", "Save changes");
    btn.type = "button";

    btn.addEventListener("click", async () => {
      const patch = f.read();
      if (!patch.client_name) {
        msg.textContent = "Client name is required.";
        return;
      }
      btn.disabled = true;
      const { error } = await sb.from("turnkey_projects").update(patch).eq("id", p.id);
      btn.disabled = false;
      if (error) {
        msg.textContent = `Could not save: ${error.message}`;
        return;
      }
      Object.assign(p, patch);
      message(`Updated #${p.project_number} — ${patch.client_name}.`);
      onSaved();
    });

    // Delete the lead. Receipts reference the project with ON DELETE RESTRICT,
    // so a project that has issued receipts can't be removed until those are
    // deleted first — we translate that database error into plain guidance.
    const del = el("button", "admin-danger", "Delete lead");
    del.type = "button";
    del.addEventListener("click", async () => {
      if (!window.confirm(`Delete lead #${p.project_number} — ${p.client_name}? This cannot be undone.`)) return;
      del.disabled = true;
      const { error } = await sb.from("turnkey_projects").delete().eq("id", p.id);
      del.disabled = false;
      if (error) {
        msg.textContent =
          error.code === "23503" || /foreign key|violates/i.test(error.message)
            ? "This project has receipts. Delete its receipts first, then delete the project."
            : `Could not delete: ${error.message}`;
        return;
      }
      message(`Deleted #${p.project_number} — ${p.client_name}.`);
      onSaved();
    });

    const actions = el("div", "admin-row-actions");
    actions.append(btn, del);
    wrap.append(f.grid, f.wide, actions, msg);
    return wrap;
  }

  // ------------------------------------------------------------------
  // Customer database panel
  // ------------------------------------------------------------------

  async function customersPanel() {
    const projects = await loadProjects();
    const frag = document.createDocumentFragment();

    frag.appendChild(addForm(() => show("customers")));
    frag.appendChild(
      el(
        "p",
        "dash-note",
        "Every website enquiry appears here automatically, highest number first. Click a row to edit details, set the budget or site address, or move the status forward."
      )
    );

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");

    const thead = el("thead");
    const hr = el("tr");
    ["#", "Client", "Platform", "Project", "Budget", "Status", "Added"].forEach((h) =>
      hr.appendChild(el("th", null, h))
    );
    thead.appendChild(hr);

    const tbody = el("tbody");
    if (!projects.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No leads yet.");
      td.colSpan = 7;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    projects.forEach((p) => {
      const summary = el("tr", "order-row");
      const cells = [
        el("strong", null, String(p.project_number)),
        contactCell(p.client_name, p.client_email, p.client_phone),
        PLATFORM_LABEL[p.platform] || p.platform || "—",
        p.project_name || "—",
        money(p.budget_paise),
        pill(p.status, statusTone(p.status)),
        when(p.created_at),
      ];
      cells.forEach((cell) => {
        const td = el("td");
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell ?? "—";
        summary.appendChild(td);
      });

      const detailRow = el("tr", "order-detail-row");
      detailRow.hidden = true;
      const detailCell = el("td");
      detailCell.colSpan = 7;
      detailCell.appendChild(editRow(p, () => show("customers")));
      detailRow.appendChild(detailCell);

      summary.addEventListener("click", () => {
        detailRow.hidden = !detailRow.hidden;
        summary.classList.toggle("is-open", !detailRow.hidden);
      });

      tbody.append(summary, detailRow);
    });

    t.append(thead, tbody);
    scroll.appendChild(t);
    frag.appendChild(scroll);
    return frag;
  }

  // ------------------------------------------------------------------
  // Receipts panel — record a payment and open a printable receipt
  // ------------------------------------------------------------------

  async function loadReceipts() {
    const { data, error } = await sb
      .from("turnkey_receipts")
      .select(
        `id, receipt_number, amount_paise, receipt_date, receipt_name, payment_mode,
         client_name, project_name, created_at, turnkey_projects ( project_number )`
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function receiptsPanel() {
    const [projects, receipts] = await Promise.all([loadProjects(), loadReceipts()]);
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const frag = document.createDocumentFragment();

    // ---- Generate form ----
    const block = el("details", "admin-package tk-add");
    block.open = true;
    block.appendChild(el("summary", null, "Generate a receipt"));

    const projectS = document.createElement("select");
    projectS.appendChild(
      el("option", null, projects.length ? "Select a project…" : "No projects yet — add one first")
    );
    projects.forEach((p) => {
      const o = el(
        "option",
        null,
        `#${p.project_number} — ${p.client_name}` + (p.project_name ? ` — ${p.project_name}` : "")
      );
      o.value = p.id;
      projectS.appendChild(o);
    });

    const amountI = input("number");
    amountI.min = "0";
    amountI.step = "1";
    const dateI = input("date", todayISO());
    // "Receipt for" is now a fixed list of milestones. The leading blank stops
    // the admin from saving without choosing one.
    const typeS = select([["", "Select…"], ...RECEIPT_TYPES], "");
    const modeS = select(MODE_OPTIONS, "UPI");
    const notesI = textarea("");
    notesI.placeholder = "Anything important to print on the receipt (optional)";

    const grid = el("div", "admin-inline");
    grid.append(
      field("Project", projectS),
      field("Amount (₹)", amountI),
      field("Date", dateI),
      field("Receipt for", typeS),
      field("Mode of payment", modeS)
    );
    // The note runs full width below the inline grid.
    const wide = el("div");
    wide.append(field("Note", notesI));

    const msg = el("p", "admin-hint", "");
    const btn = el("button", "admin-primary", "Save & open receipt");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      const project = projectsById.get(projectS.value);
      const amount = rupeesToPaise(amountI.value);
      if (!project) return void (msg.textContent = "Choose a project.");
      if (!amount) return void (msg.textContent = "Enter a valid amount.");
      if (!typeS.value) return void (msg.textContent = "Choose what the receipt is for.");
      if (!dateI.value) return void (msg.textContent = "Pick a date.");

      // Receipt number = project code / milestone (its 1-based position in
      // RECEIPT_TYPES + the "receipt for" label) / the chosen date as
      // DD/MM/YYYY. e.g. 29/1.Design Initiation/06/08/2026.
      const milestoneNo = RECEIPT_TYPES.indexOf(typeS.value) + 1;
      const [y, m, d] = dateI.value.split("-");
      const receiptNumber = `${project.project_number}/${milestoneNo}.${typeS.value}/${d}/${m}/${y}`;

      btn.disabled = true;
      // Snapshot the client + project details onto the receipt so it stays fixed.
      const payload = {
        receipt_number: receiptNumber,
        project_id: project.id,
        amount_paise: amount,
        receipt_date: dateI.value,
        receipt_name: typeS.value,
        payment_mode: modeS.value,
        notes: notesI.value.trim() || null,
        client_name: project.client_name,
        client_phone: project.client_phone || null,
        project_name: project.project_name || null,
        site_address: project.site_address || null,
      };
      const { data, error } = await sb
        .from("turnkey_receipts")
        .insert(payload)
        .select("receipt_number")
        .single();
      btn.disabled = false;
      if (error) return void (msg.textContent = `Could not save: ${error.message}`);

      message(`Receipt ${data.receipt_number} saved for #${project.project_number}.`);
      window.open(`receipt.html?number=${encodeURIComponent(data.receipt_number)}`, "_blank");
      show("receipts");
    });

    const actions = el("div", "admin-row-actions");
    actions.appendChild(btn);
    block.append(grid, wide, actions, msg);
    frag.appendChild(block);

    // ---- List ----
    frag.appendChild(
      el(
        "p",
        "dash-note",
        "Every payment recorded, newest first. Open a receipt to print it or save it as a PDF to send the client."
      )
    );

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Receipt", "Project", "For", "Amount", "Mode", "Date", ""].forEach((h) =>
      hr.appendChild(el("th", null, h))
    );
    thead.appendChild(hr);

    const tbody = el("tbody");
    if (!receipts.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No receipts yet.");
      td.colSpan = 7;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    receipts.forEach((r) => {
      const open = el("a", "invoice-open", "Open ↗︎");
      open.href = `receipt.html?number=${encodeURIComponent(r.receipt_number)}`;
      open.target = "_blank";

      // Deleting a receipt is irreversible, so confirm first. Receipts have no
      // dependants, so the delete always succeeds for an admin.
      const del = el("button", "tk-delete-link", "Delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete receipt ${r.receipt_number}? This cannot be undone.`)) return;
        del.disabled = true;
        const { error } = await sb.from("turnkey_receipts").delete().eq("id", r.id);
        if (error) {
          del.disabled = false;
          return void message(`Could not delete receipt: ${error.message}`, true);
        }
        message(`Deleted receipt ${r.receipt_number}.`);
        show("receipts");
      });

      const rowActions = el("div", "tk-cell-actions");
      rowActions.append(open, del);

      const projLabel =
        (r.turnkey_projects?.project_number != null ? `#${r.turnkey_projects.project_number} — ` : "") +
        (r.client_name || "—") +
        (r.project_name ? ` — ${r.project_name}` : "");
      const cells = [
        el("strong", null, r.receipt_number),
        projLabel,
        r.receipt_name,
        money(r.amount_paise),
        r.payment_mode,
        fmtDate(r.receipt_date),
        rowActions,
      ];
      const tr = el("tr");
      cells.forEach((cell) => {
        const td = el("td");
        if (cell instanceof Node) td.appendChild(cell);
        else td.textContent = cell ?? "—";
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });

    t.append(thead, tbody);
    scroll.appendChild(t);
    frag.appendChild(scroll);
    return frag;
  }

  // ------------------------------------------------------------------
  // Headline counts
  // ------------------------------------------------------------------

  async function renderStats() {
    const [total, leads, inProgress, handed] = await Promise.all([
      sb.from("turnkey_projects").select("id", { count: "exact", head: true }),
      sb.from("turnkey_projects").select("id", { count: "exact", head: true }).eq("status", "Lead"),
      sb
        .from("turnkey_projects")
        .select("id", { count: "exact", head: true })
        .in("status", ["Design initiated", "DSO", "Execution commenced"]),
      sb.from("turnkey_projects").select("id", { count: "exact", head: true }).eq("status", "Handed over"),
    ]);

    const cards = [
      ["Total leads / projects", String(total.count ?? 0), "muted"],
      ["Open leads", String(leads.count ?? 0), "warn"],
      ["In progress", String(inProgress.count ?? 0), "ok"],
      ["Handed over", String(handed.count ?? 0), "ok"],
    ];

    stats.textContent = "";
    cards.forEach(([label, value, tone]) => {
      const card = el("div", `stat-card stat-${tone}`);
      card.appendChild(el("span", "stat-value", value));
      card.appendChild(el("span", "stat-label", label));
      stats.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------

  const PANELS = {
    customers: customersPanel,
    receipts: receiptsPanel,
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
        `Could not load: ${error.message}. If this says the table does not exist or permission denied, run migration 019-turnkey-crm.sql in Supabase.`,
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

  await renderStats();
  await show("customers");
})();
