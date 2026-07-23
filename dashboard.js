// ============================================================================
// Safe Creatives — operations dashboard
// ============================================================================
//
// Four read-only views over what has already happened:
//
//   Orders           — including the pending_advance follow-up list
//   Abandoned carts  — configured but never reserved
//   Registrations    — who signed up, with contact details
//   Payments         — gateway records and refunds
//
// Read-only over the financial record on purpose: editing an order's totals
// from a screen would break the guarantee that what is stored is what the
// server computed. The ONE exception is the order tracking (milestones and the
// later installment statuses) — migration 014 grants admins UPDATE on just
// those four columns so they can be advanced here and shown to the customer on
// their "Track order" page. Everything else stays SELECT only.
//
// Everything here depends on the admin read policies in migration 005.
// Without them an admin sees only their own rows and the page looks empty
// rather than broken, which is the confusing failure to watch for.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const body = document.querySelector("#dash-body");
  const panel = document.querySelector("#panel");
  const stats = document.querySelector("#stats");
  const messageEl = document.querySelector("#dash-message");

  if (!SC.isAdmin) {
    denied.hidden = false;
    return;
  }
  body.hidden = false;

  const ORDER_STATUS = {
    pending_advance: "Awaiting advance",
    advance_paid: "Advance paid",
    site_verification: "Site verification",
    confirmed: "Confirmed",
    in_production: "In production",
    delivered: "Delivered",
    cancelled: "Cancelled",
    refunded: "Refunded",
  };

  const PAYMENT_STATUS = {
    created: "Session opened",
    pending: "Pending",
    authorized: "Authorised",
    captured: "Captured",
    failed: "Failed",
    cancelled: "Cancelled",
  };

  function message(text, isError) {
    messageEl.textContent = text;
    messageEl.className = `admin-message${isError ? " is-error" : " is-ok"}`;
  }

  // ------------------------------------------------------------------
  // Formatting
  // ------------------------------------------------------------------

  function when(value) {
    if (!value) return "—";
    const date = new Date(value);
    return date.toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  // "3 days ago" reads faster than a timestamp when you are scanning for
  // whoever has gone cold.
  function ago(value) {
    if (!value) return "—";
    const ms = Date.now() - new Date(value).getTime();
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.round(hours / 24);
    return `${days}d ago`;
  }

  function addressOf(row, prefix = "") {
    return (
      [row[`${prefix}address_line`], row[`${prefix}city`], row[`${prefix}pin_code`]]
        .filter(Boolean)
        .join(", ") || "—"
    );
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function table(headings, rows) {
    const wrap = el("div", "table-scroll");
    const t = el("table", "dash-table");

    const thead = el("thead");
    const hr = el("tr");
    headings.forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);

    const tbody = el("tbody");
    if (!rows.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "Nothing here yet.");
      td.colSpan = headings.length;
      tr.appendChild(td);
      tbody.appendChild(tr);
    } else {
      rows.forEach((cells) => {
        const tr = el("tr");
        cells.forEach((cell) => {
          const td = el("td");
          if (cell instanceof Node) td.appendChild(cell);
          else td.textContent = cell ?? "—";
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }

    t.append(thead, tbody);
    wrap.appendChild(t);
    return wrap;
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
      // tel: strips spaces so the link works from a phone.
      a.href = `tel:${phone.replace(/\s+/g, "")}`;
      box.appendChild(a);
    }
    return box;
  }

  // ------------------------------------------------------------------
  // Orders
  // ------------------------------------------------------------------

  // Renders one order's full contents: every package, its chosen options
  // grouped by product, its add-ons, and the line total. Everything here is
  // the snapshot taken at order time -- catalog renames and price changes
  // since then do not alter it, which is the point.
  function orderDetail(order) {
    const wrap = el("div", "order-detail");

    // Identical configurations are separate lines rather than a quantity, so
    // count them for display without collapsing lines that only look alike.
    const counts = new Map();
    order.order_items.forEach((item) => {
      const key = JSON.stringify([
        item.package_name,
        (item.order_item_options || [])
          .map((o) => `${o.product_name}|${o.group_name}|${o.option_name}`)
          .sort(),
        (item.order_item_addons || []).map((a) => a.addon_name).sort(),
      ]);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const seen = new Set();

    order.order_items.forEach((item) => {
      const key = JSON.stringify([
        item.package_name,
        (item.order_item_options || [])
          .map((o) => `${o.product_name}|${o.group_name}|${o.option_name}`)
          .sort(),
        (item.order_item_addons || []).map((a) => a.addon_name).sort(),
      ]);
      if (seen.has(key)) return;
      seen.add(key);

      const qty = counts.get(key);
      const card = el("div", "order-line");

      const head = el("div", "order-line-head");
      head.appendChild(el("strong", null, `${qty} × ${item.package_name}`));
      head.appendChild(
        el("span", null, SC.money(item.line_total_paise * qty))
      );
      card.appendChild(head);

      card.appendChild(
        el("p", "order-line-base", `Base ${SC.money(item.base_price_paise)}`)
      );

      // Options grouped by product, so a three-product package reads as three
      // blocks rather than one flat list of nine lines.
      const byProduct = new Map();
      (item.order_item_options || []).forEach((option) => {
        if (!byProduct.has(option.product_name)) {
          byProduct.set(option.product_name, []);
        }
        byProduct.get(option.product_name).push(option);
      });

      byProduct.forEach((options, productName) => {
        const block = el("div", "order-product");
        block.appendChild(el("span", "order-product-name", productName));
        const list = el("ul");
        options.forEach((option) => {
          const delta = Number(option.price_delta_paise || 0);
          list.appendChild(
            el(
              "li",
              null,
              `${option.group_name}: ${option.option_name}` +
                (delta ? ` (+${SC.money(delta)})` : "") +
                (option.finish ? ` — ${option.finish}` : "")
            )
          );
        });
        block.appendChild(list);
        card.appendChild(block);
      });

      const addons = item.order_item_addons || [];
      const addonBlock = el("div", "order-product");
      addonBlock.appendChild(el("span", "order-product-name", "Add-ons"));
      const addonList = el("ul");
      if (addons.length) {
        addons.forEach((addon) =>
          addonList.appendChild(
            el("li", null, `${addon.addon_name} — ${SC.money(addon.price_paise)}`)
          )
        );
      } else {
        addonList.appendChild(el("li", "order-none", "None selected"));
      }
      addonBlock.appendChild(addonList);
      card.appendChild(addonBlock);

      wrap.appendChild(card);
    });

    const totals = el("div", "order-totals");
    [
      ["Package total", order.subtotal_paise],
      [`GST (${order.gst_percent}%)`, order.gst_paise],
      ["Total payable", order.total_paise],
      ["Advance", order.advance_amount_paise],
      ["Balance", order.balance_paise],
    ].forEach(([label, value]) => {
      const line = el("div", "order-total-line");
      line.appendChild(el("span", null, label));
      line.appendChild(el("strong", null, SC.money(value)));
      totals.appendChild(line);
    });
    wrap.appendChild(totals);

    // Printable documents for this order. The summary opens for any order;
    // invoices appear once payment for a phase has been captured.
    const docs = el("div", "order-docs");
    docs.appendChild(el("span", "order-docs-label", "Documents"));

    const summaryLink = el("a", "order-doc", "Order summary ↗");
    summaryLink.href = `invoice.html?order=${encodeURIComponent(order.order_number)}`;
    summaryLink.target = "_blank";
    docs.appendChild(summaryLink);

    const invoices = (order.invoices || []).sort(
      (a, b) => a.phase_number - b.phase_number
    );
    if (invoices.length) {
      invoices.forEach((inv) => {
        const link = el(
          "a",
          "order-doc",
          `${inv.phase_label || "Invoice"} — ${inv.invoice_number} ↗`
        );
        link.href = `invoice.html?number=${encodeURIComponent(inv.invoice_number)}`;
        link.target = "_blank";
        docs.appendChild(link);
      });
    } else {
      docs.appendChild(
        el("span", "order-doc-none", "No invoice yet — raised when payment is captured")
      );
    }

    wrap.appendChild(docs);
    wrap.appendChild(trackingEditor(order));
    return wrap;
  }

  // Editable order tracking — the milestones and installment statuses the
  // customer sees on their "Track order" page. Only these operational fields
  // are writable (migration 014 grants UPDATE on exactly these columns to
  // admins); the financial totals above stay read-only and server-computed.
  const STAGE_OPTIONS = [
    ["reserved", "Reserved"],
    ["confirmed", "Confirmed"],
    ["cancelled", "Cancelled"],
    ["production", "Production"],
    ["dispatch", "Dispatch"],
    ["delivered", "Delivered"],
    ["installed", "Installed"],
  ];
  const INSTALL_OPTIONS = [
    ["undecided", "Undecided"],
    ["in_house", "Install with us"],
    ["self", "Own carpenter"],
  ];

  function labelledSelect(labelText, options, selected) {
    const field = el("label", "track-edit-field");
    field.appendChild(el("span", null, labelText));
    const sel = document.createElement("select");
    options.forEach(([value, text]) => {
      const opt = el("option", null, text);
      opt.value = value;
      if (value === selected) opt.selected = true;
      sel.appendChild(opt);
    });
    field.appendChild(sel);
    return { field, input: sel };
  }

  function labelledCheck(labelText, checked) {
    const field = el("label", "track-edit-check");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    field.append(input, el("span", null, labelText));
    return { field, input };
  }

  function trackingEditor(order) {
    const wrap = el("div", "order-track");
    wrap.appendChild(el("span", "order-docs-label", "Tracking — the customer sees this"));

    const stage = labelledSelect("Milestone", STAGE_OPTIONS, order.fulfillment_stage);
    const install = labelledSelect("Installation", INSTALL_OPTIONS, order.installation_choice);
    const confirmation = labelledCheck(
      "Confirmation (80%) received",
      Boolean(order.confirmation_paid_at)
    );
    const dispatch = labelledCheck(
      "Balance on dispatch (20%) received",
      Boolean(order.dispatch_paid_at)
    );

    const grid = el("div", "track-edit-grid");
    grid.append(stage.field, install.field, confirmation.field, dispatch.field);
    wrap.appendChild(grid);

    const saveBtn = el("button", "admin-small", "Save tracking");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      const nowIso = new Date().toISOString();
      const patch = {
        fulfillment_stage: stage.input.value,
        installation_choice: install.input.value,
        // Keep the original timestamp if it was already set; stamp now when the
        // admin first ticks it; clear it when unticked.
        confirmation_paid_at: confirmation.input.checked
          ? order.confirmation_paid_at || nowIso
          : null,
        dispatch_paid_at: dispatch.input.checked
          ? order.dispatch_paid_at || nowIso
          : null,
      };
      const { error } = await sb.from("orders").update(patch).eq("id", order.id);
      saveBtn.disabled = false;
      if (error) {
        message(`Could not save tracking: ${error.message}`, true);
        return;
      }
      Object.assign(order, patch);
      message(`Order ${order.order_number} tracking updated.`);
    });
    wrap.appendChild(saveBtn);

    return wrap;
  }

  async function ordersPanel() {
    const { data, error } = await sb
      .from("orders")
      .select(
        `id, order_number, status, fulfillment_stage, installation_choice,
         confirmation_paid_at, dispatch_paid_at,
         subtotal_paise, gst_percent, gst_paise,
         total_paise, advance_amount_paise, balance_paise, placed_at,
         contact_name, contact_email, contact_phone,
         delivery_address_line, delivery_city, delivery_pin_code,
         order_items (
           package_name, base_price_paise, line_total_paise,
           order_item_options ( product_name, group_name, option_name,
                                finish, material, price_delta_paise ),
           order_item_addons ( addon_name, price_paise )
         ),
         invoices ( invoice_number, phase_label, phase_number, total_paise )`
      )
      .order("placed_at", { ascending: false });

    if (error) throw error;

    const frag = document.createDocumentFragment();

    const waiting = data.filter((o) => o.status === "pending_advance");
    if (waiting.length) {
      frag.appendChild(
        el(
          "p",
          "dash-note",
          `${waiting.length} order(s) reserved but not paid. These customers accepted terms and gave an address, then stopped at payment — worth a call.`
        )
      );
    }

    frag.appendChild(
      el("p", "dash-note", "Click an order to see exactly what was ordered.")
    );

    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");

    const thead = el("thead");
    const hr = el("tr");
    ["Order", "Customer", "Packages", "Delivery", "Total", "Advance", "Status", "Placed"]
      .forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);

    const tbody = el("tbody");

    if (!data.length) {
      const tr = el("tr");
      const td = el("td", "dash-empty", "No orders yet.");
      td.colSpan = 8;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    data.forEach((order) => {
      const tone =
        order.status === "pending_advance"
          ? "warn"
          : ["cancelled", "refunded"].includes(order.status)
          ? "muted"
          : "ok";

      const summary = el("tr", "order-row");
      const cells = [
        el("strong", null, order.order_number),
        contactCell(order.contact_name, order.contact_email, order.contact_phone),
        order.order_items.map((i) => i.package_name).join(", ") || "—",
        addressOf(order, "delivery_"),
        SC.money(order.total_paise),
        SC.money(order.advance_amount_paise),
        pill(ORDER_STATUS[order.status] || order.status, tone),
        when(order.placed_at),
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
      detailCell.colSpan = 8;
      detailCell.appendChild(orderDetail(order));
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
  // Abandoned carts
  // ------------------------------------------------------------------
  // The highest-value view here: someone who configured a room and stopped is
  // a warm lead that nothing else surfaces.

  async function cartsPanel() {
    const [{ data: carts, error: cartError }, { data: totals }] = await Promise.all([
      sb
        .from("carts")
        .select(
          `id, user_id, updated_at, created_at,
           profiles ( full_name, email, phone, address_line, city, pin_code ),
           cart_items ( id, packages ( name ) )`
        )
        .eq("status", "active")
        .order("updated_at", { ascending: false }),
      sb.from("cart_totals").select("cart_id, item_count, subtotal_paise"),
    ]);

    if (cartError) throw cartError;

    const totalById = new Map((totals || []).map((t) => [t.cart_id, t]));

    // An empty cart is not an abandoned cart -- it is someone who signed in
    // and looked around, and listing them buries the real leads.
    const withItems = (carts || []).filter((c) => c.cart_items.length > 0);

    const rows = withItems.map((cart) => {
      const t = totalById.get(cart.id);
      const packages = cart.cart_items.map((i) => i.packages?.name).join(", ");
      return [
        contactCell(
          cart.profiles?.full_name,
          cart.profiles?.email,
          cart.profiles?.phone
        ),
        packages || "—",
        String(t?.item_count ?? cart.cart_items.length),
        SC.money(t?.subtotal_paise ?? 0),
        addressOf(cart.profiles || {}),
        ago(cart.updated_at),
      ];
    });

    const frag = document.createDocumentFragment();
    frag.appendChild(
      el(
        "p",
        "dash-note",
        "Carts with packages saved but no order placed. Sorted by most recently touched."
      )
    );
    frag.appendChild(
      table(
        ["Customer", "Packages", "Items", "Value (ex GST)", "Address", "Last activity"],
        rows
      )
    );
    return frag;
  }

  // ------------------------------------------------------------------
  // Registrations
  // ------------------------------------------------------------------

  async function peoplePanel() {
    const { data, error } = await sb
      .from("profiles")
      .select(
        "id, customer_number, full_name, email, phone, address_line, city, state_name, pin_code, gstin, is_admin, created_at"
      )
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = data.map((person) => [
      el(
        "strong",
        null,
        // Padded to match how it appears inside invoice numbers.
        person.customer_number != null
          ? String(person.customer_number).padStart(2, "0")
          : "—"
      ),
      contactCell(person.full_name, person.email, person.phone),
      addressOf(person),
      person.gstin || "—",
      person.is_admin ? pill("Staff", "ok") : "Customer",
      when(person.created_at),
    ]);

    const frag = document.createDocumentFragment();
    frag.appendChild(
      el("p", "dash-note", `${data.length} registered account(s), newest first.`)
    );
    frag.appendChild(
      table(["Cus ID", "Customer", "Address", "GSTIN", "Type", "Registered"], rows)
    );
    return frag;
  }

  // ------------------------------------------------------------------
  // Invoices
  // ------------------------------------------------------------------

  async function invoicesPanel() {
    const { data, error } = await sb
      .from("invoices")
      .select(
        `invoice_number, phase_label, phase_number, issue_date, buyer_name,
         taxable_value_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
         is_interstate, created_at,
         orders ( order_number )`
      )
      .order("created_at", { ascending: false });

    if (error) throw error;

    const rows = data.map((invoice) => {
      const open = el("a", "invoice-open", "Open ↗");
      open.href = `invoice.html?number=${encodeURIComponent(invoice.invoice_number)}`;
      open.target = "_blank";

      const tax =
        Number(invoice.cgst_paise) + Number(invoice.sgst_paise) + Number(invoice.igst_paise);

      return [
        el("strong", null, invoice.invoice_number),
        invoice.phase_label || `Phase ${invoice.phase_number}`,
        invoice.buyer_name,
        invoice.orders?.order_number || "—",
        SC.money(invoice.taxable_value_paise),
        `${SC.money(tax)} (${invoice.is_interstate ? "IGST" : "CGST+SGST"})`,
        SC.money(invoice.total_paise),
        when(invoice.issue_date),
        open,
      ];
    });

    const frag = document.createDocumentFragment();
    frag.appendChild(
      el(
        "p",
        "dash-note",
        data.length
          ? `Latest invoice: ${data[0].invoice_number}. A manually raised invoice should use the next global sequence number.`
          : "No invoices yet. The first is raised automatically when an advance payment is captured."
      )
    );
    frag.appendChild(
      table(
        ["Invoice", "Phase", "Customer", "Order", "Taxable", "Tax", "Total", "Issued", ""],
        rows
      )
    );
    return frag;
  }

  // ------------------------------------------------------------------
  // Payments
  // ------------------------------------------------------------------

  async function paymentsPanel() {
    const [{ data: payments, error }, { data: refunds }] = await Promise.all([
      sb
        .from("payments")
        .select(
          `id, provider, provider_order_id, provider_payment_id, purpose,
           amount_paise, status, method, failure_reason, created_at,
           orders ( order_number, contact_name )`
        )
        .order("created_at", { ascending: false }),
      sb
        .from("refunds")
        .select("id, payment_id, amount_paise, status, reason, created_at")
        .order("created_at", { ascending: false }),
    ]);

    if (error) throw error;

    const refundByPayment = new Map();
    (refunds || []).forEach((r) => refundByPayment.set(r.payment_id, r));

    const rows = (payments || []).map((p) => {
      const tone =
        p.status === "captured"
          ? "ok"
          : ["failed", "cancelled"].includes(p.status)
          ? "bad"
          : "warn";
      const refund = refundByPayment.get(p.id);

      return [
        p.orders?.order_number || "—",
        p.orders?.contact_name || "—",
        SC.money(p.amount_paise),
        pill(PAYMENT_STATUS[p.status] || p.status, tone),
        p.method || "—",
        refund ? `${SC.money(refund.amount_paise)} (${refund.status})` : "—",
        p.provider_payment_id || p.provider_order_id || "—",
        p.failure_reason || "—",
        when(p.created_at),
      ];
    });

    return table(
      [
        "Order",
        "Customer",
        "Amount",
        "Status",
        "Method",
        "Refund",
        "Gateway ID",
        "Note",
        "When",
      ],
      rows
    );
  }

  // ------------------------------------------------------------------
  // Headline counts
  // ------------------------------------------------------------------

  async function renderStats() {
    const [orders, carts, people, paid, lastInvoice] = await Promise.all([
      sb.from("orders").select("id", { count: "exact", head: true })
        .eq("status", "pending_advance"),
      sb.from("cart_items").select("id", { count: "exact", head: true }),
      sb.from("profiles").select("id", { count: "exact", head: true }),
      sb.from("payments").select("id", { count: "exact", head: true })
        .eq("status", "captured"),
      // The latest number issued, so a manually raised invoice continues the
      // sequence instead of colliding with or skipping it.
      sb.from("invoices").select("invoice_number")
        .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    ]);

    const cards = [
      ["Awaiting payment", String(orders.count ?? 0), "warn", false],
      ["Items in open carts", String(carts.count ?? 0), "muted", false],
      ["Registered accounts", String(people.count ?? 0), "muted", false],
      ["Payments captured", String(paid.count ?? 0), "ok", false],
      ["Latest invoice", lastInvoice.data?.invoice_number ?? "None yet", "ok", true],
    ];

    stats.textContent = "";
    cards.forEach(([label, value, tone, isText]) => {
      const card = el("div", `stat-card stat-${tone}`);
      card.appendChild(
        el("span", `stat-value${isText ? " is-text" : ""}`, value)
      );
      card.appendChild(el("span", "stat-label", label));
      stats.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // Tabs
  // ------------------------------------------------------------------

  const PANELS = {
    orders: ordersPanel,
    carts: cartsPanel,
    people: peoplePanel,
    payments: paymentsPanel,
    invoices: invoicesPanel,
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
        `Could not load: ${error.message}. If this says permission denied, migration 005 has not been run.`,
        true
      );
    }
  }

  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".tab")
        .forEach((b) => b.classList.toggle("is-active", b === btn));
      show(btn.dataset.tab);
    });
  });

  await renderStats();
  await show("orders");
})();
