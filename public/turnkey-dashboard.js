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

    // The customer / project number is editable here. It's UNIQUE in the
    // database, so a duplicate is refused (checked before saving, and the DB
    // constraint is the backstop if two edits race).
    const numI = input("number", p.project_number);
    numI.min = "1";
    numI.step = "1";
    numI.required = true;
    f.grid.insertBefore(field("Customer no.", numI), f.grid.firstChild);

    const msg = el("p", "admin-hint", "");
    const btn = el("button", "admin-primary-small", "Save changes");
    btn.type = "button";

    btn.addEventListener("click", async () => {
      const patch = f.read();
      if (!patch.client_name) {
        msg.textContent = "Client name is required.";
        return;
      }

      // Validate + (if changed) check the customer number is free.
      const newNum = parseInt(numI.value, 10);
      if (!Number.isInteger(newNum) || newNum < 1) {
        msg.textContent = "Customer number must be a whole number of 1 or more.";
        return;
      }
      if (newNum !== p.project_number) {
        btn.disabled = true;
        const { data: clash, error: checkErr } = await sb
          .from("turnkey_projects")
          .select("client_name")
          .eq("project_number", newNum)
          .neq("id", p.id)
          .maybeSingle();
        btn.disabled = false;
        if (checkErr) {
          msg.textContent = `Could not check the number: ${checkErr.message}`;
          return;
        }
        if (clash) {
          msg.textContent = `Customer number ${newNum} is already used by ${clash.client_name || "another project"}. Numbers must be unique.`;
          return;
        }
        patch.project_number = newNum;
      }

      btn.disabled = true;
      const { error } = await sb.from("turnkey_projects").update(patch).eq("id", p.id);
      btn.disabled = false;
      if (error) {
        msg.textContent =
          error.code === "23505" || /duplicate key|unique/i.test(error.message)
            ? `Customer number ${newNum} is already taken. Numbers must be unique.`
            : `Could not save: ${error.message}`;
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
  const CONSULT_STRENGTHS = [
    { title: "Precise quotation", desc: "With our in-house quotation-builder software, we deliver precise quotations that have no gaps." },
    { title: "Project tracking", desc: "The execution process is updated at every milestone on our project tracking page." },
    { title: "Expert designers", desc: "Experienced designers who handle each and every project with care and expertise." },
    { title: "Project managers", desc: "Seamless execution, with a dedicated project manager on each and every project." },
    { title: "Comprehensive end-to-end service", desc: "Screw-to-screw services for all your interior requirements." },
  ];
  // Clickable links placed in the exported PDF (via jsPDF link annotations).
  const CONSULT_PORTFOLIO_URL = "https://drive.google.com/file/d/1_qE9CsGezCKQYdxqn00OKPz2BCh9Ky6Z/view";
  const CONSULT_WEBSITE_URL = "https://safecreatives.com";
  const CONSULT_TERMS_URL = "https://drive.google.com/file/d/18ucYNPWpFsL9WWq6ZI1qrLuopE4Obi5e/view";
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
      // background-image (not <img object-fit>) so html2canvas crops to fill
      // instead of stretching — matches the public gallery.
      return `<div class="gstrip">${ph.map((u) => `<div class="gcell" style="background-image:url('${esc(u)}')"></div>`).join("")}</div>`;
    };
    const gproj = (g) => `<div class="gproj"><div class="gproj-head"><strong>${esc(g.title || "Untitled")}</strong>${g.location ? `<span>${esc(g.location)}</span>` : ""}</div>${gimgs(g)}</div>`;
    const galleryLinks = `<div class="glinks"><a href="${CONSULT_PORTFOLIO_URL}" target="_blank" rel="noopener">View our full portfolio ↗</a><a href="${CONSULT_WEBSITE_URL}" target="_blank" rel="noopener">safecreatives.com ↗</a></div>`;
    let galleryPages;
    if (sel.length) {
      const half = Math.ceil(sel.length / 2);
      const chunks = sel.length > half ? [sel.slice(0, half), sel.slice(half)] : [sel];
      galleryPages = chunks.map((chunk, i) => `<section class="page"><div class="phead"><span>${esc(sellerName)}</span><span>Selected projects</span></div><h2>Projects we have delivered${i ? " (continued)" : ""}</h2><div class="gprojs">${chunk.map(gproj).join("")}</div>${galleryLinks}</section>`).join("");
    } else {
      galleryPages = `<section class="page"><div class="phead"><span>${esc(sellerName)}</span><span>Selected projects</span></div><h2>Projects we have delivered</h2><p class="muted">Selected gallery projects will appear here.</p>${galleryLinks}</section>`;
    }

    // Scope of work, What sets us apart and Our workflow share ONE compact
    // 3-column slide (merged).
    const scopeCompact = CONSULT_SCOPE.map((s) => `<li>${esc(s)}</li>`).join("");
    const pillTags = CONSULT_PILLARS.map((p) => `<span>${esc(p)}</span>`).join("");
    const featCompact = CONSULT_STRENGTHS.map((s) => `<li><strong>${esc(s.title)}</strong><p>${esc(s.desc)}</p></li>`).join("");
    const wfCompact = CONSULT_WORKFLOW.map((w, i) => `<li><span class="n">${i + 1}</span><div><strong>${esc(w.title)}</strong><p>${esc(w.desc)}</p></div></li>`).join("");
    // One full-bleed slide per uploaded moodboard image.
    const moodPages = moodUrls.length
      ? moodUrls.map((u) => `<section class="page moodpage"><div class="moodfull" style="background-image:url('${esc(u)}')"></div></section>`).join("")
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
  .gcell { aspect-ratio: 4 / 3; border-radius: 8px; overflow: hidden; background-color: #ece4d8; background-size: cover; background-position: center; background-repeat: no-repeat; }
  .gph-row { display: grid; place-items: center; height: 90px; border-radius: 8px; background: #f3ece2; }
  .gph { color: #9a8f7d; font: 500 13px "Playfair Display", serif; }
  /* Merged protocols slide: Scope of work + What sets us apart + Our workflow */
  .merge3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 34px; flex: 1; }
  .mcol h3 { margin: 0 0 9px; font: 600 11px "DM Mono", monospace; letter-spacing: .08em; text-transform: uppercase; color: #0c4444; }
  .mcol h3.mt { margin-top: 18px; }
  ul.scope-compact { margin: 0; padding-left: 16px; font-size: 12px; color: #333; }
  ul.scope-compact li { margin-bottom: 6px; }
  .pill-tags { display: flex; flex-wrap: wrap; gap: 7px; }
  .pill-tags span { background: #f6efe9; border-left: 2px solid #6f222a; padding: 5px 9px; border-radius: 4px; font: 500 11px "Playfair Display", serif; color: #0c4444; }
  ul.feat-compact, ol.wf-compact { margin: 0; padding: 0; list-style: none; }
  ul.feat-compact li { margin-bottom: 11px; }
  ul.feat-compact strong { display: block; font: 600 12px "DM Sans", sans-serif; color: #6f222a; }
  ol.wf-compact li { display: flex; gap: 8px; margin-bottom: 10px; }
  ol.wf-compact strong { display: block; font: 600 12px "DM Sans", sans-serif; color: #0c4444; }
  ol.wf-compact .n { flex: 0 0 18px; width: 18px; height: 18px; border-radius: 50%; background: #6f222a; color: #fff; font: 600 10px "DM Mono", monospace; display: grid; place-items: center; margin-top: 1px; }
  .mcol p { margin: 1px 0 0; font-size: 10.5px; color: #666; line-height: 1.35; }
  .page a { color: #6f222a; text-decoration: underline; }
  .glinks { display: flex; gap: 26px; margin-top: 14px; font: 600 12px "DM Sans", sans-serif; }
  .tc-link { margin: 12px 0 0; font-size: 12px; }
  .moodpage { padding: 0; }
  .moodfull { flex: 1; background-color: #15110e; background-size: cover; background-position: center; background-repeat: no-repeat; }
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
      <h2>Our protocols &amp; approach</h2>
      <div class="merge3">
        <div class="mcol">
          <h3>Scope of work</h3><ul class="scope-compact">${scopeCompact}</ul>
          <h3 class="mt">Key design pillars</h3><div class="pill-tags">${pillTags}</div>
        </div>
        <div class="mcol">
          <h3>What sets us apart</h3><ul class="feat-compact">${featCompact}</ul>
        </div>
        <div class="mcol">
          <h3>Our workflow</h3><ol class="wf-compact">${wfCompact}</ol>
        </div>
      </div>
    </section>
    ${moodPages}
    <section class="page qsrc" data-seller="${esc(sellerName)}">
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
      <p class="tc-link"><a href="${CONSULT_TERMS_URL}" target="_blank" rel="noopener">Read our full terms &amp; conditions ↗</a></p>
    </section>
  </div>
  <script>
    (function () {
      var RECIPIENT = ${JSON.stringify(project.client_email || "")};
      var FILENAME = ${JSON.stringify(("Consultation #" + (project.project_number || "") + (project.client_name ? " - " + project.client_name : "") + ".pdf").replace(/[\\/:*?"<>|]+/g, "-"))};
      var PW = 338.667, PH = 190.5; // 16:9 slide in mm (13.333in x 7.5in)
      var dlBtn = document.getElementById("sc-download-btn");
      var btn = document.getElementById("sc-email-btn");
      var status = document.getElementById("sc-email-status");

      function libsReady() { return typeof window.html2canvas === "function" && window.jspdf && window.jspdf.jsPDF; }
      async function waitForImages(root) {
        var proms = [].slice.call(root.querySelectorAll("img")).map(function (im) {
          return (im.complete && im.naturalWidth) ? null : new Promise(function (res) { im.addEventListener("load", res); im.addEventListener("error", res); });
        });
        // Gallery/moodboard are background-image cells — preload so html2canvas has them.
        [].slice.call(root.querySelectorAll('[style*="background-image"]')).forEach(function (el) {
          var m = /url\(['"]?([^'")]+)['"]?\)/.exec(el.style.backgroundImage || "");
          if (m && m[1]) proms.push(new Promise(function (res) { var i = new Image(); i.onload = i.onerror = res; i.src = m[1]; }));
        });
        await Promise.all(proms);
      }
      // Split the quotation across as many 16:9 slides as its rows need (the
      // slide is a fixed-height box with hidden overflow, so a long quotation
      // would otherwise be clipped to a single slide). Idempotent.
      function paginateQuotation() {
        if (window.__qPaginated) return;
        var src = document.querySelector(".qsrc");
        if (!src) { window.__qPaginated = true; return; }
        var parent = src.parentNode;
        var seller = src.getAttribute("data-seller") || "";
        var table = src.querySelector("table");
        var cg = table.querySelector("colgroup");
        var colgroup = cg ? cg.outerHTML : "";
        var theadHTML = table.querySelector("thead").outerHTML;
        var rows = [].slice.call(table.querySelectorAll("tbody > tr"));
        var tf = table.querySelector("tfoot");
        var tfootHTML = tf ? tf.outerHTML : "";
        var noteEl = src.querySelector(".note");
        var noteHTML = noteEl ? noteEl.outerHTML : "";
        function makePage(cont) {
          var sec = document.createElement("section");
          sec.className = "page";
          sec.innerHTML = '<div class="phead"><span>' + seller + '</span><span>Tentative quotation</span></div>'
            + '<h2>Tentative quotation' + (cont ? " (continued)" : "") + "</h2>"
            + '<table class="data">' + colgroup + theadHTML + "<tbody></tbody></table>";
          parent.insertBefore(sec, src);
          return sec;
        }
        var made = [];
        var cur = makePage(false);
        var tb = cur.querySelector("tbody");
        for (var i = 0; i < rows.length; i++) {
          tb.appendChild(rows[i]);
          if (cur.scrollHeight > cur.clientHeight && tb.children.length > 1) {
            tb.removeChild(rows[i]);
            made.push(cur);
            cur = makePage(true);
            tb = cur.querySelector("tbody");
            tb.appendChild(rows[i]);
          }
        }
        made.push(cur);
        // Total row + note belong on the last page; if they overflow, add a page.
        var last = made[made.length - 1];
        var lastTable = last.querySelector("table");
        if (tfootHTML) lastTable.insertAdjacentHTML("beforeend", tfootHTML);
        if (noteHTML) last.insertAdjacentHTML("beforeend", noteHTML);
        if (last.scrollHeight > last.clientHeight) {
          var f = lastTable.querySelector("tfoot"); if (f) f.remove();
          var n = last.querySelector(".note"); if (n) n.remove();
          var extra = makePage(true);
          if (tfootHTML) extra.querySelector("table").insertAdjacentHTML("beforeend", tfootHTML);
          if (noteHTML) extra.insertAdjacentHTML("beforeend", noteHTML);
        }
        parent.removeChild(src);
        window.__qPaginated = true;
      }
      (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(paginateQuotation);
      // Render EACH .page to its own canvas and place it as one full PDF page —
      // this guarantees one slide per page (html2pdf's auto-slicing drifted and
      // straddled slides). Returns a jsPDF instance.
      async function buildPdf() {
        var jsPDF = window.jspdf.jsPDF;
        var doc = document.querySelector(".doc");
        if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) { /* ignore */ } }
        paginateQuotation();
        await waitForImages(doc);
        var pages = [].slice.call(doc.querySelectorAll(".page"));
        var pdf = new jsPDF({ unit: "mm", format: [PW, PH], orientation: "landscape" });
        for (var i = 0; i < pages.length; i++) {
          var canvas = await window.html2canvas(pages[i], { scale: 2, useCORS: true, backgroundColor: "#ffffff", logging: false });
          if (i > 0) pdf.addPage([PW, PH], "landscape");
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.95), "JPEG", 0, 0, PW, PH);
          // The slide is a flat image, so overlay clickable link annotations at
          // each anchor's position (scaled from on-screen px to the PDF slide mm).
          var pageRect = pages[i].getBoundingClientRect();
          var anchors = pages[i].querySelectorAll("a[href]");
          for (var a = 0; a < anchors.length; a++) {
            var href = anchors[a].href;
            if (!href) continue;
            var r = anchors[a].getBoundingClientRect();
            if (!r.width || !r.height) continue;
            pdf.link(
              (r.left - pageRect.left) / pageRect.width * PW,
              (r.top - pageRect.top) / pageRect.height * PH,
              r.width / pageRect.width * PW,
              r.height / pageRect.height * PH,
              { url: href }
            );
          }
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
  // Reports — charts over leads, pipeline, collections and demand
  // ------------------------------------------------------------------

  async function reportsPanel() {
    const R = window.SCReports;
    const frag = document.createDocumentFragment();
    if (!R || !R.ready()) {
      frag.appendChild(
        el("p", "dash-note",
          "Charts couldn’t load — the Chart.js library is fetched from a CDN, so this needs an internet connection. Reopen this tab once you’re back online.")
      );
      return frag;
    }

    const [prj, rcp, spc] = await Promise.all([
      sb.from("turnkey_projects").select("id, project_number, client_name, project_name, site_address, status, platform, budget_paise, pin_code, project_category, created_at"),
      sb.from("turnkey_receipts").select("receipt_number, amount_paise, receipt_date, payment_mode, receipt_name, project_id"),
      sb.from("turnkey_project_spaces").select("name, is_selected"),
    ]);
    const firstErr = prj.error || rcp.error || spc.error;
    if (firstErr) throw firstErr;

    const projects = prj.data || [];
    const receipts = rcp.data || [];
    const spaces = (spc.data || []).filter((s) => s.is_selected);

    const rupees = (v) => "₹" + Math.round(Number(v) || 0).toLocaleString("en-IN");
    // receipt_date is a plain 'YYYY-MM-DD'; build it as a local date (no TZ shift).
    const ymd = (s) => { const [y, m, d] = String(s).split("-"); return new Date(+y, +m - 1, +d); };

    // ---- Controls ------------------------------------------------------
    const controls = el("div", "report-controls");
    const rangeWrap = el("label", "report-range");
    rangeWrap.appendChild(el("span", null, "Period"));
    const rangeSel = document.createElement("select");
    R.RANGES.forEach(([key, label]) => {
      const o = el("option", null, label);
      o.value = key;
      rangeSel.appendChild(o);
    });
    rangeSel.value = "90d";
    rangeWrap.appendChild(rangeSel);
    const printBtn = el("button", "report-print", "Print / Save PDF");
    printBtn.type = "button";
    printBtn.addEventListener("click", () => window.print());
    controls.append(rangeWrap, printBtn);

    const kpis = el("div", "report-kpis");
    const grid = el("div", "report-grid");
    frag.append(controls, kpis, grid);

    function card(title, opts) {
      opts = opts || {};
      const node = el("div", "report-card" + (opts.wide ? " is-wide" : ""));
      node.appendChild(el("h3", null, title));
      const sub = el("p", "report-sub");
      node.appendChild(sub);
      const chartBox = el("div", "report-chart");
      chartBox.appendChild(document.createElement("canvas"));
      node.appendChild(chartBox);
      const legendBox = opts.legend ? el("div") : null;
      if (legendBox) node.appendChild(legendBox);
      grid.appendChild(node);
      return { chartBox, legendBox, sub };
    }

    // ---- Customer payment report (one project, customer-safe) --------------
    // A branded PDF for a single project: payment summary + charts only. It
    // never shows cost, supplier or margin — only what the customer has paid,
    // their budget, and the balance.
    const reportCard = el("div", "report-card is-wide");
    reportCard.appendChild(el("h3", null, "Customer payment report"));
    reportCard.appendChild(el("p", "report-sub", "A customer-safe PDF for one project — payment summary and charts, no costs, suppliers or margins"));
    const crRow = el("div", "tk-custreport-row");
    const crSel = document.createElement("select");
    crSel.className = "mkt-select tk-custreport-sel";
    crSel.appendChild(el("option", null, "Select a project…"));
    projects
      .slice()
      .sort((a, b) => (Number(b.project_number) || 0) - (Number(a.project_number) || 0))
      .forEach((p) => {
        const o = el("option", null, `#${p.project_number} — ${p.client_name}` + (p.project_name ? ` — ${p.project_name}` : ""));
        o.value = p.id;
        crSel.appendChild(o);
      });
    const crBtn = el("button", "admin-primary", "Download report");
    crBtn.type = "button";
    const crMsg = el("p", "admin-hint", "");
    crRow.append(crSel, crBtn);
    reportCard.append(crRow, crMsg);
    grid.appendChild(reportCard);

    crBtn.addEventListener("click", async () => {
      const project = projects.find((p) => p.id === crSel.value);
      if (!project) { crMsg.textContent = "Pick a project first."; return; }
      crBtn.disabled = true;
      const label = crBtn.textContent;
      crBtn.textContent = "Preparing…";
      crMsg.textContent = "";
      try {
        openCustomerReport(await getSeller(), project);
        crMsg.textContent = "Opened in a new tab — review it, then use “Print / Save as PDF”.";
      } catch (e) {
        console.error("Customer report failed:", e);
        crMsg.textContent = `Could not build the report: ${e.message || e}`;
      } finally {
        crBtn.disabled = false;
        crBtn.textContent = label;
      }
    });

    let sellerCache = null;
    async function getSeller() {
      if (sellerCache) return sellerCache;
      const { data } = await sb
        .from("seller_settings")
        .select("legal_name, trade_name, address_line, city, state_name, pin_code, email, phone, gstin")
        .maybeSingle();
      sellerCache = data || {};
      return sellerCache;
    }

    // Render a Chart.js config to a PNG data URL, off-screen and without
    // animation, so it can be embedded as an <img> in the printable report.
    function chartImg(config, w, h) {
      const holder = el("div");
      holder.style.cssText = `position:absolute;left:-10000px;top:0;width:${w}px;height:${h}px`;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      holder.appendChild(canvas);
      document.body.appendChild(holder);
      const chart = new window.Chart(canvas, {
        type: config.type,
        data: config.data,
        options: Object.assign({ responsive: false, animation: false, devicePixelRatio: 2 }, config.options),
      });
      const url = chart.toBase64Image("image/png", 1);
      chart.destroy();
      holder.remove();
      return url;
    }

    function openCustomerReport(seller, project) {
      const cats = RECEIPT_TYPES;
      const rs = receipts
        .filter((r) => r.project_id === project.id)
        .slice()
        .sort((a, b) => String(a.receipt_date || "").localeCompare(String(b.receipt_date || "")));

      const budget = Number(project.budget_paise || 0);
      const paid = rs.reduce((s, r) => s + Number(r.amount_paise || 0), 0);
      const balance = budget > 0 ? Math.max(budget - paid, 0) : null;
      const pct = budget > 0 ? Math.round((paid / budget) * 100) : null;

      const catTotals = Object.fromEntries(cats.map((c) => [c, 0]));
      let otherTotal = 0;
      rs.forEach((r) => {
        const amt = Number(r.amount_paise || 0);
        if (cats.includes(r.receipt_name)) catTotals[r.receipt_name] += amt;
        else otherTotal += amt;
      });

      const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthMap = new Map();
      rs.forEach((r) => {
        if (!r.receipt_date) return;
        const d = ymd(r.receipt_date);
        const key = d.getFullYear() * 12 + d.getMonth();
        monthMap.set(key, (monthMap.get(key) || 0) + Number(r.amount_paise || 0));
      });
      const monthKeys = [...monthMap.keys()].sort((a, b) => a - b);
      const otLabels = monthKeys.map((k) => `${MONTHS[k % 12]} ${String(Math.floor(k / 12)).slice(2)}`);
      const otData = monthKeys.map((k) => monthMap.get(k) / 100);

      const PALETTE = R.PALETTE, TEAL = R.TEAL, INK2 = R.INK2, MUTED = R.MUTED;
      const FONT = "'DM Sans', system-ui, sans-serif";
      const rupeeTick = (v) => "₹" + Math.round(v).toLocaleString("en-IN");

      const images = {};
      if (budget > 0) {
        images.progress = chartImg({
          type: "doughnut",
          data: { labels: ["Paid", "Balance"], datasets: [{ data: [paid / 100, (balance || 0) / 100], backgroundColor: [TEAL, "#e2e0d8"], borderColor: "#fff", borderWidth: 2 }] },
          options: { cutout: "62%", plugins: { legend: { position: "bottom", labels: { font: { family: FONT, size: 13 }, color: INK2 } } } },
        }, 440, 340);
      }
      const mLabels = [], mData = [], mColors = [];
      cats.forEach((c, i) => { if (catTotals[c] > 0) { mLabels.push(c); mData.push(catTotals[c] / 100); mColors.push(PALETTE[i % PALETTE.length]); } });
      if (otherTotal > 0) { mLabels.push("Other"); mData.push(otherTotal / 100); mColors.push("#9a9a93"); }
      if (mData.length) {
        images.byCat = chartImg({
          type: "doughnut",
          data: { labels: mLabels, datasets: [{ data: mData, backgroundColor: mColors, borderColor: "#fff", borderWidth: 2 }] },
          options: { cutout: "58%", plugins: { legend: { position: "bottom", labels: { font: { family: FONT, size: 12 }, color: INK2 } } } },
        }, 440, 340);
      }
      if (otData.length) {
        images.overTime = chartImg({
          type: "bar",
          data: { labels: otLabels, datasets: [{ data: otData, backgroundColor: TEAL, borderRadius: 4, maxBarThickness: 46 }] },
          options: {
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { font: { family: FONT, size: 12 }, color: INK2 } },
              y: { beginAtZero: true, grid: { color: "#e8e7e0" }, ticks: { font: { family: FONT, size: 11 }, color: MUTED, callback: rupeeTick } },
            },
          },
        }, 900, 360);
      }

      const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const coName = seller.trade_name || seller.legal_name || "Safe Creatives";
      const coAddr = [seller.address_line, seller.city, seller.state_name && `${seller.state_name} ${seller.pin_code || ""}`.trim()].filter(Boolean).join(", ");
      const coContact = [seller.phone && `Ph: ${seller.phone}`, seller.email].filter(Boolean).join("  ·  ");
      const today = new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
      const title = (`Payment summary #${project.project_number}` + (project.client_name ? ` - ${project.client_name}` : "")).replace(/[\\/:*?"<>|]+/g, "-");

      const summaryCards = [
        ["Project budget", budget > 0 ? money(budget) : "—"],
        ["Total received", money(paid)],
        ["Balance due", balance == null ? "—" : balance <= 0 ? "Fully paid" : money(balance)],
        ...(pct != null ? [["Paid", pct + "%"]] : []),
      ].map(([l, v]) => `<div class="sum"><span>${esc(l)}</span><strong>${esc(v)}</strong></div>`).join("");

      const recRows = rs.length
        ? rs.map((r) => `<tr><td>${esc(fmtDate(r.receipt_date))}</td><td>${esc(r.receipt_name || "—")}</td><td>${esc(r.payment_mode || "—")}</td><td>${esc(r.receipt_number || "")}</td><td class="num">${esc(money(r.amount_paise))}</td></tr>`).join("")
        : `<tr><td colspan="5" style="text-align:center;color:#999">No payments recorded yet.</td></tr>`;

      const chartsHtml =
        `<div class="charts">` +
        (images.progress ? `<figure><figcaption>Payment progress</figcaption><img src="${images.progress}" alt="Payment progress"/></figure>` : "") +
        (images.byCat ? `<figure><figcaption>Payments by stage</figcaption><img src="${images.byCat}" alt="Payments by stage"/></figure>` : "") +
        `</div>` +
        (images.overTime ? `<figure><figcaption>Payments over time</figcaption><img src="${images.overTime}" alt="Payments over time"/></figure>` : "");

      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Mono:wght@500&family=DM+Sans:wght@400;500;600&family=Playfair+Display:wght@500&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#eceae4;color:#1f1f1f;font:14px/1.6 "DM Sans",system-ui,sans-serif}
  .toolbar{position:sticky;top:0;background:#0c2222;padding:12px 20px;display:flex;gap:10px}
  .toolbar button{padding:9px 18px;border:none;border-radius:6px;background:#fff;color:#0c2222;font:13px "DM Sans",sans-serif;cursor:pointer}
  .toolbar button.primary{background:#6f222a;color:#fff}
  .doc{max-width:900px;margin:24px auto;background:#fff;padding:40px 44px;box-shadow:0 10px 40px rgba(0,0,0,.12)}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #0c4444;padding-bottom:16px}
  .co-name{font:600 20px "Playfair Display",Georgia,serif;color:#6f222a}
  .co-sub{font-size:12px;color:#666}
  .doc-title{text-align:right}
  .doc-title .word{font:500 12px "DM Mono",monospace;letter-spacing:.18em;color:#6f222a}
  .doc-title .big{font:500 22px "Playfair Display",Georgia,serif}
  .meta{display:grid;grid-template-columns:1fr 1fr;gap:4px 24px;margin:18px 0 6px;font-size:13px}
  .meta div span{color:#888;display:inline-block;min-width:88px}
  .sums{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:22px 0}
  .sum{border:1px solid rgba(0,0,0,.12);border-left:3px solid #0c4444;padding:12px 14px}
  .sum span{display:block;font:9px "DM Mono",monospace;letter-spacing:.1em;text-transform:uppercase;color:#888;margin-bottom:5px}
  .sum strong{font-size:19px;letter-spacing:-.02em}
  .charts{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  figure{margin:16px 0 0;border:1px solid rgba(0,0,0,.1);padding:14px}
  figcaption{font:600 11px "DM Mono",monospace;letter-spacing:.08em;text-transform:uppercase;color:#6f222a;margin-bottom:8px}
  figure img{width:100%;height:auto;display:block}
  table{width:100%;border-collapse:collapse;margin-top:14px;font-size:13px}
  th{text-align:left;padding:9px 10px;background:#faf7f2;color:#777;font:9px "DM Mono",monospace;letter-spacing:.1em;text-transform:uppercase;border-bottom:1px solid rgba(0,0,0,.14)}
  td{padding:9px 10px;border-bottom:1px solid rgba(0,0,0,.07)}
  td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
  tfoot td{font-weight:600;border-top:2px solid rgba(0,0,0,.18)}
  .sec-h{font:600 13px "DM Mono",monospace;letter-spacing:.08em;color:#6f222a;margin:26px 0 0}
  .foot{margin-top:26px;font-size:11px;color:#999;text-align:center}
  @media print{.toolbar{display:none}body{background:#fff}.doc{box-shadow:none;margin:0;max-width:none;padding:0 6mm}figure{break-inside:avoid}}
</style></head>
<body>
  <div class="toolbar"><button class="primary" onclick="window.print()">Print / Save as PDF</button><button onclick="window.close()">Close</button></div>
  <div class="doc">
    <div class="head">
      <div>
        <div class="co-name">${esc(coName)}</div>
        ${coAddr ? `<div class="co-sub">${esc(coAddr)}</div>` : ""}
        ${coContact ? `<div class="co-sub">${esc(coContact)}</div>` : ""}
        ${seller.gstin ? `<div class="co-sub">GSTIN: ${esc(seller.gstin)}</div>` : ""}
      </div>
      <div class="doc-title">
        <div class="word">PAYMENT SUMMARY</div>
        <div class="big">#${esc(project.project_number)}</div>
        <div class="co-sub">${esc(today)}</div>
      </div>
    </div>
    <div class="meta">
      <div><span>Client</span>${esc(project.client_name || "—")}</div>
      ${project.project_name ? `<div><span>Project</span>${esc(project.project_name)}</div>` : ""}
      ${project.site_address ? `<div><span>Site</span>${esc(project.site_address)}</div>` : ""}
      <div><span>Status</span>${esc(project.status || "—")}</div>
    </div>
    <div class="sums">${summaryCards}</div>
    ${chartsHtml}
    <div class="sec-h">PAYMENTS RECEIVED</div>
    <table>
      <thead><tr><th>Date</th><th>Towards</th><th>Mode</th><th>Receipt no.</th><th class="num">Amount</th></tr></thead>
      <tbody>${recRows}</tbody>
      ${rs.length ? `<tfoot><tr><td colspan="4">Total received</td><td class="num">${esc(money(paid))}</td></tr></tfoot>` : ""}
    </table>
    <div class="foot">This statement reflects payments received as of ${esc(today)}. Computer-generated; no signature required.</div>
  </div>
</body></html>`;

      const win = window.open("", "_blank");
      if (!win) throw new Error("pop-up blocked — allow pop-ups for this site, then try again");
      win.document.open();
      win.document.write(html);
      win.document.close();
    }

    const cCollect = card("Collections over time", { wide: true });
    const cChannel = card("Lead source", { legend: true });
    const cPipeline = card("Pipeline");
    const cCategory = card("Residential vs commercial", { legend: true });
    const cMode = card("Payment mode", { legend: true });
    const cSpaces = card("Most-requested spaces");
    const cLeads = card("New leads over time", { wide: true });

    // ---- Per-project collections breakup — all-time or the selected period --
    // Each project is a row; columns show how much has come in under each
    // payment milestone, plus total received, budget and (always all-time)
    // balance. A toggle switches between every receipt and the chosen period.
    const breakupCard = el("div", "report-card is-wide");
    const bHead = el("div", "report-card-head");
    const bTitleWrap = el("div");
    bTitleWrap.appendChild(el("h3", null, "Collections by project & category"));
    const bSub = el("p", "report-sub", "All-time · every receipt, by milestone");
    bTitleWrap.appendChild(bSub);
    const bToggle = el("div", "report-seg");
    const segAll = el("button", "is-active", "All-time");
    const segPeriod = el("button", null, "Selected period");
    segAll.type = "button";
    segPeriod.type = "button";
    bToggle.append(segAll, segPeriod);
    bHead.append(bTitleWrap, bToggle);
    const breakupBody = el("div");
    breakupCard.append(bHead, breakupBody);
    grid.appendChild(breakupCard);

    let breakupMode = "all"; // "all" | "period"
    let curNow = new Date();
    let curStart = R.rangeStart(rangeSel.value, curNow);

    // All-time total per project, so Balance is always true outstanding even
    // when the category columns are filtered to a period.
    const allTotalByProject = new Map();
    receipts.forEach((r) => {
      if (!r.project_id) return;
      allTotalByProject.set(r.project_id, (allTotalByProject.get(r.project_id) || 0) + Number(r.amount_paise || 0));
    });

    function rebuildBreakup() {
      const periodBound = breakupMode === "period";
      const startF = periodBound ? curStart : null;
      const cats = RECEIPT_TYPES;
      const cell = (v) => (v > 0 ? money(v) : "—");

      const byProject = new Map();
      let hasOther = false;
      receipts.forEach((r) => {
        if (!r.project_id) return;
        if (startF && !(r.receipt_date && ymd(r.receipt_date) >= startF)) return;
        let rec = byProject.get(r.project_id);
        if (!rec) { rec = { total: 0, other: 0, cats: Object.fromEntries(cats.map((c) => [c, 0])) }; byProject.set(r.project_id, rec); }
        const amt = Number(r.amount_paise || 0);
        rec.total += amt;
        if (cats.includes(r.receipt_name)) rec.cats[r.receipt_name] += amt;
        else { rec.other += amt; if (amt) hasOther = true; }
      });

      // Period view shows only projects that received money in the period;
      // all-time also lists projects that carry a budget but no receipt yet.
      const rows = projects
        .filter((p) => (periodBound ? byProject.has(p.id) : byProject.has(p.id) || Number(p.budget_paise || 0) > 0))
        .sort((a, b) => (Number(b.project_number) || 0) - (Number(a.project_number) || 0));

      const heads = ["Customer", "Status", ...cats, ...(hasOther ? ["Other"] : []), periodBound ? "Received (period)" : "Total received", "Budget", "Balance"];
      const numFrom = 2; // every column from here on is money

      const scroll = el("div", "table-scroll");
      const t = el("table", "dash-table tk-breakup");
      const thead = el("thead");
      const hr = el("tr");
      heads.forEach((h, i) => hr.appendChild(el("th", i >= numFrom ? "num" : null, h)));
      thead.appendChild(hr);

      const tbody = el("tbody");
      if (!rows.length) {
        const tr = el("tr");
        const td = el("td", "dash-empty", periodBound ? "No payments received in this period." : "No projects with payments or budgets yet.");
        td.colSpan = heads.length;
        tr.appendChild(td);
        tbody.appendChild(tr);
      }

      const foot = { total: 0, other: 0, budget: 0, balance: 0, hasBudget: false, cats: Object.fromEntries(cats.map((c) => [c, 0])) };

      rows.forEach((p) => {
        const rec = byProject.get(p.id) || { total: 0, other: 0, cats: Object.fromEntries(cats.map((c) => [c, 0])) };
        const budget = Number(p.budget_paise || 0);
        const balance = budget > 0 ? budget - (allTotalByProject.get(p.id) || 0) : null;
        foot.total += rec.total; foot.other += rec.other; foot.budget += budget;
        if (balance != null) { foot.balance += Math.max(balance, 0); foot.hasBudget = true; }
        cats.forEach((c) => (foot.cats[c] += rec.cats[c]));

        const who = el("div", "tk-breakup-proj");
        who.append(el("strong", null, `#${p.project_number}`), el("span", null, p.client_name || "—"));
        if (p.project_name) who.append(el("span", "tk-breakup-sub", p.project_name));

        const cells = [
          who,
          p.status || "—",
          ...cats.map((c) => cell(rec.cats[c])),
          ...(hasOther ? [cell(rec.other)] : []),
          el("strong", null, money(rec.total)),
          budget > 0 ? money(budget) : "—",
          balance == null ? "—" : balance <= 0 ? el("span", "tk-paid", "Paid") : money(balance),
        ];
        const tr = el("tr");
        cells.forEach((c, i) => {
          const td = el("td", i >= numFrom ? "num" : null);
          if (c instanceof Node) td.appendChild(c);
          else td.textContent = c ?? "—";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });

      if (rows.length) {
        const cells = [
          "All shown", "",
          ...cats.map((c) => cell(foot.cats[c])),
          ...(hasOther ? [cell(foot.other)] : []),
          money(foot.total),
          foot.budget > 0 ? money(foot.budget) : "—",
          foot.hasBudget ? money(foot.balance) : "—",
        ];
        const tr = el("tr", "tk-breakup-total");
        cells.forEach((c, i) => tr.appendChild(el("td", i >= numFrom ? "num" : null, c)));
        tbody.appendChild(tr);
      }

      t.append(thead, tbody);
      scroll.appendChild(t);
      breakupBody.replaceChildren(scroll);
      bSub.textContent = periodBound
        ? "Selected period · category totals for the period; balance is all-time outstanding"
        : "All-time · every receipt, by milestone";
    }

    segAll.addEventListener("click", () => {
      if (breakupMode === "all") return;
      breakupMode = "all";
      segAll.classList.add("is-active");
      segPeriod.classList.remove("is-active");
      rebuildBreakup();
    });
    segPeriod.addEventListener("click", () => {
      if (breakupMode === "period") return;
      breakupMode = "period";
      segPeriod.classList.add("is-active");
      segAll.classList.remove("is-active");
      rebuildBreakup();
    });

    rebuildBreakup();

    function setKpis(cards) {
      kpis.textContent = "";
      cards.forEach(([label, value, tone]) => {
        const c = el("div", `stat-card stat-${tone}`);
        c.appendChild(el("span", "stat-value" + (String(value).length > 8 ? " is-text" : ""), value));
        c.appendChild(el("span", "stat-label", label));
        kpis.appendChild(c);
      });
    }

    function drawOrEmpty(c, hasData, draw) {
      if (c.legendBox) c.legendBox.textContent = "";
      if (!hasData) {
        c.chartBox.innerHTML = "";
        c.chartBox.appendChild(el("p", "report-empty", "No data in this period."));
        return;
      }
      if (!c.chartBox.querySelector("canvas")) {
        c.chartBox.innerHTML = "";
        c.chartBox.appendChild(document.createElement("canvas"));
      }
      draw(c.chartBox.querySelector("canvas"));
    }

    const CHANNEL_DOMAIN = PLATFORM_OPTIONS.map((o) => o[1]);
    const CATEGORY_DOMAIN = ["Residential", "Commercial"];
    const OPEN_STATUSES = ["Lead", "Design initiated", "DSO", "Execution commenced"];

    function render(rangeKey) {
      const now = new Date();
      const start = R.rangeStart(rangeKey, now);
      const grain = R.grainFor(start, now);
      const inRange = (d) => !start || new Date(d) >= start;
      R.reset();

      const prjR = projects.filter((p) => inRange(p.created_at));
      const rcpR = receipts.filter((r) => r.receipt_date && (!start || ymd(r.receipt_date) >= start));

      const collected = rcpR.reduce((s, r) => s + Number(r.amount_paise || 0), 0);
      const openValue = projects
        .filter((p) => OPEN_STATUSES.includes(p.status))
        .reduce((s, p) => s + Number(p.budget_paise || 0), 0);
      const withBudget = prjR.filter((p) => Number(p.budget_paise || 0) > 0);
      const avgBudget = withBudget.length
        ? Math.round(withBudget.reduce((s, p) => s + Number(p.budget_paise || 0), 0) / withBudget.length)
        : 0;
      const handed = projects.filter((p) => p.status === "Handed over").length;
      setKpis([
        ["Collected", money(collected), "ok"],
        ["New leads", String(prjR.length), "muted"],
        ["Open pipeline value", money(openValue), "warn"],
        ["Avg project budget", avgBudget ? money(avgBudget) : "—", "muted"],
        ["Handed over (all time)", String(handed), "ok"],
      ]);

      const col = R.series(rcpR, (r) => ymd(r.receipt_date), (r) => Number(r.amount_paise || 0) / 100, start, now, grain);
      cCollect.sub.textContent = `Receipts · by ${R.grainWord(grain)}`;
      drawOrEmpty(cCollect, collected > 0, (cv) => R.line(cv, col.labels, col.values, { valueFmt: rupees }));

      const ch = R.group(prjR, (p) => PLATFORM_LABEL[p.platform] || p.platform || "—", null, { domain: CHANNEL_DOMAIN });
      cChannel.sub.textContent = "New leads in period";
      drawOrEmpty(cChannel, prjR.length > 0, (cv) => {
        R.pie(cv, ch.labels, ch.values);
        cChannel.legendBox.appendChild(R.legend(ch.labels, ch.values));
      });

      // Pipeline is a current-state view across all projects, not period-bound.
      const pl = R.group(projects, (p) => p.status, null, { domain: STATUS_OPTIONS });
      cPipeline.sub.textContent = "All projects · current stage";
      drawOrEmpty(cPipeline, projects.length > 0, (cv) => R.bar(cv, pl.labels, pl.values, { horizontal: true }));

      const cat = R.group(prjR, (p) => p.project_category || "Unspecified", null, { domain: CATEGORY_DOMAIN });
      cCategory.sub.textContent = "New leads in period";
      drawOrEmpty(cCategory, prjR.length > 0, (cv) => {
        R.pie(cv, cat.labels, cat.values, { doughnut: true });
        cCategory.legendBox.appendChild(R.legend(cat.labels, cat.values));
      });

      const mode = R.group(rcpR, (r) => r.payment_mode || "—", (r) => Number(r.amount_paise || 0) / 100, { domain: MODE_OPTIONS });
      cMode.sub.textContent = "Receipts, by amount";
      drawOrEmpty(cMode, rcpR.length > 0, (cv) => {
        R.pie(cv, mode.labels, mode.values, { valueFmt: rupees });
        cMode.legendBox.appendChild(R.legend(mode.labels, mode.values, rupees));
      });

      const sp = R.group(spaces, (s) => s.name || "—", null, { top: 8 });
      cSpaces.sub.textContent = "Across all projects";
      drawOrEmpty(cSpaces, spaces.length > 0, (cv) => R.bar(cv, sp.labels, sp.values, { horizontal: true }));

      const leadS = R.series(prjR, (p) => p.created_at, null, start, now, grain);
      cLeads.sub.textContent = `New leads · by ${R.grainWord(grain)}`;
      drawOrEmpty(cLeads, prjR.length > 0, (cv) => R.line(cv, leadS.labels, leadS.values));

      // Keep the per-project breakup in step with the period (when toggled to it).
      curStart = start;
      curNow = now;
      rebuildBreakup();
    }

    rangeSel.addEventListener("change", () => render(rangeSel.value));
    requestAnimationFrame(() => render(rangeSel.value));
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
    reports: reportsPanel,
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
