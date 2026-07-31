// ============================================================================
// Safe Creatives — customer order tracking
// ============================================================================
//
// A read-only view of the customer's own orders: a milestone progress bar and
// the state of the three payment installments. The one thing the customer can
// change here is their installation preference (have us install, or arrange
// their own carpenter if they are outside Chennai) — written through the
// set_installation_choice RPC, the only order write a customer is allowed.
//
// The admin advances the milestones and marks the later installments paid from
// the dashboard; those changes appear here on the customer's next load.
// ============================================================================

(async function () {
  const { session } = await SC.ready;
  const list = document.querySelector("#track-list");
  if (!session) return; // guarded page redirects; this is belt-and-braces

  const money = SC.money;

  // The customer-facing milestones, in order. "installed" only applies when the
  // customer has chosen in-house installation; "cancelled" is handled apart.
  const STAGES = [
    ["reserved", "Reserved"],
    ["confirmed", "Confirmed"],
    ["production", "Production"],
    ["dispatch", "Ready to dispatch"],
    ["delivered", "Delivered"],
    ["installed", "Installed"],
  ];

  // Which fulfillment stages unlock each installment for the customer. Mirrors
  // the gate in the create-installment-order Edge Function (the authoritative
  // check); this only decides what the page offers. The final installment
  // unlocks at "Ready to dispatch" (stage 'dispatch'), not earlier.
  const CONFIRMATION_STAGES = ["confirmed", "production", "dispatch", "delivered", "installed"];
  const DISPATCH_STAGES = ["dispatch", "delivered", "installed"];

  function dateOf(value) {
    return value
      ? new Date(value).toLocaleDateString("en-IN", {
          day: "2-digit",
          month: "short",
          year: "numeric",
        })
      : "";
  }

  const { data: orders, error } = await sb
    .from("orders")
    .select(
      `id, order_number, status, fulfillment_stage, installation_choice,
       confirmation_paid_at, dispatch_paid_at, placed_at,
       total_paise, advance_amount_paise, balance_paise, gst_percent,
       order_items ( package_name ),
       invoices ( invoice_number, phase_label, phase_number )`
    )
    .eq("user_id", SC.userId)
    .order("placed_at", { ascending: false });

  if (error) {
    list.innerHTML = `<p class="track-empty">Your orders could not be loaded: ${error.message}</p>`;
    return;
  }

  if (!orders.length) {
    list.innerHTML =
      '<p class="track-empty">You have no orders yet. <a href="sensory-rooms.html">Explore sensory rooms ↗︎</a></p>';
    return;
  }

  orders.forEach((order) => {
    const card = document.createElement("article");
    card.className = "track-card";
    build(card, order);
    list.appendChild(card);
  });

  // --------------------------------------------------------------------
  // Card
  // --------------------------------------------------------------------

  function build(card, order) {
    card.textContent = "";

    const cancelled = order.fulfillment_stage === "cancelled";
    const inHouse = order.installation_choice === "in_house";

    // Header ---------------------------------------------------------
    const head = document.createElement("div");
    head.className = "track-card-head";
    const packages =
      (order.order_items || []).map((i) => i.package_name).join(", ") || "Your order";
    head.innerHTML = `
      <div>
        <p class="track-eyebrow">${order.order_number} · placed ${dateOf(order.placed_at)}</p>
        <h2>${packages}</h2>
      </div>
      <span class="track-status ${cancelled ? "is-cancelled" : "is-live"}">${
      cancelled ? "Cancelled" : "In progress"
    }</span>`;
    card.appendChild(head);

    // Progress -------------------------------------------------------
    if (cancelled) {
      const note = document.createElement("p");
      note.className = "track-cancelled-note";
      note.textContent =
        "This order was cancelled. If you think this is a mistake, please get in touch and we'll help.";
      card.appendChild(note);
    } else {
      card.appendChild(renderProgress(order, inHouse));
    }

    // Payments -------------------------------------------------------
    card.appendChild(renderPayments(order));

    // Installation choice -------------------------------------------
    if (!cancelled) card.appendChild(renderInstallation(card, order));

    // Documents ------------------------------------------------------
    card.appendChild(renderDocs(order));
  }

  // --------------------------------------------------------------------
  // Progress bar
  // --------------------------------------------------------------------

  function renderProgress(order, inHouse) {
    // Drop the "installed" milestone unless the customer is installing with us.
    const steps = inHouse ? STAGES : STAGES.filter(([key]) => key !== "installed");
    const currentIndex = steps.findIndex(([key]) => key === order.fulfillment_stage);

    const wrap = document.createElement("ol");
    wrap.className = "track-steps";

    steps.forEach(([key, label], index) => {
      const done = currentIndex >= 0 && index <= currentIndex;
      const current = index === currentIndex;
      const li = document.createElement("li");
      li.className =
        "track-step" + (done ? " is-done" : "") + (current ? " is-current" : "");
      li.innerHTML = `<span class="track-dot"></span><span class="track-step-label">${label}</span>`;
      wrap.appendChild(li);
    });

    return wrap;
  }

  // --------------------------------------------------------------------
  // Payments — advance, then the balance split 80% / 20%
  // --------------------------------------------------------------------

  function renderPayments(order) {
    const advance = Number(order.advance_amount_paise || 0);
    const balance = Number(order.balance_paise || 0);
    const confirmation = SC.floorRupees(balance * 0.8);
    const dispatch = balance - confirmation;

    const advancePaid = order.status !== "pending_advance";
    const confirmationPaid = Boolean(order.confirmation_paid_at);
    const dispatchPaid = Boolean(order.dispatch_paid_at);
    const closed =
      order.status === "cancelled" ||
      order.status === "refunded" ||
      order.fulfillment_stage === "cancelled";

    // Each installment can be paid by the customer here once the admin advances
    // the milestone that unlocks it. The Edge Function re-checks this gate; the
    // page only decides whether to offer the button.
    const rows = [
      { label: "Advance", amount: advance, paid: advancePaid },
      {
        label: "Confirmation (80%)",
        amount: confirmation,
        paid: confirmationPaid,
        phase: "confirmation",
        unlocked: advancePaid && CONFIRMATION_STAGES.includes(order.fulfillment_stage),
        lockHint: "Unlocks once your order is confirmed",
      },
      {
        label: "Final balance (20%)",
        amount: dispatch,
        paid: dispatchPaid,
        phase: "dispatch",
        unlocked:
          advancePaid &&
          confirmationPaid &&
          DISPATCH_STAGES.includes(order.fulfillment_stage),
        lockHint: confirmationPaid
          ? "Unlocks once your order is ready to dispatch"
          : "Pay the confirmation installment first",
      },
    ];

    const wrap = document.createElement("div");
    wrap.className = "track-payments";
    wrap.innerHTML = '<p class="track-subhead">Payments</p>';

    rows.forEach((r) => {
      const row = document.createElement("div");
      row.className = "track-pay";

      const label = document.createElement("span");
      label.className = "track-pay-label";
      label.textContent = r.label;

      const amount = document.createElement("span");
      amount.className = "track-pay-amount";
      amount.textContent = money(r.amount);

      let right;
      if (r.paid) {
        right = badge("Paid", "is-paid");
      } else if (r.phase && !closed && r.unlocked) {
        right = document.createElement("button");
        right.type = "button";
        right.className = "track-pay-btn";
        right.textContent = "Pay now";
        right.addEventListener("click", () => payInstallment(order, r.phase, right));
      } else if (r.phase && !closed) {
        right = document.createElement("span");
        right.className = "track-pay-lock";
        right.textContent = r.lockHint;
      } else {
        right = badge("Pending", "is-pending");
      }

      row.append(label, amount, right);
      wrap.appendChild(row);
    });

    return wrap;
  }

  function badge(text, cls) {
    const el = document.createElement("span");
    el.className = `track-badge ${cls}`;
    el.textContent = text;
    return el;
  }

  // --------------------------------------------------------------------
  // Installment payment — inline Razorpay, mirroring the advance checkout
  // --------------------------------------------------------------------

  async function payInstallment(order, phase, button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Starting…";
    try {
      const { data, error } = await sb.functions.invoke("create-installment-order", {
        body: { order_id: order.id, phase },
      });
      if (error) throw await describeFunctionError(error);
      if (data?.error) throw new Error(data.error);
      openRazorpay(data);
    } catch (payError) {
      window.alert(`Could not start payment: ${payError.message}`);
      button.disabled = false;
      button.textContent = original;
    }
  }

  function openRazorpay(data) {
    if (typeof window.Razorpay !== "function") {
      window.alert(
        "The payment window could not load. Check your connection and try again."
      );
      return;
    }
    const label =
      data.phase === "confirmation" ? "Confirmation (80%)" : "Final balance (20%)";
    const checkout = new window.Razorpay({
      key: data.razorpay_key_id,
      order_id: data.razorpay_order_id,
      amount: data.amount_paise,
      currency: data.currency || "INR",
      name: "Safe Creatives",
      description: `${label} — ${data.order_number}`,
      prefill: {
        name: data.contact_name || "",
        email: data.contact_email || "",
        contact: data.contact_phone || "",
      },
      notes: { order_number: data.order_number, phase: data.phase },
      theme: { color: "#6f222a" },
      handler: function () {
        // The webhook is what actually marks it paid; give it a moment, then
        // reload so the row reflects the new state.
        list.insertAdjacentHTML(
          "afterbegin",
          '<p class="track-empty">Payment received — confirming your order…</p>'
        );
        window.setTimeout(() => window.location.reload(), 2500);
      },
    });
    checkout.on("payment.failed", function (response) {
      window.alert(
        `Payment failed: ${response?.error?.description || "unknown error"}. You can try again.`
      );
    });
    checkout.open();
  }

  // supabase-js collapses a non-2xx into a generic message and leaves the real
  // response on error.context; dig out the function's own error text.
  async function describeFunctionError(error) {
    const response = error?.context;
    if (!response || typeof response.clone !== "function") return error;
    try {
      const body = await response.clone().json();
      if (body?.error) return new Error(body.error);
    } catch {
      /* not JSON */
    }
    try {
      const text = await response.clone().text();
      if (text) return new Error(`${response.status}: ${text}`);
    } catch {
      /* already consumed */
    }
    return error;
  }

  // --------------------------------------------------------------------
  // Installation choice (the one customer-editable field)
  // --------------------------------------------------------------------

  function renderInstallation(card, order) {
    const wrap = document.createElement("div");
    wrap.className = "track-install";
    wrap.innerHTML = '<p class="track-subhead">Installation</p>';

    const choice = order.installation_choice;
    const options = [
      ["in_house", "Install with Safe Creatives"],
      ["self", "I'll arrange my own"],
    ];

    const group = document.createElement("div");
    group.className = "install-options";
    options.forEach(([value, label]) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "install-option" + (choice === value ? " is-selected" : "");
      btn.textContent = label;
      btn.addEventListener("click", () => setChoice(card, order, value));
      group.appendChild(btn);
    });
    wrap.appendChild(group);

    const note = document.createElement("p");
    note.className = "install-note";
    note.textContent =
      choice === "in_house"
        ? "Our team will handle installation as the final step."
        : choice === "self"
        ? "You've chosen to arrange your own installation — we'll complete your order at delivery."
        : "Within Chennai we install for you. Outside Chennai you may prefer your own carpenter — let us know.";
    wrap.appendChild(note);

    return wrap;
  }

  async function setChoice(card, order, choice) {
    const { error: rpcError } = await sb.rpc("set_installation_choice", {
      p_order: order.id,
      p_choice: choice,
    });
    if (rpcError) {
      window.alert(`Could not save your choice: ${rpcError.message}`);
      return;
    }
    order.installation_choice = choice;
    build(card, order); // re-render so the bar reflects whether installation applies
  }

  // --------------------------------------------------------------------
  // Documents
  // --------------------------------------------------------------------

  function renderDocs(order) {
    const wrap = document.createElement("div");
    wrap.className = "track-docs";
    wrap.innerHTML = '<span class="track-docs-label">Documents</span>';

    const summary = document.createElement("a");
    summary.className = "track-doc";
    summary.href = `invoice.html?order=${encodeURIComponent(order.order_number)}`;
    summary.target = "_blank";
    summary.rel = "noopener";
    summary.textContent = "Order summary ↗︎";
    wrap.appendChild(summary);

    (order.invoices || [])
      .sort((a, b) => a.phase_number - b.phase_number)
      .forEach((inv) => {
        const link = document.createElement("a");
        link.className = "track-doc";
        link.href = `invoice.html?number=${encodeURIComponent(inv.invoice_number)}`;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = `${inv.phase_label || "Invoice"} ${inv.invoice_number} ↗︎`;
        wrap.appendChild(link);
      });

    return wrap;
  }
})();
