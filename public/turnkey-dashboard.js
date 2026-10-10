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

  // The documents signed over a project. Free text in the DB, but the dashboard
  // offers these three. A Design Sign Off contract can be signed more than once
  // (revisions), so each upload also takes an optional annexure name.
  const DOCUMENT_TYPES = [
    "Client engagement letter",
    "Design Sign Off contract",
    "Handover letter",
  ];
  const DOCUMENT_BUCKET = "turnkey-documents";

  // Common spaces offered as a starting checklist on a project's first quotation
  // setup. They're seeded unticked — the user ticks the ones that apply, and can
  // add or delete any of them. Stored per project in turnkey_project_spaces.
  const DEFAULT_SPACES = [
    "Living Area",
    "Dining Area",
    "Kitchen",
    "Master Bedroom",
    "Study Bedroom",
    "Children's Bedroom",
    "Pooja Area",
    "Master Bathroom",
    "Study Bathroom",
    "Children's Bathroom",
    "Service Area",
    "Foyer",
    "Balcony",
    "Utility",
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

  // Emails a saved receipt to the client via the send-turnkey-receipt Edge
  // Function (renders the PDF + sends it with a thank-you note). Returns a short
  // status so callers can report it: "sent" | "no_email" | "error".
  async function emailReceipt(receiptNumber) {
    try {
      const { data, error } = await sb.functions.invoke("send-turnkey-receipt", {
        body: { receipt_number: receiptNumber },
      });
      if (error) throw error;
      if (data?.ok) return { status: "sent", to: data.to };
      if (data?.reason === "no_email") return { status: "no_email" };
      return { status: "error", detail: data?.error || data?.reason || "unknown error" };
    } catch (e) {
      console.error("Receipt email failed:", e);
      return { status: "error", detail: e?.message || String(e) };
    }
  }

  // Emails a saved document to the client via the send-turnkey-document Edge
  // Function (attaches the uploaded file). Same status shape as emailReceipt.
  async function emailDocument(docId) {
    try {
      const { data, error } = await sb.functions.invoke("send-turnkey-document", {
        body: { id: docId },
      });
      if (error) throw error;
      if (data?.ok) return { status: "sent", to: data.to };
      if (data?.reason === "no_email") return { status: "no_email" };
      return { status: "error", detail: data?.error || data?.reason || "unknown error" };
    } catch (e) {
      console.error("Document email failed:", e);
      return { status: "error", detail: e?.message || String(e) };
    }
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
         client_name, project_name, created_at,
         turnkey_projects ( project_number, client_email )`
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

      // Receipt number = project number / 1.<milestone number> (the milestone's
      // 1-based position in RECEIPT_TYPES) / the chosen date as DD/MM/YYYY.
      // e.g. 29/1.1/06/08/2026.
      const milestoneNo = RECEIPT_TYPES.indexOf(typeS.value) + 1;
      const [y, m, d] = dateI.value.split("-");
      const receiptNumber = `${project.project_number}/1.${milestoneNo}/${d}/${m}/${y}`;

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

      const rcpt = data.receipt_number;
      // Save only — the receipt opens in its own tab where you can review it and
      // then choose to email it. Nothing is sent automatically.
      window.open(`receipt.html?number=${encodeURIComponent(rcpt)}`, "_blank");
      await show("receipts");
      message(`Receipt ${rcpt} saved for #${project.project_number}. It's open in a new tab — review it, then use “Send email to customer” there (or the Email action on the row).`);
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

      // Email the receipt to the client (resend, or send a receipt whose client
      // only got an email added later). Disabled when there's no address.
      const projEmail = r.turnkey_projects?.client_email || "";
      const emailBtn = el("button", "tk-email-link", "Email");
      emailBtn.type = "button";
      if (!projEmail) {
        emailBtn.disabled = true;
        emailBtn.title = "No email on file for this client";
      } else {
        emailBtn.addEventListener("click", async () => {
          if (!window.confirm(`Email receipt ${r.receipt_number} to ${projEmail}?`)) return;
          const label = emailBtn.textContent;
          emailBtn.disabled = true;
          emailBtn.textContent = "Sending…";
          const sent = await emailReceipt(r.receipt_number);
          emailBtn.textContent = label;
          emailBtn.disabled = false;
          if (sent.status === "sent") message(`Receipt ${r.receipt_number} emailed to ${sent.to}.`);
          else if (sent.status === "no_email") message(`No email on file for ${r.receipt_number}; nothing sent.`, true);
          else message(`Could not email ${r.receipt_number}: ${sent.detail}.`, true);
        });
      }

      const rowActions = el("div", "tk-cell-actions");
      rowActions.append(open, emailBtn, del);

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
  // Documents panel — upload a signed document and open a viewer
  // ------------------------------------------------------------------

  async function loadDocuments() {
    const { data, error } = await sb
      .from("turnkey_documents")
      .select(
        `id, document_type, annexure_name, document_number, signed_date, file_name,
         storage_path, created_at, client_name, project_name,
         turnkey_projects ( project_number, client_email )`
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function documentsPanel() {
    const [projects, documents] = await Promise.all([loadProjects(), loadDocuments()]);
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const frag = document.createDocumentFragment();

    // ---- Upload form ----
    const block = el("details", "admin-package tk-add");
    block.open = true;
    block.appendChild(el("summary", null, "Upload a document"));

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

    const typeS = select([["", "Select…"], ...DOCUMENT_TYPES], "");
    const annexI = input("text");
    annexI.placeholder = "Annexure / reference name (optional)";
    const numberI = input("text");
    numberI.placeholder = "e.g. SC-DSO-29-A";
    const dateI = input("date", todayISO());
    const fileI = input("file");
    const notesI = textarea("");
    notesI.placeholder = "Anything important to mention in the email (optional)";

    const grid = el("div", "admin-inline");
    grid.append(
      field("Project", projectS),
      field("Document", typeS),
      field("Annexure name", annexI),
      field("Document number", numberI),
      field("Date of signing", dateI),
      field("File", fileI)
    );
    const wide = el("div");
    wide.append(field("Note", notesI));

    const msg = el("p", "admin-hint", "");
    const btn = el("button", "admin-primary", "Save & open document");
    btn.type = "button";
    btn.addEventListener("click", async () => {
      const project = projectsById.get(projectS.value);
      const file = fileI.files && fileI.files[0];
      if (!project) return void (msg.textContent = "Choose a project.");
      if (!typeS.value) return void (msg.textContent = "Choose which document this is.");
      if (!file) return void (msg.textContent = "Choose a file to upload.");

      btn.disabled = true;
      msg.textContent = "Uploading…";

      // Store the file under the project, keyed by time so repeat sign-offs of
      // the same document never collide.
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${project.id}/${Date.now()}-${safeName}`;
      const { error: upError } = await sb.storage
        .from(DOCUMENT_BUCKET)
        .upload(path, file, { contentType: file.type || undefined, upsert: false });
      if (upError) {
        btn.disabled = false;
        return void (msg.textContent = `Upload failed: ${upError.message}`);
      }

      // Snapshot the client + project details onto the document row.
      const payload = {
        project_id: project.id,
        document_type: typeS.value,
        annexure_name: annexI.value.trim() || null,
        document_number: numberI.value.trim() || null,
        signed_date: dateI.value || null,
        storage_path: path,
        file_name: file.name,
        mime_type: file.type || null,
        file_size: file.size,
        client_name: project.client_name,
        client_phone: project.client_phone || null,
        client_email: project.client_email || null,
        project_name: project.project_name || null,
        notes: notesI.value.trim() || null,
      };
      const { data, error } = await sb
        .from("turnkey_documents")
        .insert(payload)
        .select("id")
        .single();
      btn.disabled = false;
      if (error) {
        // Don't leave the just-uploaded file orphaned if the row didn't save.
        await sb.storage.from(DOCUMENT_BUCKET).remove([path]);
        return void (msg.textContent = `Could not save: ${error.message}`);
      }

      // Save only — the document opens in its own tab to review and then email.
      window.open(`document.html?id=${encodeURIComponent(data.id)}`, "_blank");
      await show("documents");
      message(`Document saved for #${project.project_number}. It's open in a new tab — review it, then use “Send email to customer” there (or the Email action on the row).`);
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
        "Every signed document, newest first. Open one to preview it, download it, or email it to the client."
      )
    );

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead");
    const hr = el("tr");
    ["Document", "Reference", "Project", "No.", "Signed", ""].forEach((h) =>
      hr.appendChild(el("th", null, h))
    );
    thead.appendChild(hr);

    const tbody = el("tbody");
    if (!documents.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No documents yet.");
      td.colSpan = 6;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    documents.forEach((docRow) => {
      const open = el("a", "invoice-open", "Open ↗︎");
      open.href = `document.html?id=${encodeURIComponent(docRow.id)}`;
      open.target = "_blank";

      const projEmail = docRow.turnkey_projects?.client_email || "";
      const emailBtn = el("button", "tk-email-link", "Email");
      emailBtn.type = "button";
      if (!projEmail) {
        emailBtn.disabled = true;
        emailBtn.title = "No email on file for this client";
      } else {
        emailBtn.addEventListener("click", async () => {
          if (!window.confirm(`Email this document to ${projEmail}?`)) return;
          const label = emailBtn.textContent;
          emailBtn.disabled = true;
          emailBtn.textContent = "Sending…";
          const sent = await emailDocument(docRow.id);
          emailBtn.textContent = label;
          emailBtn.disabled = false;
          if (sent.status === "sent") message(`Document emailed to ${sent.to}.`);
          else if (sent.status === "no_email") message("No email on file; nothing sent.", true);
          else message(`Could not email: ${sent.detail}.`, true);
        });
      }

      const del = el("button", "tk-delete-link", "Delete");
      del.type = "button";
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete this document (${docRow.document_type})? This cannot be undone.`)) return;
        del.disabled = true;
        const { error: delError } = await sb.from("turnkey_documents").delete().eq("id", docRow.id);
        if (delError) {
          del.disabled = false;
          return void message(`Could not delete: ${delError.message}`, true);
        }
        // Best effort: drop the stored file too, so nothing is left behind.
        if (docRow.storage_path) await sb.storage.from(DOCUMENT_BUCKET).remove([docRow.storage_path]);
        message("Document deleted.");
        show("documents");
      });

      const rowActions = el("div", "tk-cell-actions");
      rowActions.append(open, emailBtn, del);

      const projLabel =
        (docRow.turnkey_projects?.project_number != null ? `#${docRow.turnkey_projects.project_number} — ` : "") +
        (docRow.client_name || "—") +
        (docRow.project_name ? ` — ${docRow.project_name}` : "");
      const cells = [
        el("strong", null, docRow.document_type),
        docRow.annexure_name || "—",
        projLabel,
        docRow.document_number || "—",
        fmtDate(docRow.signed_date),
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
  // Quotations panel — per-project setup (spaces + margin / GST / discount)
  // ------------------------------------------------------------------

  async function loadProjectSettings(projectId) {
    const { data, error } = await sb
      .from("turnkey_projects")
      .select("id, project_number, client_name, project_name, margin_percent, gst_percent, discount_percent")
      .eq("id", projectId)
      .single();
    if (error) throw error;
    return data;
  }

  async function loadProjectSpaces(projectId) {
    const { data, error } = await sb
      .from("turnkey_project_spaces")
      .select("id, name, is_selected")
      .eq("project_id", projectId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // First time a project is opened it has no spaces, so seed the common list
  // (unticked) to give the user a checklist to work from.
  async function seedDefaultSpaces(projectId) {
    const rows = DEFAULT_SPACES.map((name) => ({ project_id: projectId, name, is_selected: false }));
    await sb
      .from("turnkey_project_spaces")
      .upsert(rows, { onConflict: "project_id,name", ignoreDuplicates: true });
  }

  function pct(value) {
    return value == null ? "—" : `${Number(value)}%`;
  }

  async function quotationsPanel() {
    const projects = await loadProjects();
    const frag = document.createDocumentFragment();

    frag.appendChild(
      el(
        "p",
        "dash-note",
        "Pick a project to set up its quotation. Margin, GST and discount are saved on the project; the applicable spaces are saved per project — tick the ones that apply, and add or delete any."
      )
    );

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

    const row = el("div", "admin-inline");
    row.appendChild(field("Project", projectS));
    frag.appendChild(row);

    const settingsWrap = el("div", "tk-qt-settings");
    frag.appendChild(settingsWrap);

    projectS.addEventListener("change", () => renderSettings(projectS.value));
    settingsWrap.appendChild(el("p", "dash-note", "Select a project above to begin."));

    // --- render the setting area for the chosen project --------------------
    async function renderSettings(projectId, mode) {
      settingsWrap.textContent = "";
      if (!projectId) {
        settingsWrap.appendChild(el("p", "dash-note", "Select a project above to begin."));
        return;
      }
      settingsWrap.appendChild(el("p", "dash-note", "Loading…"));

      let project, spaces;
      try {
        project = await loadProjectSettings(projectId);
        spaces = await loadProjectSpaces(projectId);
        if (!spaces.length) {
          await seedDefaultSpaces(projectId);
          spaces = await loadProjectSpaces(projectId);
        }
      } catch (error) {
        settingsWrap.textContent = "";
        settingsWrap.appendChild(
          el(
            "p",
            "admin-message is-error",
            `Could not load: ${error.message}. If this mentions a missing table or column, run migration 021-quotation-project-setup.sql.`
          )
        );
        return;
      }

      const configured = project.margin_percent != null;
      const view = mode || (configured ? "view" : "edit");
      settingsWrap.textContent = "";
      settingsWrap.appendChild(view === "view" ? renderView(project, spaces) : renderEdit(project, spaces));
    }

    // --- read-only summary, with an Edit button ----------------------------
    function renderView(project, spaces) {
      const wrap = el("div", "admin-package");
      wrap.appendChild(el("p", "eyebrow", "PROJECT SETTINGS"));

      const nums = el("div", "admin-inline");
      const stat = (label, value) => {
        const d = el("div", "admin-field");
        d.appendChild(el("span", null, label));
        d.appendChild(el("strong", null, value));
        return d;
      };
      nums.append(
        stat("Margin", pct(project.margin_percent)),
        stat("GST", pct(project.gst_percent)),
        stat("Discount", pct(project.discount_percent))
      );
      wrap.appendChild(nums);

      wrap.appendChild(el("span", "admin-field-label", "Applicable spaces"));
      const chips = el("div", "tk-chips");
      const selected = spaces.filter((s) => s.is_selected);
      if (!selected.length) chips.appendChild(el("span", "dash-note", "None ticked yet."));
      else selected.forEach((s) => chips.appendChild(pill(s.name, "muted")));
      wrap.appendChild(chips);

      const editBtn = el("button", "admin-primary-small", "Edit settings");
      editBtn.type = "button";
      editBtn.addEventListener("click", () => renderSettings(project.id, "edit"));
      const actions = el("div", "admin-row-actions");
      actions.appendChild(editBtn);
      wrap.appendChild(actions);

      wrap.appendChild(
        el("p", "dash-note", "The quotation builder for this project will appear here next.")
      );
      return wrap;
    }

    // --- editable form (also the first-time setup) -------------------------
    function renderEdit(project, spaces) {
      const wrap = el("div", "admin-package");
      const configured = project.margin_percent != null;
      wrap.appendChild(el("p", "eyebrow", configured ? "EDIT PROJECT SETTINGS" : "SET UP THIS PROJECT"));

      // Spaces checklist — changes save immediately to the separate table.
      wrap.appendChild(el("span", "admin-field-label", "Applicable spaces"));
      const list = el("div", "tk-space-list");
      wrap.appendChild(list);
      renderSpaceList(list, project.id, spaces);

      // Add a space
      const addWrap = el("div", "tk-space-add");
      const addI = input("text");
      addI.placeholder = "Add a space (e.g. Home Theatre)";
      const addBtn = el("button", "admin-primary-small", "Add");
      addBtn.type = "button";
      const addSpace = async () => {
        const name = addI.value.trim();
        if (!name) return;
        addBtn.disabled = true;
        const { data, error } = await sb
          .from("turnkey_project_spaces")
          .insert({ project_id: project.id, name, is_selected: true })
          .select("id, name, is_selected")
          .single();
        addBtn.disabled = false;
        if (error) return void message(`Could not add space: ${error.message}`, true);
        spaces.push(data);
        addI.value = "";
        renderSpaceList(list, project.id, spaces);
      };
      addBtn.addEventListener("click", addSpace);
      addI.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); addSpace(); }
      });
      addWrap.append(addI, addBtn);
      wrap.appendChild(addWrap);

      // Margin / GST / discount
      const marginI = input("number", project.margin_percent != null ? project.margin_percent : "");
      const gstI = input("number", project.gst_percent != null ? project.gst_percent : "");
      const discountI = input("number", project.discount_percent != null ? project.discount_percent : "");
      [marginI, gstI, discountI].forEach((i) => { i.min = "0"; i.step = "0.01"; });
      marginI.placeholder = "25";
      gstI.placeholder = "18";
      discountI.placeholder = "0";

      const grid = el("div", "admin-inline");
      grid.append(
        field("Margin (%)", marginI),
        field("GST (%)", gstI),
        field("Discount (%)", discountI)
      );
      wrap.appendChild(grid);

      const msg = el("p", "admin-hint", "");
      const saveBtn = el("button", "admin-primary", "Save project settings");
      saveBtn.type = "button";
      saveBtn.addEventListener("click", async () => {
        const margin = Number(marginI.value);
        const gst = Number(gstI.value);
        const discRaw = discountI.value.trim();
        const discount = discRaw === "" ? 0 : Number(discRaw);
        if (marginI.value.trim() === "" || !Number.isFinite(margin) || margin < 0)
          return void (msg.textContent = "Enter a valid margin %.");
        if (gstI.value.trim() === "" || !Number.isFinite(gst) || gst < 0)
          return void (msg.textContent = "Enter a valid GST %.");
        if (!Number.isFinite(discount) || discount < 0)
          return void (msg.textContent = "Enter a valid discount %.");

        saveBtn.disabled = true;
        const { error } = await sb
          .from("turnkey_projects")
          .update({ margin_percent: margin, gst_percent: gst, discount_percent: discount })
          .eq("id", project.id);
        saveBtn.disabled = false;
        if (error) return void (msg.textContent = `Could not save: ${error.message}`);
        message(`Saved settings for #${project.project_number}.`);
        renderSettings(project.id, "view");
      });

      const actions = el("div", "admin-row-actions");
      actions.appendChild(saveBtn);
      if (configured) {
        const cancelBtn = el("button", "admin-danger", "Cancel");
        cancelBtn.type = "button";
        cancelBtn.addEventListener("click", () => renderSettings(project.id, "view"));
        actions.appendChild(cancelBtn);
      }
      wrap.append(actions, msg);
      return wrap;
    }

    // Rebuilds the tickable space rows into `container`.
    function renderSpaceList(container, projectId, spaces) {
      container.textContent = "";
      if (!spaces.length) {
        container.appendChild(el("p", "dash-note", "No spaces yet — add one below."));
        return;
      }
      spaces.forEach((space) => {
        const rowEl = el("label", "tk-space-row");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = !!space.is_selected;
        cb.addEventListener("change", async () => {
          const next = cb.checked;
          cb.disabled = true;
          const { error } = await sb
            .from("turnkey_project_spaces")
            .update({ is_selected: next })
            .eq("id", space.id);
          cb.disabled = false;
          if (error) {
            cb.checked = !next;
            return void message(`Could not update space: ${error.message}`, true);
          }
          space.is_selected = next;
        });

        const del = el("button", "tk-delete-link", "✕");
        del.type = "button";
        del.title = "Delete this space";
        del.addEventListener("click", async (e) => {
          e.preventDefault();
          del.disabled = true;
          const { error } = await sb.from("turnkey_project_spaces").delete().eq("id", space.id);
          del.disabled = false;
          if (error) return void message(`Could not delete space: ${error.message}`, true);
          const idx = spaces.findIndex((s) => s.id === space.id);
          if (idx >= 0) spaces.splice(idx, 1);
          renderSpaceList(container, projectId, spaces);
        });

        rowEl.append(cb, el("span", null, space.name), del);
        container.appendChild(rowEl);
      });
    }

    return frag;
  }

  // ------------------------------------------------------------------
  // Consultation — per-client consultation document (export + email)
  // ------------------------------------------------------------------

  const CONSULTATION_BUCKET = "turnkey-consultation";
  const MOODBOARD_MAX = 4;
  const TIMELINE_TASKS = ["Design consultation", "Design initiation", "Design Sign Off", "Execution phase", "Handover"];
  // Fixed copy for the "protocols & scope of work" page (client-provided).
  const CONSULT_SCOPE = [
    "Wood works", "Civil works", "Electrical works", "Plumbing works",
    "Design and renders", "Design consultation", "BOQ and project planning",
    "Procurement assistance",
  ];
  const CONSULT_PILLARS = ["Sensory harmony", "Automation inclusivity", "Sustainable design"];
  const CONSULT_WORKFLOW = [
    { title: "Design consultation", desc: "A free consultation to understand your requirements and run a feasibility check." },
    { title: "Design initiation", desc: "Thorough requirement study with a questionnaire." },
    { title: "Design iteration", desc: "3D visualisation of the space with renders and material sampling." },
    { title: "Design sign off", desc: "Final sign-off of the design, specifications and drawings as a contract." },
    { title: "Execution phase", desc: "Material procurement, manufacturing / fabrication and quality control." },
    { title: "Handover", desc: "Final snag and handover." },
  ];
  const CONSULT_TERMS = [
    "This document is a consultation. Costs shown are approximate and exclude GST.",
    "Final pricing is confirmed in a detailed quotation after site measurement and design sign-off.",
    "The timeline is tentative; each phase starts from its stated date, subject to site readiness and timely approvals.",
    "Material availability and client-approved changes may affect the cost and the schedule.",
    "Project images shown are of work we have previously executed and are indicative of our quality, not of the proposed design.",
  ];

  const consultBucketUrl = (path) => sb.storage.from(CONSULTATION_BUCKET).getPublicUrl(path).data.publicUrl;
  const galleryBucketUrl = (path) => sb.storage.from("turnkey-gallery").getPublicUrl(path).data.publicUrl;

  async function loadSellerSettings() {
    const { data } = await sb
      .from("seller_settings")
      .select("legal_name, trade_name, address_line, city, state_name, pin_code, gstin, phone, email")
      .maybeSingle();
    return data || {};
  }
  async function loadGalleryItems() {
    const { data, error } = await sb
      .from("turnkey_gallery")
      .select("id, title, category, location, cover_photo, photos, published, sort_order, created_at")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data || []).filter((g) => g.published);
  }
  async function loadConsultation(projectId) {
    const { data, error } = await sb
      .from("turnkey_consultations")
      .select("project_id, quotation_rows, timeline_rows, gallery_ids, moodboard")
      .eq("project_id", projectId)
      .maybeSingle();
    if (error) throw error;
    return data || { quotation_rows: [], timeline_rows: [], gallery_ids: [], moodboard: [] };
  }

  // Document code: {project number}/2.2/DD/MM/YYYY.
  function consultDocCode(projectNumber, d = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${projectNumber || ""}/2.2/${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
  const longDateNow = () => new Date().toLocaleDateString("en-IN", { day: "numeric", month: "long", year: "numeric" });
  const inrAmount = (n) => "₹" + (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

  // Builds the full landscape consultation document (one <section class="page">
  // per slide). gallery items must already carry a resolved _cover URL; moodUrls
  // are resolved public URLs. Opened in a new window with html2pdf + email.
  function consultationHtml(seller, project, data, gallery, moodUrls, opts) {
    const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const sellerName = seller.trade_name || seller.legal_name || "Safe Creatives";
    const sellerAddr = [seller.address_line, [seller.city, seller.state_name].filter(Boolean).join(", "), seller.pin_code].filter(Boolean).join(", ");
    const location = project.site_address || seller.city || "";

    const sel = (data.gallery_ids || []).map((id) => gallery.find((g) => g.id === id)).filter(Boolean);
    // Each project shows up to 5 of its photos (falls back to the cover).
    const gimgs = (g) => {
      const ph = ((g._photos && g._photos.length ? g._photos : (g._cover ? [g._cover] : []))).slice(0, 5);
      if (!ph.length) return `<div class="gph-row"><span class="gph">${esc(g.title || "Project")}</span></div>`;
      return `<div class="gstrip">${ph.map((u) => `<div class="gcell"><img src="${esc(u)}" crossorigin="anonymous" alt=""></div>`).join("")}</div>`;
    };
    const gproj = (g) => `<div class="gproj"><div class="gproj-head"><strong>${esc(g.title || "Untitled")}</strong>${g.location ? `<span>${esc(g.location)}</span>` : ""}</div>${gimgs(g)}</div>`;
    let galleryPages;
    if (sel.length) {
      const half = Math.ceil(sel.length / 2);
      const chunks = sel.length > half ? [sel.slice(0, half), sel.slice(half)] : [sel];
      galleryPages = chunks.map((chunk, i) => `<section class="page"><div class="phead"><span>${esc(sellerName)}</span><span>Selected projects</span></div><h2>Projects we have delivered${i ? " (continued)" : ""}</h2><div class="gprojs">${chunk.map(gproj).join("")}</div></section>`).join("");
    } else {
      galleryPages = `<section class="page"><div class="phead"><span>${esc(sellerName)}</span><span>Selected projects</span></div><h2>Projects we have delivered</h2><p class="muted">Selected gallery projects will appear here.</p></section>`;
    }

    const scopeList = CONSULT_SCOPE.map((s) => `<li>${esc(s)}</li>`).join("");
    const pillars = CONSULT_PILLARS.map((p) => `<div class="pillar"><span>${esc(p)}</span></div>`).join("");
    const workflowCards = CONSULT_WORKFLOW.map((w, i) => `<div class="wfcard"><div class="wfnum">${i + 1}</div><div class="wfbody"><strong>${esc(w.title)}</strong><p>${esc(w.desc)}</p></div></div>`).join("");
    // One full-bleed slide per uploaded moodboard image.
    const moodPages = moodUrls.length
      ? moodUrls.map((u) => `<section class="page moodpage"><div class="moodfull"><img src="${esc(u)}" crossorigin="anonymous" alt=""></div></section>`).join("")
      : `<section class="page"><div class="phead"><span>${esc(sellerName)}</span><span>Moodboard</span></div><h2>Moodboard</h2><p class="muted">No moodboard images added.</p></section>`;

    const qrows = (data.quotation || []).filter((r) => r.space || r.unit || r.spec || (r.cost != null && r.cost !== ""));
    const qtotal = qrows.reduce((t, r) => t + (Number(r.cost) || 0), 0);
    const qbody = qrows.length
      ? qrows.map((r) => `<tr><td>${esc(r.space || "—")}</td><td>${esc(r.unit || "—")}</td><td>${esc(r.spec || "—")}</td><td class="num">${r.cost != null && r.cost !== "" ? esc(inrAmount(r.cost)) : "—"}</td></tr>`).join("")
      : `<tr><td colspan="4" class="muted">No line items added.</td></tr>`;
    const trows = (data.timeline || []).map((r) => `<tr><td>${esc(r.task)}</td><td>${r.start_date ? esc(fmtDate(r.start_date)) : "—"}</td></tr>`).join("");
    const terms = CONSULT_TERMS.map((t) => `<li>${esc(t)}</li>`).join("");

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Consultation — ${esc(project.client_name)} (#${esc(project.project_number)})</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 "DM Sans", Arial, sans-serif; color: #171717; background: #e9e7e2; }
  .toolbar { position: sticky; top: 0; display: flex; gap: 12px; align-items: center; padding: 12px 18px; background: #0c4444; color: #fff; z-index: 5; }
  .toolbar button { padding: 9px 16px; border: 0; border-radius: 6px; background: #fff; color: #0c4444; font: 600 13px "DM Sans", sans-serif; cursor: pointer; }
  .toolbar .muted { color: #cfe3e3; font-size: 12px; }
  .doc { margin: 18px auto; width: 1050px; max-width: 96%; }
  .page { position: relative; background: #fff; width: 100%; aspect-ratio: 16 / 9; padding: 34px 44px; margin: 0 auto 18px; box-shadow: 0 2px 16px rgba(0,0,0,.08); overflow: hidden; page-break-after: always; break-after: page; display: flex; flex-direction: column; }
  .page:last-child { page-break-after: auto; break-after: auto; }
  .phead { display: flex; justify-content: space-between; font: 600 10px "DM Mono", monospace; letter-spacing: .12em; text-transform: uppercase; color: #8a8f8c; border-bottom: 1px solid #eee; padding-bottom: 10px; margin-bottom: 18px; }
  .page h2 { margin: 0 0 14px; font: 500 26px "Playfair Display", Georgia, serif; letter-spacing: -.02em; color: #6f222a; }
  .page h3 { margin: 0 0 10px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase; color: #0c4444; }
  .lead { font-size: 15px; color: #44504c; margin: 0 0 22px; }
  .muted { color: #9a9a96; }
  .cover { justify-content: space-between; background: linear-gradient(135deg, #0c4444, #123a3a); color: #fff; }
  .cover .brand { font: 500 30px "Playfair Display", Georgia, serif; }
  .cover .tagline { font: 600 11px "DM Mono", monospace; letter-spacing: .16em; text-transform: uppercase; color: #bfe0da; margin-top: 6px; }
  .cover-mid h1 { font: 500 52px "Playfair Display", Georgia, serif; margin: 0; letter-spacing: -.02em; }
  .cover-grid { display: flex; gap: 60px; }
  .cover-grid h4 { margin: 0 0 6px; font: 600 10px "DM Mono", monospace; letter-spacing: .14em; text-transform: uppercase; color: #9fc6c0; }
  .cover-grid p { margin: 2px 0; font-size: 15px; }
  .cover-foot { font-size: 11px; color: #9fc6c0; border-top: 1px solid rgba(255,255,255,.2); padding-top: 12px; }
  .gprojs { display: flex; flex-direction: column; gap: 20px; flex: 1; justify-content: center; }
  .gproj-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 8px; }
  .gproj-head strong { font: 600 15px "DM Sans", sans-serif; color: #222; }
  .gproj-head span { font-size: 12px; color: #777; }
  .gstrip { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; }
  .gcell { aspect-ratio: 4 / 3; border-radius: 8px; overflow: hidden; background: #ece4d8; }
  .gcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .gph-row { display: grid; place-items: center; height: 90px; border-radius: 8px; background: #f3ece2; }
  .gph { color: #9a8f7d; font: 500 13px "Playfair Display", serif; }
  .scope-two { display: flex; gap: 48px; flex: 1; }
  .scope-two > div { flex: 1; }
  ul.scope { columns: 2; margin: 0; padding-left: 18px; font-size: 14px; }
  ul.scope li { margin-bottom: 9px; }
  .pillars { display: flex; flex-direction: column; gap: 12px; }
  .pillar { background: #f6efe9; border-left: 3px solid #6f222a; padding: 12px 14px; border-radius: 6px; font: 500 15px "Playfair Display", serif; color: #0c4444; }
  .wfgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; flex: 1; align-content: center; }
  .wfcard { display: flex; gap: 12px; background: #f6efe9; border-radius: 8px; padding: 14px 16px; }
  .wfnum { width: 28px; height: 28px; flex: 0 0 28px; border-radius: 50%; background: #6f222a; color: #fff; display: grid; place-items: center; font: 600 13px "DM Mono", monospace; }
  .wfbody strong { display: block; font: 600 14px "DM Sans", sans-serif; color: #0c4444; margin-bottom: 3px; }
  .wfbody p { margin: 0; font-size: 12px; color: #555; line-height: 1.45; }
  .moodpage { padding: 0; }
  .moodfull { flex: 1; display: flex; align-items: center; justify-content: center; background: #15110e; }
  .moodfull img { width: 100%; height: 100%; object-fit: cover; display: block; }
  table.data { width: 100%; border-collapse: collapse; margin-bottom: 8px; table-layout: fixed; }
  table.data th, table.data td { padding: 9px 12px; border-bottom: 1px solid #eceae6; text-align: left; vertical-align: top; font-size: 13px; overflow-wrap: anywhere; word-break: break-word; }
  table.data th { font: 600 10px "DM Mono", monospace; letter-spacing: .06em; text-transform: uppercase; color: #777; background: #faf8f5; }
  table.data td.num, table.data th.num { text-align: right; }
  table.data tr.total td { font-weight: 700; color: #0c4444; border-top: 2px solid #0c4444; background: #f4f6f3; }
  .note { font-size: 11px; color: #888; margin-top: 6px; }
  .terms-h { margin-top: 22px; }
  ul.terms { margin: 0; padding-left: 18px; color: #555; font-size: 12px; }
  ul.terms li { margin-bottom: 6px; }
  @page { size: 338.667mm 190.5mm; margin: 0; }
  @media print { body { background: #fff; } .toolbar { display: none; } .doc { width: auto; margin: 0; max-width: none; } .page { box-shadow: none; margin: 0; } }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"></script></head><body>
  <div class="toolbar">
    <button id="sc-download-btn" type="button">Download (PDF)</button>
    <button id="sc-email-btn" type="button">Email to customer</button>
    <span class="muted" id="sc-email-status"></span>
  </div>
  <div class="doc">
    <section class="page cover">
      <div class="cover-top"><div class="brand">${esc(sellerName)}</div><div class="tagline">Turnkey solutions for interior design &amp; execution</div></div>
      <div class="cover-mid"><h1>Design consultation</h1></div>
      <div class="cover-grid">
        <div><h4>Prepared for</h4><p><strong>${esc(project.client_name || "")}</strong></p>${location ? `<p>${esc(location)}</p>` : ""}</div>
        <div><h4>Document</h4><p>${esc(opts.docCode)}</p><p>${esc(opts.dateLabel)}</p></div>
      </div>
      <div class="cover-foot">${esc(sellerAddr)}${seller.phone || seller.email ? ` · ${esc([seller.phone, seller.email].filter(Boolean).join(" · "))}` : ""}</div>
    </section>
    ${galleryPages}
    <section class="page">
      <div class="phead"><span>${esc(sellerName)}</span><span>Scope &amp; approach</span></div>
      <h2>Our protocols &amp; scope of work</h2>
      <p class="lead">Turnkey solutions for interior design and execution — end to end, under one roof.</p>
      <div class="scope-two">
        <div><h3>Scope of work</h3><ul class="scope">${scopeList}</ul></div>
        <div><h3>Key design pillars</h3><div class="pillars">${pillars}</div></div>
      </div>
    </section>
    <section class="page">
      <div class="phead"><span>${esc(sellerName)}</span><span>How we work</span></div>
      <h2>Our workflow</h2>
      <div class="wfgrid">${workflowCards}</div>
    </section>
    ${moodPages}
    <section class="page">
      <div class="phead"><span>${esc(sellerName)}</span><span>Tentative quotation</span></div>
      <h2>Tentative quotation</h2>
      <table class="data"><colgroup><col style="width:14%"><col style="width:22%"><col style="width:44%"><col style="width:20%"></colgroup>
        <thead><tr><th>Space</th><th>Unit / task</th><th>Specifications</th><th class="num">Approx. cost (excl. GST)</th></tr></thead>
        <tbody>${qbody}</tbody>
        <tfoot><tr class="total"><td colspan="3">Total (approx., excl. GST)</td><td class="num">${esc(inrAmount(qtotal))}</td></tr></tfoot>
      </table>
      <p class="note">Indicative only — excludes GST. A detailed quotation follows after site measurement and design sign-off.</p>
    </section>
    <section class="page">
      <div class="phead"><span>${esc(sellerName)}</span><span>Tentative timeline</span></div>
      <h2>Tentative timeline</h2>
      <table class="data"><colgroup><col style="width:62%"><col style="width:38%"></colgroup>
        <thead><tr><th>Task</th><th>Start date</th></tr></thead><tbody>${trows}</tbody></table>
      <h3 class="terms-h">Terms &amp; conditions</h3><ul class="terms">${terms}</ul>
    </section>
  </div>
  <script>
    (function () {
      var RECIPIENT = ${JSON.stringify(project.client_email || "")};
      var FILENAME = ${JSON.stringify(`Consultation-${project.project_number || ""}.pdf`)};
      var PW = 338.667, PH = 190.5; // 16:9 slide in mm (13.333in x 7.5in)
      var dlBtn = document.getElementById("sc-download-btn");
      var btn = document.getElementById("sc-email-btn");
      var status = document.getElementById("sc-email-status");

      function libsReady() { return typeof window.html2canvas === "function" && window.jspdf && window.jspdf.jsPDF; }
      async function waitForImages(root) {
        var imgs = [].slice.call(root.querySelectorAll("img"));
        await Promise.all(imgs.map(function (im) {
          return (im.complete && im.naturalWidth) ? null : new Promise(function (res) { im.addEventListener("load", res); im.addEventListener("error", res); });
        }));
      }
      // Render EACH .page to its own canvas and place it as one full PDF page —
      // this guarantees one slide per page (html2pdf's auto-slicing drifted and
      // straddled slides). Returns a jsPDF instance.
      async function buildPdf() {
        var jsPDF = window.jspdf.jsPDF;
        var doc = document.querySelector(".doc");
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }
        await waitForImages(doc);
        var pages = [].slice.call(doc.querySelectorAll(".page"));
        var pdf = new jsPDF({ unit: "mm", format: [PW, PH], orientation: "landscape" });
        for (var i = 0; i < pages.length; i++) {
          var canvas = await window.html2canvas(pages[i], { scale: 2, useCORS: true, backgroundColor: "#ffffff", logging: false });
          if (i > 0) pdf.addPage([PW, PH], "landscape");
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, PW, PH);
        }
        return pdf;
      }

      dlBtn.addEventListener("click", async function () {
        if (!libsReady()) { status.textContent = "PDF libraries still loading — try again in a second."; return; }
        dlBtn.disabled = true;
        status.textContent = "Generating PDF…";
        try { var pdf = await buildPdf(); pdf.save(FILENAME); status.textContent = "Downloaded."; }
        catch (e) { status.textContent = "Failed: " + (e && e.message ? e.message : e); }
        finally { dlBtn.disabled = false; }
      });

      btn.addEventListener("click", async function () {
        if (!window.opener || !window.opener.__scSendConsultationPdf) { status.textContent = "Open the document from the Consultation tab to enable email."; return; }
        if (!RECIPIENT) { status.textContent = "No email on file for this client — add it in Customer database."; return; }
        if (!window.confirm("Email this consultation to " + RECIPIENT + "?")) return;
        if (!libsReady()) { status.textContent = "PDF libraries still loading — try again in a second."; return; }
        btn.disabled = true;
        status.textContent = "Generating PDF…";
        try {
          var pdf = await buildPdf();
          var uri = pdf.output("datauristring");
          var b64 = uri.indexOf(",") >= 0 ? uri.split(",")[1] : uri;
          status.textContent = "Sending…";
          var res = await window.opener.__scSendConsultationPdf(b64, FILENAME);
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

  function openConsultationWindow(seller, project, data, gallery, moodUrls, opts) {
    const w = window.open("", "_blank");
    if (!w) { message("Pop-up blocked — allow pop-ups for this site to open the document.", true); return; }
    w.document.open();
    w.document.write(consultationHtml(seller, project, data, gallery, moodUrls, opts));
    w.document.close();
    w.focus();
  }

  async function consultationPanel() {
    const [projects, gallery, seller] = await Promise.all([loadProjects(), loadGalleryItems(), loadSellerSettings()]);
    const projectsById = new Map(projects.map((p) => [p.id, p]));
    const frag = document.createDocumentFragment();

    frag.appendChild(el("p", "dash-note", "Prepare a design consultation for a client — a tentative quotation, an indicative timeline, a moodboard and selected gallery projects — then export it as a single landscape PDF and email it to the client."));

    const projectS = document.createElement("select");
    projectS.appendChild(el("option", null, projects.length ? "Select a client…" : "No clients yet — add one in Customer database"));
    projects.forEach((p) => {
      const o = el("option", null, `#${p.project_number} — ${p.client_name}` + (p.project_name ? ` — ${p.project_name}` : ""));
      o.value = p.id;
      projectS.appendChild(o);
    });
    const row = el("div", "admin-inline");
    row.appendChild(field("Client", projectS));
    frag.appendChild(row);

    const wrap = el("div", "tk-consult");
    frag.appendChild(wrap);
    wrap.appendChild(el("p", "dash-note", "Select a client above to begin."));

    projectS.addEventListener("change", () => renderConsult(projectS.value));

    async function renderConsult(projectId) {
      wrap.textContent = "";
      if (!projectId) { wrap.appendChild(el("p", "dash-note", "Select a client above to begin.")); return; }
      wrap.appendChild(el("p", "dash-note", "Loading…"));

      const project = projectsById.get(projectId);
      let spaces, consult;
      try {
        spaces = await loadProjectSpaces(projectId);
        consult = await loadConsultation(projectId);
      } catch (error) {
        wrap.textContent = "";
        wrap.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If this mentions a missing table, run migration 051-turnkey-consultation.sql.`));
        return;
      }
      wrap.textContent = "";

      const spaceNames = spaces.map((s) => s.name);
      const state = {
        gallery_ids: Array.isArray(consult.gallery_ids) ? consult.gallery_ids.slice() : [],
        moodboard: Array.isArray(consult.moodboard) ? consult.moodboard.slice() : [],
        timeline: TIMELINE_TASKS.map((task) => {
          const saved = (consult.timeline_rows || []).find((r) => r && r.task === task);
          return { task, start_date: saved ? saved.start_date || "" : "" };
        }),
      };

      // Bind the email bridge to THIS client (the printable window calls back here).
      window.__scSendConsultationPdf = async (base64, filename) => {
        if (!project.client_email) return { ok: false, message: "No email on file for this client — add it in Customer database." };
        try {
          const { data, error } = await sb.functions.invoke("send-turnkey-consultation", { body: { project_id: projectId, pdf_base64: base64, filename: filename || `Consultation-${project.project_number}.pdf` } });
          if (error) {
            let detail = error.message;
            try { const b = await error.context.json(); if (b && b.error) detail = b.error; } catch (_ignored) { /* no body */ }
            throw new Error(detail);
          }
          if (data && data.error) throw new Error(data.error);
          if (data && data.ok === false && data.reason === "no_email") return { ok: false, message: "No email on file for this client." };
          if (data && data.ok === false && data.reason === "email_not_configured") return { ok: false, message: "Email isn't configured on the server (RESEND_API_KEY)." };
          message(`Consultation emailed to ${project.client_email}.`);
          return { ok: true, message: `Sent to ${project.client_email}.` };
        } catch (e) {
          return { ok: false, message: `Send failed: ${e.message}` };
        }
      };

      // --- Table 1: tentative quotation ------------------------------------
      const quoteBody = el("tbody");
      const quoteRowsCtl = [];
      const totalCell = el("strong", null, inrAmount(0));
      const recomputeTotal = () => {
        const t = quoteRowsCtl.reduce((a, c) => a + (Number(c.read().cost) || 0), 0);
        totalCell.textContent = inrAmount(t);
      };
      const addQuoteRow = (dataRow) => {
        const tr = el("tr");
        const spaceSel = document.createElement("select");
        const ph = el("option", null, spaceNames.length ? "Select space…" : "No spaces set");
        ph.value = "";
        spaceSel.appendChild(ph);
        spaceNames.forEach((n) => { const o = el("option", null, n); o.value = n; if (dataRow && dataRow.space === n) o.selected = true; spaceSel.appendChild(o); });
        if (dataRow && dataRow.space && !spaceNames.includes(dataRow.space)) { const o = el("option", null, dataRow.space); o.value = dataRow.space; o.selected = true; spaceSel.appendChild(o); }
        const unitI = input("text", dataRow ? dataRow.unit || "" : ""); unitI.placeholder = "Unit / task";
        const specI = input("text", dataRow ? dataRow.spec || "" : ""); specI.placeholder = "Specifications";
        const costI = input("number", dataRow && dataRow.cost != null ? dataRow.cost : ""); costI.min = "0"; costI.step = "1"; costI.placeholder = "0";
        costI.addEventListener("input", recomputeTotal);
        const del = el("button", "tk-delete-link", "✕"); del.type = "button"; del.title = "Delete row";
        del.addEventListener("click", () => { const i = quoteRowsCtl.findIndex((c) => c.tr === tr); if (i >= 0) quoteRowsCtl.splice(i, 1); tr.remove(); recomputeTotal(); });
        [spaceSel, unitI, specI, costI].forEach((ctrl) => { const td = el("td"); td.appendChild(ctrl); tr.appendChild(td); });
        const tdDel = el("td"); tdDel.appendChild(del); tr.appendChild(tdDel);
        quoteBody.appendChild(tr);
        quoteRowsCtl.push({ tr, read: () => ({ space: spaceSel.value, unit: unitI.value.trim(), spec: specI.value.trim(), cost: costI.value === "" ? null : Number(costI.value) }) });
      };
      const savedQuote = Array.isArray(consult.quotation_rows) ? consult.quotation_rows : [];
      if (savedQuote.length) savedQuote.forEach(addQuoteRow); else addQuoteRow();
      recomputeTotal();

      const readQuote = () => quoteRowsCtl.map((c) => c.read()).filter((r) => r.space || r.unit || r.spec || r.cost != null);

      const quoteSec = el("div", "admin-package");
      quoteSec.appendChild(el("p", "eyebrow", "TABLE 1 · TENTATIVE QUOTATION"));
      if (!spaceNames.length) quoteSec.appendChild(el("p", "dash-note", "This client has no spaces yet — set them up in the Quotations tab to populate the Space dropdown. You can still type the other columns."));
      const qScroll = el("div", "table-scroll");
      const qTable = el("table", "dash-table");
      const qHead = el("thead"); const qhr = el("tr");
      ["Space", "Unit / task", "Specifications", "Approx. cost (₹, excl. GST)", ""].forEach((h) => qhr.appendChild(el("th", null, h)));
      qHead.appendChild(qhr);
      qTable.append(qHead, quoteBody);
      qScroll.appendChild(qTable);
      quoteSec.appendChild(qScroll);
      const addBtn = el("button", "admin-secondary", "+ Add row"); addBtn.type = "button";
      addBtn.addEventListener("click", () => { addQuoteRow(); });
      const totalLine = el("p", "dash-note"); totalLine.append(document.createTextNode("Total (approx., excl. GST): "), totalCell);
      quoteSec.append(addBtn, totalLine);
      wrap.appendChild(quoteSec);

      // --- Table 2: tentative timeline -------------------------------------
      const timelineCtl = [];
      const tlSec = el("div", "admin-package");
      tlSec.appendChild(el("p", "eyebrow", "TABLE 2 · TENTATIVE TIMELINE"));
      const tlScroll = el("div", "table-scroll");
      const tlTable = el("table", "dash-table");
      const tlHead = el("thead"); const tlhr = el("tr");
      ["Task", "Start date"].forEach((h) => tlhr.appendChild(el("th", null, h)));
      tlHead.appendChild(tlhr);
      const tlBody = el("tbody");
      state.timeline.forEach((rowData) => {
        const tr = el("tr");
        tr.appendChild(el("td", null, rowData.task));
        const dateI = input("date", rowData.start_date || "");
        const td = el("td"); td.appendChild(dateI); tr.appendChild(td);
        tlBody.appendChild(tr);
        timelineCtl.push(() => ({ task: rowData.task, start_date: dateI.value || "" }));
      });
      tlTable.append(tlHead, tlBody);
      tlScroll.appendChild(tlTable);
      tlSec.appendChild(tlScroll);
      wrap.appendChild(tlSec);
      const readTimeline = () => timelineCtl.map((f) => f());

      // --- Moodboard (up to 4 images) --------------------------------------
      const moodSec = el("div", "admin-package");
      moodSec.appendChild(el("p", "eyebrow", `MOODBOARD · UP TO ${MOODBOARD_MAX} IMAGES`));
      const moodWrap = el("div", "tk-mood-grid");
      moodSec.appendChild(moodWrap);
      wrap.appendChild(moodSec);

      // --- Gallery project picker ------------------------------------------
      const galSec = el("div", "admin-package");
      galSec.appendChild(el("p", "eyebrow", "GALLERY PROJECTS TO SHOWCASE"));
      galSec.appendChild(el("p", "dash-note", "Tick the executed projects to feature (they fill the 2 gallery pages of the document)."));
      const galWrap = el("div", "tk-gallery-pick");
      if (!gallery.length) galWrap.appendChild(el("p", "dash-note", "No published gallery projects yet — add some in the Gallery admin."));
      gallery.forEach((g) => {
        const lab = el("label", "tk-gallery-item");
        const cb = document.createElement("input"); cb.type = "checkbox"; cb.checked = state.gallery_ids.includes(g.id);
        cb.addEventListener("change", () => {
          if (cb.checked) { if (!state.gallery_ids.includes(g.id)) state.gallery_ids.push(g.id); }
          else { const i = state.gallery_ids.indexOf(g.id); if (i >= 0) state.gallery_ids.splice(i, 1); }
        });
        const thumb = el("div", "tk-gallery-thumb");
        if (g.cover_photo) { const im = document.createElement("img"); im.src = galleryBucketUrl(g.cover_photo); thumb.appendChild(im); }
        const cap = el("div", "tk-gallery-cap");
        cap.appendChild(el("strong", null, g.title || "Untitled"));
        if (g.location) cap.appendChild(el("span", null, g.location));
        lab.append(cb, thumb, cap);
        galWrap.appendChild(lab);
      });
      galSec.appendChild(galWrap);
      wrap.appendChild(galSec);

      // --- collect + persist -----------------------------------------------
      const collect = () => ({ quotation: readQuote(), timeline: readTimeline(), gallery_ids: state.gallery_ids.slice(), moodboard: state.moodboard.slice() });
      const persist = async () => {
        const d = collect();
        const payload = { project_id: projectId, quotation_rows: d.quotation, timeline_rows: d.timeline, gallery_ids: d.gallery_ids, moodboard: d.moodboard };
        const { error } = await sb.from("turnkey_consultations").upsert(payload, { onConflict: "project_id" });
        if (error) { message(`Could not save: ${error.message}`, true); return false; }
        return true;
      };

      function renderMood() {
        moodWrap.textContent = "";
        state.moodboard.forEach((path, idx) => {
          const cell = el("div", "tk-mood-cell");
          const img = document.createElement("img"); img.src = consultBucketUrl(path); cell.appendChild(img);
          const rm = el("button", "tk-delete-link", "✕"); rm.type = "button"; rm.title = "Remove image";
          rm.addEventListener("click", async () => {
            rm.disabled = true;
            try { await sb.storage.from(CONSULTATION_BUCKET).remove([path]); } catch (_ignored) { /* best effort */ }
            state.moodboard.splice(idx, 1);
            await persist();
            renderMood();
          });
          cell.appendChild(rm);
          moodWrap.appendChild(cell);
        });
        if (state.moodboard.length < MOODBOARD_MAX) {
          const add = el("label", "tk-mood-add");
          add.appendChild(el("span", null, "+ Add image"));
          const fi = document.createElement("input"); fi.type = "file"; fi.accept = "image/*"; fi.style.display = "none";
          fi.addEventListener("change", async () => {
            const file = fi.files && fi.files[0];
            if (!file) return;
            if (state.moodboard.length >= MOODBOARD_MAX) return;
            add.classList.add("is-busy"); add.querySelector("span").textContent = "Uploading…";
            const safe = file.name.replace(/[^\w.\-]+/g, "_");
            const path = `${projectId}/${Date.now()}-${safe}`;
            const { error } = await sb.storage.from(CONSULTATION_BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
            add.classList.remove("is-busy");
            if (error) { renderMood(); return void message(`Image upload failed: ${error.message}`, true); }
            state.moodboard.push(path);
            await persist();
            renderMood();
          });
          add.appendChild(fi);
          moodWrap.appendChild(add);
        }
      }
      renderMood();

      // --- actions ----------------------------------------------------------
      const actions = el("div", "admin-inline");
      const saveBtn = el("button", "admin-primary", "Save consultation"); saveBtn.type = "button";
      saveBtn.addEventListener("click", async () => { saveBtn.disabled = true; const ok = await persist(); saveBtn.disabled = false; if (ok) message("Consultation saved."); });
      const openBtn = el("button", "admin-secondary", "Open consultation document"); openBtn.type = "button";
      openBtn.addEventListener("click", async () => {
        await persist();
        const data = collect();
        const galForDoc = gallery.map((g) => ({ id: g.id, title: g.title, location: g.location, category: g.category, _cover: g.cover_photo ? galleryBucketUrl(g.cover_photo) : "", _photos: (Array.isArray(g.photos) ? g.photos : []).slice(0, 5).map(galleryBucketUrl) }));
        const moodUrls = data.moodboard.map(consultBucketUrl);
        openConsultationWindow(seller, project, data, galForDoc, moodUrls, { docCode: consultDocCode(project.project_number), dateLabel: longDateNow() });
      });
      actions.append(saveBtn, openBtn);
      wrap.appendChild(actions);
      wrap.appendChild(el("p", "admin-hint", "The document is emailed to the client's email on file, as a single landscape PDF. Open it, then use “Email to customer”."));
    }

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
    documents: documentsPanel,
    quotations: quotationsPanel,
    consultation: consultationPanel,
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
