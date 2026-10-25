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
  function orderDetail(order, catalog, links) {
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

      // Only older orders carry a package base price; new orders price per
      // colour, so show the base line only when it is non-zero.
      if (Number(item.base_price_paise) > 0) {
        card.appendChild(
          el("p", "order-line-base", `Base ${SC.money(item.base_price_paise)}`)
        );
      }

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
          const price = Number(option.price_delta_paise || 0);
          list.appendChild(
            el(
              "li",
              null,
              `${option.group_name}: ${option.option_name}` +
                (price ? ` — ${SC.money(price)}` : "") +
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
    const totalLines = [["Package total", order.subtotal_paise]];
    if (order.delivery_charge_paise) totalLines.push(["Delivery", order.delivery_charge_paise]);
    totalLines.push(
      [`GST (${order.gst_percent}%)`, order.gst_paise],
      ["Total payable", order.total_paise],
      ["Advance", order.advance_amount_paise],
      ["Balance", order.balance_paise]
    );
    totalLines.forEach(([label, value]) => {
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

    const summaryLink = el("a", "order-doc", "Order summary ↗︎");
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
          `${inv.phase_label || "Invoice"} — ${inv.invoice_number} ↗︎`
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
    if (catalog) wrap.appendChild(revisionEditor(order, catalog));
    wrap.appendChild(installmentEditor(order, links || new Map()));
    wrap.appendChild(trackingEditor(order));
    return wrap;
  }

  // Installment payment links — the admin creates and emails a Razorpay link
  // for the 80% then the 20%, staying in control of when the customer is asked
  // to pay. Amounts come from the current balance; the server recomputes them.
  function installmentEditor(order, links) {
    const wrap = el("div", "order-track");
    wrap.appendChild(el("span", "order-docs-label", "Installment payment links"));

    const balance = Number(order.balance_paise || 0);
    const confirmation = SC.floorRupees(balance * 0.8);
    const advancePaid = order.status !== "pending_advance";

    const phases = [
      ["confirmation", "Confirmation (80%)", confirmation, order.confirmation_paid_at],
      ["dispatch", "Balance on dispatch (20%)", balance - confirmation, order.dispatch_paid_at],
    ];

    phases.forEach(([phase, label, amount, paidAt]) => {
      const row = el("div", "installment-row");
      row.appendChild(el("span", "installment-label", `${label} — ${SC.money(amount)}`));

      if (paidAt) {
        row.appendChild(pill(`Paid ${when(paidAt)}`, "ok"));
        wrap.appendChild(row);
        return;
      }

      const existing = (links.get(order.id) || [])
        .filter((l) => l.phase === phase)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];

      if (existing && existing.status === "created") {
        row.appendChild(pill("Link sent", "warn"));
        const open = el("a", "installment-link", "Open ↗︎");
        open.href = existing.short_url;
        open.target = "_blank";
        row.appendChild(open);
      }

      const btn = el("button", "admin-small", existing ? "Resend / new link" : "Send payment link");
      btn.type = "button";
      btn.disabled = !advancePaid;
      if (!advancePaid) btn.title = "The advance must be paid first";
      btn.addEventListener("click", async () => {
        if (
          !window.confirm(
            `Create and email a Razorpay payment link for the ${label} (${SC.money(amount)})?`
          )
        )
          return;
        btn.disabled = true;
        const { data, error } = await sb.functions.invoke("create-installment-link", {
          body: { order_id: order.id, phase },
        });
        btn.disabled = false;
        if (error) {
          message(`Could not create link: ${error.message}`, true);
          window.alert(`Could not create the payment link: ${error.message}`);
          return;
        }
        window.alert(
          `Payment link created and emailed to ${data.emailed_to}.\n\n` +
            `Amount: ${SC.money(data.amount_paise)}\nLink: ${data.short_url}`
        );
        show("orders");
      });
      row.appendChild(btn);
      wrap.appendChild(row);
    });

    return wrap;
  }

  // Order revision — swap a product's size/colour (same package) and set a
  // delivery charge, after a site visit. All money is recomputed server-side by
  // the revise-order function; this only gathers the choices.
  function revisionEditor(order, catalog) {
    const wrap = el("div", "order-track");
    wrap.appendChild(el("span", "order-docs-label", "Revise order (after site visit)"));

    // Per product, a size + colour dropdown built from the same package's
    // catalog, defaulting to what was ordered. Colours follow the chosen size.
    const controls = []; // { rowId, select } to turn into option_changes on save

    (order.order_items || []).forEach((item) => {
      const cat = catalog.get(item.package_key);
      if (!cat) return;

      // Group this item's snapshot option rows by product, then by group name.
      const byProduct = new Map();
      (item.order_item_options || []).forEach((opt) => {
        if (!byProduct.has(opt.product_name)) byProduct.set(opt.product_name, {});
        byProduct.get(opt.product_name)[opt.group_name] = opt;
      });

      byProduct.forEach((rows, productName) => {
        const prod = cat.products.get(productName);
        if (!prod) return;

        const block = el("div", "revise-product");
        block.appendChild(el("span", "revise-product-name", `${item.package_name} — ${productName}`));

        const grid = el("div", "track-edit-grid");

        // Size ----------------------------------------------------------
        const sizeRow = rows["Size"];
        const colourRow = rows["Colour"];
        const colourSel = document.createElement("select");

        function fillColours(sizeId) {
          colourSel.textContent = "";
          prod.colours
            .filter((c) => c.parent_option_id === sizeId)
            .forEach((c) => {
              const o = el("option", null, c.name);
              o.value = c.id;
              if (colourRow && c.name === colourRow.option_name) o.selected = true;
              colourSel.appendChild(o);
            });
        }

        if (sizeRow && prod.sizes.length) {
          const sizeField = el("label", "track-edit-field");
          sizeField.appendChild(el("span", null, "Size"));
          const sizeSel = document.createElement("select");
          let selectedSizeId = prod.sizes[0]?.id;
          prod.sizes.forEach((s) => {
            const o = el("option", null, s.name);
            o.value = s.id;
            if (s.name === sizeRow.option_name) {
              o.selected = true;
              selectedSizeId = s.id;
            }
            sizeSel.appendChild(o);
          });
          sizeSel.addEventListener("change", () => fillColours(sizeSel.value));
          sizeField.appendChild(sizeSel);
          grid.appendChild(sizeField);
          controls.push({ rowId: sizeRow.id, select: sizeSel });
          fillColours(selectedSizeId);
        }

        // Colour --------------------------------------------------------
        if (colourRow && prod.colours.length) {
          if (!sizeRow) fillColours(prod.sizes[0]?.id);
          const colourField = el("label", "track-edit-field");
          colourField.appendChild(el("span", null, "Colour"));
          colourField.appendChild(colourSel);
          grid.appendChild(colourField);
          controls.push({ rowId: colourRow.id, select: colourSel });
        }

        block.appendChild(grid);
        wrap.appendChild(block);
      });
    });

    // Delivery charge (rupees) ---------------------------------------------
    const deliveryField = el("label", "track-edit-field");
    deliveryField.appendChild(el("span", null, "Delivery charge (₹, +18% GST)"));
    const deliveryInput = document.createElement("input");
    deliveryInput.type = "number";
    deliveryInput.min = "0";
    deliveryInput.value = String(Number(order.delivery_charge_paise || 0) / 100);
    deliveryField.appendChild(deliveryInput);
    const deliveryWrap = el("div", "track-edit-grid");
    deliveryWrap.appendChild(deliveryField);
    wrap.appendChild(deliveryWrap);

    const saveBtn = el("button", "admin-small", "Apply changes & recompute");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      if (
        !window.confirm(
          "Recompute this order's totals with the selected sizes/colours and delivery charge?\n\nThe 80% / 20% installment amounts will change to match."
        )
      )
        return;
      saveBtn.disabled = true;
      const option_changes = controls.map((c) => ({ id: c.rowId, new_option_id: c.select.value }));
      const { data, error } = await sb.functions.invoke("revise-order", {
        body: {
          order_id: order.id,
          option_changes,
          delivery_charge_paise: Math.round(Number(deliveryInput.value || 0) * 100),
        },
      });
      saveBtn.disabled = false;
      if (error) {
        message(`Could not revise: ${error.message}`, true);
        window.alert(`Could not revise the order: ${error.message}`);
        return;
      }
      window.alert(
        `Order updated.\n\nNew total: ${SC.money(data.total_paise)}\nNew balance: ${SC.money(
          data.balance_paise
        )}`
      );
      show("orders");
    });
    wrap.appendChild(saveBtn);

    return wrap;
  }

  // Editable order tracking — the milestones and installment statuses the
  // customer sees on their "Track order" page. Only these operational fields
  // are writable (migration 014 grants UPDATE on exactly these columns to
  // admins); the financial totals above stay read-only and server-computed.
  // "Confirmed" unlocks the customer's 80% installment; "Ready to dispatch"
  // unlocks the final 20% (stage 'dispatch'). The customer pays before we ship.
  const STAGE_OPTIONS = [
    ["reserved", "Reserved"],
    ["confirmed", "Confirmed"],
    ["cancelled", "Cancelled"],
    ["production", "Production"],
    ["dispatch", "Ready to dispatch"],
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
      window.alert("Tracking saved.");
    });
    wrap.appendChild(saveBtn);

    return wrap;
  }

  // The live catalog, indexed by package key -> product name -> its size and
  // colour options, so the revision editor can offer valid swaps within the
  // same package. Best-effort: if it fails to load, the revision UI is simply
  // omitted and the rest of the order detail still renders.
  async function loadRevisionCatalog() {
    const { data, error } = await sb
      .from("packages")
      .select(
        `key, package_products ( name,
           product_option_groups ( name,
             product_options ( id, name, parent_option_id, is_active ) ) )`
      );
    if (error) return null;

    const index = new Map();
    (data || []).forEach((pkg) => {
      const products = new Map();
      (pkg.package_products || []).forEach((prod) => {
        let sizes = [];
        let colours = [];
        (prod.product_option_groups || []).forEach((g) => {
          const opts = (g.product_options || []).filter((o) => o.is_active !== false);
          if (g.name === "Size") sizes = opts.map((o) => ({ id: o.id, name: o.name }));
          if (g.name === "Colour") {
            colours = opts.map((o) => ({
              id: o.id,
              name: o.name,
              parent_option_id: o.parent_option_id,
            }));
          }
        });
        products.set(prod.name, { sizes, colours });
      });
      index.set(pkg.key, { products });
    });
    return index;
  }

  async function ordersPanel() {
    const { data, error } = await sb
      .from("orders")
      .select(
        `id, order_number, status, fulfillment_stage, installation_choice,
         confirmation_paid_at, dispatch_paid_at,
         subtotal_paise, gst_percent, gst_paise, delivery_charge_paise,
         total_paise, advance_amount_paise, balance_paise, placed_at,
         contact_name, contact_email, contact_phone,
         delivery_address_line, delivery_city, delivery_pin_code,
         order_items (
           id, package_key, package_name, base_price_paise, line_total_paise,
           order_item_options ( id, product_name, group_name, option_name,
                                finish, material, price_delta_paise ),
           order_item_addons ( addon_name, price_paise )
         ),
         invoices ( invoice_number, phase_label, phase_number, total_paise )`
      )
      .order("placed_at", { ascending: false });

    if (error) throw error;

    const catalog = await loadRevisionCatalog();

    // Installment payment links, indexed by order, so each order shows the
    // status of any link already sent.
    const linksByOrder = new Map();
    const { data: linkRows } = await sb
      .from("installment_links")
      .select("order_id, phase, status, short_url, amount_paise, created_at")
      .order("created_at", { ascending: false });
    (linkRows || []).forEach((l) => {
      if (!linksByOrder.has(l.order_id)) linksByOrder.set(l.order_id, []);
      linksByOrder.get(l.order_id).push(l);
    });

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
      detailCell.appendChild(orderDetail(order, catalog, linksByOrder));
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
      const open = el("a", "invoice-open", "Open ↗︎");
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

  const PURPOSE_LABEL = {
    advance: "Advance",
    confirmation: "Confirmation 80%",
    dispatch: "Final 20%",
    balance: "Balance",
  };

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

    // Sum refunds per payment; pending + processed both count against what is
    // still refundable. Refunds arrive newest-first, so the first seen is latest.
    const refundedByPayment = new Map();
    const latestRefundByPayment = new Map();
    (refunds || []).forEach((r) => {
      if (["pending", "processed"].includes(r.status)) {
        refundedByPayment.set(
          r.payment_id,
          (refundedByPayment.get(r.payment_id) || 0) + Number(r.amount_paise || 0)
        );
      }
      if (!latestRefundByPayment.has(r.payment_id)) latestRefundByPayment.set(r.payment_id, r);
    });

    const rows = (payments || []).map((p) => {
      const tone =
        p.status === "captured"
          ? "ok"
          : ["failed", "cancelled"].includes(p.status)
          ? "bad"
          : "warn";
      const refunded = refundedByPayment.get(p.id) || 0;
      const latest = latestRefundByPayment.get(p.id);
      const remaining = p.status === "captured" ? Number(p.amount_paise) - refunded : 0;

      let action = "—";
      if (p.status === "captured" && remaining > 0) {
        const btn = el("button", "admin-small admin-danger", "Refund");
        btn.type = "button";
        btn.addEventListener("click", () => initiateRefund(p, remaining));
        action = btn;
      }

      return [
        p.orders?.order_number || "—",
        p.orders?.contact_name || "—",
        PURPOSE_LABEL[p.purpose] || p.purpose || "—",
        SC.money(p.amount_paise),
        pill(PAYMENT_STATUS[p.status] || p.status, tone),
        p.method || "—",
        refunded ? `${SC.money(refunded)} (${latest?.status || "—"})` : "—",
        p.provider_payment_id || p.provider_order_id || "—",
        p.failure_reason || "—",
        when(p.created_at),
        action,
      ];
    });

    return table(
      [
        "Order",
        "Customer",
        "Purpose",
        "Amount",
        "Status",
        "Method",
        "Refunded",
        "Gateway ID",
        "Note",
        "When",
        "Action",
      ],
      rows
    );
  }

  // Initiate a refund against one captured payment (full or partial).
  async function initiateRefund(payment, remaining) {
    const remainingRupees = remaining / 100;
    const input = window.prompt(
      `Refund ${payment.orders?.order_number || "payment"} — amount in ₹.\n` +
        `Refundable remaining: ₹${remainingRupees.toLocaleString("en-IN")}.`,
      String(remainingRupees)
    );
    if (input === null) return;
    const amountPaise = Math.round(Number(input) * 100);
    if (!Number.isFinite(amountPaise) || amountPaise <= 0) {
      window.alert("Please enter a valid amount.");
      return;
    }
    if (amountPaise > remaining) {
      window.alert(
        `That exceeds the refundable remaining (₹${remainingRupees.toLocaleString("en-IN")}).`
      );
      return;
    }
    const reason = window.prompt("Reason for the refund (optional):", "") || null;
    if (
      !window.confirm(
        `Refund ${SC.money(amountPaise)} to the customer?\n\n` +
          `Razorpay does not return its processing fee on a refund.`
      )
    )
      return;

    const { data, error } = await sb.functions.invoke("create-refund", {
      body: { payment_id: payment.id, amount_paise: amountPaise, reason },
    });
    if (error) {
      const detail = await functionErrorText(error);
      message(`Refund failed: ${detail}`, true);
      window.alert(`Refund failed: ${detail}`);
      return;
    }
    if (data?.error) {
      window.alert(`Refund failed: ${data.error}`);
      return;
    }
    window.alert(
      `Refund initiated: ${SC.money(data.amount_paise)}.\n\n` +
        `It shows here as "processed" once Razorpay completes it (usually 5–7 business days).`
    );
    show("payments");
  }

  // Pull the Edge Function's own error text out of a non-2xx response.
  async function functionErrorText(error) {
    const response = error?.context;
    if (response && typeof response.clone === "function") {
      try {
        const body = await response.clone().json();
        if (body?.error) return body.error;
      } catch {
        /* not JSON */
      }
    }
    return error.message || "Unknown error";
  }

  // ------------------------------------------------------------------
  // Headline counts
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Marketing — one common email to a computed audience
  // ------------------------------------------------------------------

  async function marketingPanel() {
    const frag = document.createDocumentFragment();
    const myEmail = SC.profile?.email || SC.session?.user?.email || "";

    // Default copy per audience. "Hi <name>," and the sign-off / unsubscribe
    // line are added automatically by the send-marketing-email function, so
    // these are just the middle of the message. Editable before sending.
    const DEFAULTS = {
      registered_new: {
        subject: "A calmer, more personal space — designed around you",
        body:
          "Thank you for joining Safe Creatives — we're really glad you're here.\n\n" +
          "Our sensory rooms are premium, package-based interiors built around comfort, calm and inclusivity — functional, beautiful spaces that can be installed in as little as 20 days.\n\n" +
          "A few reasons our customers love our Sensory rooms:\n" +
          "• Thoughtfully curated packages, fully customisable to you\n" +
          "• Installed in ~20 days, backed by a 10-year warranty\n" +
          "• Up to 70% resale & buy-back whenever you choose to upgrade\n\n" +
          "Whenever you're ready to explore, browse our packages at safecreatives.com — or email us at ashwanth@safecreatives.com or call / WhatsApp us at +91 97898 90877 for a free consultation. We'd love to help you create a space that feels just right.",
      },
      registered_old: {
        subject: "Still thinking about a calmer, more personal space?",
        body:
          "We reached out a little while ago about creating a sensory room with you, and we wanted to check back in.\n\n" +
          "Our sensory rooms are premium, package-based interiors built around comfort, calm and inclusivity — installed in as little as 20 days and designed entirely around you.\n\n" +
          "A few reasons our customers love our Sensory rooms:\n" +
          "• Thoughtfully curated packages, fully customisable to you\n" +
          "• Installed in ~20 days, backed by a 10-year warranty\n" +
          "• Up to 70% resale & buy-back whenever you choose to upgrade\n\n" +
          "If now's a better time, we'd love to help. Browse our packages at safecreatives.com, or email ashwanth@safecreatives.com or call / WhatsApp +91 97898 90877 for a free consultation.",
      },
      abandoned_cart: {
        subject: "Your sensory room is still waiting for you",
        body:
          "We noticed you started designing your sensory room with us but didn't quite finish — and we didn't want you to miss out.\n\n" +
          "Good news: your selection is still saved, so you can pick up right where you left off whenever you're ready.\n\n" +
          "A few reasons our customers love our Sensory rooms:\n" +
          "• Fully customisable, installed in as little as 20 days\n" +
          "• Backed by a 10-year warranty\n" +
          "• Up to 70% resale & buy-back when you upgrade\n\n" +
          "Have a question, or want a quick consultation to tailor the space to you? Email us at ashwanth@safecreatives.com or call / WhatsApp us at +91 97898 90877 — we're happy to help.\n\n" +
          "Ready to continue? Log in at safecreatives.com to complete your order.",
      },
    };

    frag.appendChild(
      el(
        "p",
        "dash-note",
        "Send a one-off marketing email to a group of registered customers. The list is built on the server (staff and unsubscribed excluded). Pick an audience, untick anyone you don't want, and send — each person is emailed individually and greeted with the part of their email before the “@”. You can also download every registered profile, with its segment, as a CSV at the bottom."
      )
    );

    const mkField = (labelText, control) => {
      const wrap = el("div", "mkt-field");
      wrap.appendChild(el("label", "mkt-label", labelText));
      wrap.appendChild(control);
      return wrap;
    };

    const catSel = document.createElement("select");
    catSel.className = "mkt-select";
    [
      ["registered_new", "New registrations — visited, no cart/order, not emailed yet"],
      ["registered_old", "Old registrations — visited, no cart/order, already emailed"],
      ["abandoned_cart", "Abandoned carts — a saved cart but no order"],
    ].forEach(([v, l]) => {
      const o = el("option", null, l);
      o.value = v;
      catSel.appendChild(o);
    });
    frag.appendChild(mkField("Audience", catSel));

    const countNote = el("p", "dash-note", "Counting recipients…");
    frag.appendChild(countNote);

    // Recipient picker: the full audience as ticked rows, with a filter and a
    // select-all. Only the ticked addresses are sent to.
    const recipWrap = el("div", "mkt-reciplist");
    const recipHead = el("div", "mkt-recip-head");
    const selectAllLabel = el("label", "mkt-recip-all");
    const selectAllChk = document.createElement("input");
    selectAllChk.type = "checkbox";
    selectAllChk.checked = true;
    selectAllLabel.append(selectAllChk, el("span", null, "Select all"));
    const selectedNote = el("span", "mkt-recip-count", "");
    recipHead.append(selectAllLabel, selectedNote);
    const filterInput = document.createElement("input");
    filterInput.type = "search";
    filterInput.className = "mkt-input mkt-recip-filter";
    filterInput.placeholder = "Filter by email…";
    const listBox = el("div", "mkt-recip-items");
    recipWrap.append(recipHead, filterInput, listBox);
    frag.appendChild(recipWrap);

    function selectedEmails() {
      return [...listBox.querySelectorAll("input[type=checkbox]")]
        .filter((b) => b.checked)
        .map((b) => b.value);
    }

    function updateSelected() {
      const boxes = [...listBox.querySelectorAll("input[type=checkbox]")];
      const checked = boxes.filter((b) => b.checked).length;
      selectedNote.textContent = boxes.length ? `${checked} of ${boxes.length} selected` : "";
      selectAllChk.checked = boxes.length > 0 && checked === boxes.length;
      selectAllChk.indeterminate = checked > 0 && checked < boxes.length;
      sendBtn.disabled = checked === 0;
      sendBtn.textContent = checked ? `Send to ${checked} recipient(s)` : "No recipients selected";
    }

    function renderChecklist(emails) {
      listBox.textContent = "";
      emails.forEach((email) => {
        const row = el("label", "mkt-recip-item");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = true;
        cb.value = email;
        row.append(cb, el("span", null, email));
        listBox.appendChild(row);
      });
      filterInput.value = "";
      updateSelected();
    }

    selectAllChk.addEventListener("change", () => {
      listBox.querySelectorAll("input[type=checkbox]").forEach((b) => (b.checked = selectAllChk.checked));
      updateSelected();
    });
    listBox.addEventListener("change", updateSelected);
    filterInput.addEventListener("input", () => {
      const q = filterInput.value.trim().toLowerCase();
      listBox.querySelectorAll(".mkt-recip-item").forEach((row) => {
        row.style.display = row.querySelector("input").value.toLowerCase().includes(q) ? "" : "none";
      });
    });

    const subjectI = document.createElement("input");
    subjectI.type = "text";
    subjectI.className = "mkt-input";
    subjectI.placeholder = "e.g. Your sensory room is waiting";
    frag.appendChild(mkField("Subject", subjectI));

    const bodyT = document.createElement("textarea");
    bodyT.className = "mkt-textarea";
    bodyT.rows = 8;
    bodyT.placeholder = "Write the message. “Hi <name>,” is added automatically at the top of each email.";
    frag.appendChild(mkField("Message (same for everyone in this audience)", bodyT));

    const statusP = el("p", "admin-hint", "");
    const actions = el("div", "admin-inline");
    const testBtn = el("button", "admin-secondary", myEmail ? `Send test to ${myEmail}` : "Send test");
    testBtn.type = "button";
    const sendBtn = el("button", "admin-primary", "Send");
    sendBtn.type = "button";
    sendBtn.disabled = true;
    actions.append(testBtn, sendBtn);
    frag.append(actions, statusP);

    async function invoke(payload) {
      const { data, error } = await sb.functions.invoke("send-marketing-email", { body: payload });
      if (error) {
        let detail = error.message;
        try {
          const b = await error.context.json();
          if (b && (b.error || b.detail)) detail = [b.error, b.detail].filter(Boolean).join(" — ");
        } catch (_ignored) {
          /* no body */
        }
        throw new Error(detail);
      }
      if (data && data.error) throw new Error([data.error, data.detail].filter(Boolean).join(" — "));
      return data;
    }

    async function refreshCount() {
      countNote.textContent = "Counting recipients…";
      listBox.textContent = "";
      sendBtn.disabled = true;
      try {
        const data = await invoke({ category: catSel.value, dry_run: true });
        const emails = data.emails || [];
        countNote.textContent = emails.length
          ? `${emails.length} recipient(s) in this audience. Untick anyone you don't want to email.`
          : "No recipients in this audience.";
        renderChecklist(emails);
      } catch (e) {
        countNote.textContent = `Could not count recipients: ${e.message}`;
        listBox.textContent = "";
        updateSelected();
      }
    }

    const applyDefaults = () => {
      const d = DEFAULTS[catSel.value];
      if (d) {
        subjectI.value = d.subject;
        bodyT.value = d.body;
      }
    };
    catSel.addEventListener("change", () => {
      applyDefaults();
      refreshCount();
    });

    testBtn.addEventListener("click", async () => {
      if (!myEmail) return void (statusP.textContent = "No email on your account to send a test to.");
      if (!subjectI.value.trim() || !bodyT.value.trim()) return void (statusP.textContent = "Add a subject and a message first.");
      testBtn.disabled = true;
      statusP.textContent = "Sending test…";
      try {
        const data = await invoke({ category: catSel.value, subject: subjectI.value.trim(), body: bodyT.value, test_email: myEmail });
        statusP.textContent = data.ok === false && data.reason === "email_not_configured"
          ? "Email isn’t configured on the server (RESEND_API_KEY)."
          : `Test sent to ${myEmail}.`;
      } catch (e) {
        statusP.textContent = `Test failed: ${e.message}`;
      } finally {
        testBtn.disabled = false;
      }
    });

    sendBtn.addEventListener("click", async () => {
      const chosen = selectedEmails();
      if (!chosen.length) return;
      if (!subjectI.value.trim() || !bodyT.value.trim()) return void (statusP.textContent = "Add a subject and a message first.");
      if (!window.confirm(`Send this email to ${chosen.length} selected customer(s)? This cannot be undone.`)) return;
      sendBtn.disabled = true;
      testBtn.disabled = true;
      statusP.textContent = "Sending…";
      try {
        const data = await invoke({ category: catSel.value, subject: subjectI.value.trim(), body: bodyT.value, recipients: chosen });
        statusP.textContent = data.ok === false && data.reason === "email_not_configured"
          ? "Email isn’t configured on the server (RESEND_API_KEY)."
          : `Sent to ${data.sent} recipient(s).`
            + (data.failed ? ` ${data.failed} failed.` : "")
            + (data.failed && data.detail ? ` First error — ${data.detail}` : "");
        // Everyone just emailed moves from "new" to "old" — rebuild the list.
        if (data.sent) await refreshCount();
      } catch (e) {
        statusP.textContent = `Send failed: ${e.message}`;
      } finally {
        testBtn.disabled = false;
        updateSelected();
      }
    });

    // --- CSV export of all registered profiles --------------------------
    const csvSection = el("div", "mkt-csv");
    csvSection.appendChild(
      el("p", "mkt-csv-note",
        "Export every registered profile — name, contact, location and which segment they fall into (New / Old registration, Abandoned cart, Customer) — as a spreadsheet.")
    );
    const csvBtn = el("button", "admin-secondary", "Download all profiles (CSV)");
    csvBtn.type = "button";
    csvSection.appendChild(csvBtn);
    frag.appendChild(csvSection);

    const CSV_COLUMNS = [
      ["name", "Name"], ["email", "Email"], ["phone", "Phone"], ["city", "City"],
      ["state", "State"], ["pin_code", "PIN code"], ["registered_at", "Registered on"],
      ["segment", "Segment"], ["emailed", "Emailed before"], ["last_emailed_at", "Last emailed"],
      ["emails_sent", "Emails sent"], ["has_abandoned_cart", "Abandoned cart"],
      ["unsubscribed", "Unsubscribed"], ["orders_placed", "Orders placed"],
    ];
    const DATE_COLS = new Set(["registered_at", "last_emailed_at"]);
    const csvDate = (v) => (v ? new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : "");
    const csvCell = (v) => {
      const s = String(v ?? "");
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    function buildCsv(rows) {
      const header = CSV_COLUMNS.map(([, label]) => csvCell(label)).join(",");
      const lines = rows.map((r) =>
        CSV_COLUMNS.map(([key]) => csvCell(DATE_COLS.has(key) ? csvDate(r[key]) : r[key])).join(",")
      );
      return "﻿" + [header, ...lines].join("\r\n"); // BOM so Excel reads UTF-8
    }

    csvBtn.addEventListener("click", async () => {
      csvBtn.disabled = true;
      const label = csvBtn.textContent;
      csvBtn.textContent = "Preparing…";
      statusP.textContent = "";
      try {
        const data = await invoke({ export: true });
        const rows = data.profiles || [];
        if (!rows.length) {
          statusP.textContent = "No registered profiles to export.";
          return;
        }
        const blob = new Blob([buildCsv(rows)], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `safe-creatives-registrations-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        statusP.textContent = `Downloaded ${rows.length} profile(s) as CSV.`;
      } catch (e) {
        statusP.textContent = `Export failed: ${e.message}`;
      } finally {
        csvBtn.disabled = false;
        csvBtn.textContent = label;
      }
    });

    applyDefaults();
    refreshCount();
    return frag;
  }

  // ------------------------------------------------------------------
  // Reports — charts over the order / payment / registration history
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

    // One fetch; the period selector filters these in memory (no refetch).
    const [pay, ord, prof, ref] = await Promise.all([
      sb.from("payments").select("amount_paise, status, method, created_at"),
      sb.from("orders").select("id, status, subtotal_paise, placed_at, order_items ( package_name, line_total_paise )"),
      sb.from("profiles").select("id, state_name, is_admin, created_at"),
      sb.from("refunds").select("amount_paise, status, created_at"),
    ]);
    const firstErr = pay.error || ord.error || prof.error || ref.error;
    if (firstErr) throw firstErr;

    const payments = pay.data || [];
    const orders = ord.data || [];
    const profiles = (prof.data || []).filter((p) => !p.is_admin);
    const refunds = ref.data || [];

    // Chart values are passed in rupees; this formats ticks and tooltips.
    const rupees = (v) => "₹" + Math.round(Number(v) || 0).toLocaleString("en-IN");

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

    // One card = a titled box with a subtitle, a fixed-height chart area, and
    // (optionally) an HTML legend slot beneath it.
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

    const cRevenue = card("Revenue over time", { wide: true });
    const cMethod = card("Payment method", { legend: true });
    const cPackage = card("Orders by package");
    const cStatus = card("Order status", { legend: true });
    const cRegs = card("New registrations", { wide: true });
    const cState = card("Customers by state");

    function setKpis(cards) {
      kpis.textContent = "";
      cards.forEach(([label, value, tone]) => {
        const c = el("div", `stat-card stat-${tone}`);
        c.appendChild(el("span", "stat-value" + (String(value).length > 8 ? " is-text" : ""), value));
        c.appendChild(el("span", "stat-label", label));
        kpis.appendChild(c);
      });
    }

    // Draw into a card, or show an empty note when the period has no rows.
    // Chart.js needs a live canvas, so restore one when leaving the empty state.
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

    const PM_DOMAIN = ["upi", "card", "netbanking", "wallet", "emi"];
    const PM_LABEL = { upi: "UPI", card: "Card", netbanking: "Netbanking", wallet: "Wallet", emi: "EMI" };
    const STATUS_DOMAIN = Object.values(ORDER_STATUS);

    function render(rangeKey) {
      const now = new Date();
      const start = R.rangeStart(rangeKey, now);
      const grain = R.grainFor(start, now);
      const inRange = (d) => !start || new Date(d) >= start;
      R.reset();

      const captured = payments.filter((p) => p.status === "captured" && inRange(p.created_at));
      const ordR = orders.filter((o) => inRange(o.placed_at));
      const profR = profiles.filter((p) => inRange(p.created_at));
      const refR = refunds.filter((r) => inRange(r.created_at) && ["pending", "processed"].includes(r.status));

      const revenue = captured.reduce((s, p) => s + Number(p.amount_paise || 0), 0);
      const aov = ordR.length ? Math.round(ordR.reduce((s, o) => s + Number(o.subtotal_paise || 0), 0) / ordR.length) : 0;
      const refTot = refR.reduce((s, r) => s + Number(r.amount_paise || 0), 0);
      setKpis([
        ["Revenue (captured)", SC.money(revenue), "ok"],
        ["Orders placed", String(ordR.length), "muted"],
        ["Avg order value", ordR.length ? SC.money(aov) : "—", "muted"],
        ["New registrations", String(profR.length), "muted"],
        ["Refunds", refTot ? SC.money(refTot) : "₹0", refTot ? "warn" : "muted"],
      ]);

      const rev = R.series(captured, (p) => p.created_at, (p) => Number(p.amount_paise || 0) / 100, start, now, grain);
      cRevenue.sub.textContent = `Captured payments · by ${R.grainWord(grain)}`;
      drawOrEmpty(cRevenue, revenue > 0, (cv) => R.line(cv, rev.labels, rev.values, { valueFmt: rupees }));

      const pm = R.group(captured, (p) => PM_LABEL[p.method] || p.method || "—",
        (p) => Number(p.amount_paise || 0) / 100, { domain: PM_DOMAIN.map((k) => PM_LABEL[k]) });
      cMethod.sub.textContent = "Captured, by amount";
      drawOrEmpty(cMethod, captured.length > 0, (cv) => {
        R.pie(cv, pm.labels, pm.values, { valueFmt: rupees });
        cMethod.legendBox.appendChild(R.legend(pm.labels, pm.values, rupees));
      });

      const items = [];
      ordR.forEach((o) => (o.order_items || []).forEach((it) => items.push(it)));
      const pkg = R.group(items, (it) => it.package_name || "—", null, {});
      cPackage.sub.textContent = "Units ordered in period";
      drawOrEmpty(cPackage, items.length > 0, (cv) => R.bar(cv, pkg.labels, pkg.values));

      const st = R.group(ordR, (o) => ORDER_STATUS[o.status] || o.status, null, { domain: STATUS_DOMAIN });
      cStatus.sub.textContent = "Orders placed in period";
      drawOrEmpty(cStatus, ordR.length > 0, (cv) => {
        R.pie(cv, st.labels, st.values, { doughnut: true });
        cStatus.legendBox.appendChild(R.legend(st.labels, st.values));
      });

      const regS = R.series(profR, (p) => p.created_at, null, start, now, grain);
      cRegs.sub.textContent = `New accounts · by ${R.grainWord(grain)}`;
      drawOrEmpty(cRegs, profR.length > 0, (cv) => R.line(cv, regS.labels, regS.values));

      const stateG = R.group(profR, (p) => p.state_name || "Unknown", null, { top: 8 });
      cState.sub.textContent = "Registered accounts";
      drawOrEmpty(cState, profR.length > 0, (cv) => R.bar(cv, stateG.labels, stateG.values, { horizontal: true }));
    }

    rangeSel.addEventListener("change", () => render(rangeSel.value));
    // Draw after the fragment is in the document, so Chart.js measures real sizes.
    requestAnimationFrame(() => render(rangeSel.value));
    return frag;
  }

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
    marketing: marketingPanel,
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
