// ============================================================================
// Safe Creatives — order confirmation
// ============================================================================
//
// Reads a single order by its order_number. RLS restricts orders to their
// owner, so guessing another customer's reference in the URL returns nothing
// rather than their order.
// ============================================================================

(async function () {
  await SC.ready;

  const orderNumber = new URLSearchParams(window.location.search).get("order");
  const numberElement = document.querySelector("#order-number");
  const detailsElement = document.querySelector("#order-details");
  const packagesElement = document.querySelector("#order-packages");
  const nextSteps = document.querySelector("#next-steps");

  const STATUS_TEXT = {
    pending_advance: "Awaiting refundable advance",
    advance_paid: "Advance received",
    site_verification: "Site verification in progress",
    confirmed: "Confirmed",
    in_production: "In production",
    delivered: "Delivered",
    cancelled: "Cancelled",
    refunded: "Refunded",
  };

  function addDetail(label, value) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value;
    row.append(term, description);
    detailsElement.appendChild(row);
  }

  if (!orderNumber) {
    numberElement.textContent = "not found";
    nextSteps.textContent = "No order reference was provided.";
    return;
  }

  const { data: order, error } = await sb
    .from("orders")
    .select(
      `order_number, status, subtotal_paise, gst_percent, gst_paise, total_paise,
       advance_amount_paise, balance_paise,
       delivery_address_line, delivery_city, delivery_pin_code, placed_at,
       order_items ( package_name, line_total_paise,
                     order_item_options ( product_name, group_name, option_name, price_delta_paise ),
                     order_item_addons ( addon_name, price_paise ) )`
    )
    .eq("order_number", orderNumber)
    .maybeSingle();

  if (error || !order) {
    numberElement.textContent = orderNumber;
    nextSteps.textContent =
      "We could not find this order on your account. If you believe this is a mistake, please contact us.";
    return;
  }

  numberElement.textContent = order.order_number;

  addDetail("Status", STATUS_TEXT[order.status] || order.status);
  addDetail("Package total", SC.money(order.subtotal_paise));
  addDetail(`GST (${order.gst_percent}%)`, SC.money(order.gst_paise));
  addDetail("Total payable", SC.money(order.total_paise));
  addDetail("Refundable advance", `${SC.money(order.advance_amount_paise)} (incl. GST)`);
  addDetail("Balance after verification", SC.money(order.balance_paise));
  addDetail(
    "Delivery address",
    [order.delivery_address_line, order.delivery_city, order.delivery_pin_code]
      .filter(Boolean)
      .join(", ")
  );
  addDetail("Placed", new Date(order.placed_at).toLocaleDateString("en-IN"));

  order.order_items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "review-package";

    const title = document.createElement("h3");
    title.textContent = item.package_name;

    const list = document.createElement("ul");
    list.style.cssText =
      "margin:4px 0 0; padding:0; list-style:none; color:#59635d; font-size:12px; line-height:1.8;";

    item.order_item_options.forEach((option) => {
      const price = Number(option.price_delta_paise || 0);
      const row = document.createElement("li");
      row.textContent =
        `${option.product_name} — ${option.group_name}: ${option.option_name}` +
        (price ? ` — ${SC.money(price)}` : "");
      list.appendChild(row);
    });
    item.order_item_addons.forEach((addon) => {
      const row = document.createElement("li");
      row.textContent = `${addon.addon_name} — ${SC.money(addon.price_paise)}`;
      list.appendChild(row);
    });

    const footer = document.createElement("div");
    footer.className = "review-package-footer";
    const total = document.createElement("strong");
    total.textContent = SC.money(item.line_total_paise);
    footer.append(document.createElement("span"), total);

    card.append(title, list, footer);
    packagesElement.appendChild(card);
  });

  if (order.status === "pending_advance") {
    nextSteps.textContent =
      "Your order is reserved but the refundable advance has not been collected yet. Our team will contact you with payment details.";
  }
})();
