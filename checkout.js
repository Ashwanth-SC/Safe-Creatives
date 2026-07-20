// ============================================================================
// Safe Creatives — order review
// ============================================================================
//
// Reads the cart from Supabase and reserves the order through the
// create-order Edge Function.
//
// Every rupee shown here comes from the database. The line totals are read
// from the cart_item_totals view, which recomputes from current catalog
// prices, and the amount actually charged is recalculated again inside the
// Edge Function. This page cannot influence either.
// ============================================================================

(async function () {
  await SC.ready;

  const profileDetails = document.querySelector("#profile-details");
  const cartPackages = document.querySelector("#cart-packages");
  const cartEmpty = document.querySelector("#cart-empty");
  const cartTotal = document.querySelector("#cart-total");
  const cartAdvance = document.querySelector("#cart-advance");
  const advanceAmount = document.querySelector("#advance-amount");
  const advancePercent = document.querySelector("#advance-percent");
  const cartReserve = document.querySelector("#cart-reserve");
  const reserveButton = document.querySelector("#reserve-order");
  const checkoutMessage = document.querySelector("#checkout-message");
  const addressField = document.querySelector("#delivery-address");
  const addressButton = document.querySelector("#save-address");
  const addressMessage = document.querySelector("#address-message");

  // Kept in sync with the ADVANCE_PERCENT constant in the create-order
  // Edge Function. Displayed here, enforced there.
  const ADVANCE_PERCENT = 20;

  function message(text, isError) {
    checkoutMessage.textContent = text;
    checkoutMessage.style.color = isError ? "#6f222a" : "#0c4444";
  }

  // ------------------------------------------------------------------
  // Profile
  // ------------------------------------------------------------------

  function addDetail(label, value) {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = label;
    description.textContent = value || "Not provided";
    row.append(term, description);
    profileDetails.appendChild(row);
  }

  const profile = SC.profile;
  addDetail("Full name", profile?.full_name);
  addDetail("Email", profile?.email);
  addDetail("Phone number", profile?.phone);

  // ------------------------------------------------------------------
  // Delivery address
  // ------------------------------------------------------------------
  // create-order refuses to reserve without one, and until now there was no
  // way for a customer to provide it.

  let savedAddress = profile?.address || "";
  addressField.value = savedAddress;

  async function saveAddress() {
    const value = addressField.value.trim();
    if (!value) {
      addressMessage.textContent = "Please enter a delivery address.";
      addressMessage.style.color = "#6f222a";
      return false;
    }

    addressButton.disabled = true;
    const { error } = await sb
      .from("profiles")
      .update({ address: value })
      .eq("id", SC.userId);
    addressButton.disabled = false;

    if (error) {
      addressMessage.textContent = `Could not save address: ${error.message}`;
      addressMessage.style.color = "#6f222a";
      return false;
    }

    savedAddress = value;
    addressMessage.textContent = "Address saved.";
    addressMessage.style.color = "#0c4444";
    updateReserveState();
    return true;
  }

  function updateReserveState() {
    // Unsaved edits count as no address: the Edge Function reads the profile
    // row, not this textarea.
    const ready = Boolean(savedAddress) && addressField.value.trim() === savedAddress;
    reserveButton.disabled = !ready;
    reserveButton.title = ready
      ? ""
      : "Save your delivery address before reserving.";
  }

  addressButton.addEventListener("click", saveAddress);
  addressField.addEventListener("input", updateReserveState);

  // ------------------------------------------------------------------
  // Cart
  // ------------------------------------------------------------------

  async function loadCart() {
    const { data: cart } = await sb
      .from("carts")
      .select("id")
      .eq("user_id", SC.userId)
      .eq("status", "active")
      .maybeSingle();

    if (!cart) return { cart: null, items: [] };

    // Line totals come from the view; names and selections come from the
    // catalog through the cart's foreign keys.
    const [{ data: totals }, { data: items }] = await Promise.all([
      sb.from("cart_item_totals").select("*").eq("cart_id", cart.id),
      sb
        .from("cart_items")
        .select(
          `id, created_at,
           packages ( key, name ),
           cart_item_options (
             product_option_groups ( name, package_products ( name ) ),
             product_options ( name, price_delta_paise )
           ),
           cart_item_addons ( package_addons ( name, price_paise ) )`
        )
        .eq("cart_id", cart.id)
        .order("created_at"),
    ]);

    const totalById = new Map(
      (totals || []).map((t) => [t.cart_item_id, t.line_total_paise])
    );

    return {
      cart,
      items: (items || []).map((item) => ({
        ...item,
        line_total_paise: totalById.get(item.id) ?? 0,
      })),
    };
  }

  function renderItem(item) {
    const card = document.createElement("article");
    card.className = "review-package";

    const title = document.createElement("h3");
    title.textContent = item.packages?.name || "Package";

    const selections = document.createElement("div");
    selections.className = "review-selections";

    const optionTitle = document.createElement("p");
    optionTitle.textContent = "Your selections";
    selections.appendChild(optionTitle);

    const optionList = document.createElement("ul");
    if (item.cart_item_options?.length) {
      // "Restful Bed Frame — Size: King (+₹18,000)"
      item.cart_item_options.forEach((choice) => {
        const group = choice.product_option_groups;
        const option = choice.product_options;
        const delta = Number(option?.price_delta_paise || 0);
        const row = document.createElement("li");
        row.textContent =
          `${group?.package_products?.name} — ${group?.name}: ${option?.name}` +
          (delta ? ` (+${SC.money(delta)})` : "");
        optionList.appendChild(row);
      });
    } else {
      const row = document.createElement("li");
      row.textContent = "No options selected";
      optionList.appendChild(row);
    }
    selections.appendChild(optionList);

    const addonTitle = document.createElement("p");
    addonTitle.textContent = "Add-ons";
    selections.appendChild(addonTitle);

    const addonList = document.createElement("ul");
    if (item.cart_item_addons?.length) {
      item.cart_item_addons.forEach((choice) => {
        const row = document.createElement("li");
        row.textContent = `${choice.package_addons?.name} — ${SC.money(
          choice.package_addons?.price_paise
        )}`;
        addonList.appendChild(row);
      });
    } else {
      const row = document.createElement("li");
      row.textContent = "No add-ons selected";
      addonList.appendChild(row);
    }
    selections.appendChild(addonList);

    const footer = document.createElement("div");
    footer.className = "review-package-footer";

    const edit = document.createElement("a");
    // Carrying the cart item id makes "Edit package" update this exact line
    // rather than adding a duplicate to the cart.
    edit.href = `${item.packages?.key}-package.html?item=${item.id}`;
    edit.textContent = "Edit package";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-package";
    remove.textContent = "Remove package";
    remove.addEventListener("click", () => confirmRemove(item));

    const total = document.createElement("strong");
    total.textContent = SC.money(item.line_total_paise);

    const footerActions = document.createElement("div");
    footerActions.className = "review-package-actions";
    footerActions.append(edit, remove);
    footer.append(footerActions, total);

    card.append(title, selections, footer);
    return card;
  }

  function confirmRemove(item) {
    const overlay = document.createElement("div");
    overlay.className = "cart-confirm-overlay";
    overlay.innerHTML =
      '<div class="cart-confirm-card" role="dialog" aria-modal="true" aria-labelledby="remove-confirm-title"><p class="eyebrow">REMOVE PACKAGE</p><h2 id="remove-confirm-title">Are you sure?</h2><p>This package will be removed from your cart. You can add it again later from the Sensory Rooms page.</p><div class="cart-confirm-actions"><button type="button" class="cart-confirm-cancel">Cancel</button><button type="button" class="cart-confirm-save">Remove package</button></div></div>';
    document.body.appendChild(overlay);

    const close = () => overlay.remove();
    overlay.querySelector(".cart-confirm-cancel").addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });

    overlay
      .querySelector(".cart-confirm-save")
      .addEventListener("click", async () => {
        // cart_item_options and cart_item_addons cascade on delete.
        const { error } = await sb
          .from("cart_items")
          .delete()
          .eq("id", item.id);
        close();
        if (error) message(`Could not remove package: ${error.message}`, true);
        else await render();
      });

    overlay.querySelector(".cart-confirm-cancel").focus();
  }

  // ------------------------------------------------------------------
  // Reserve
  // ------------------------------------------------------------------

  function toConfirmation(orderNumber) {
    window.location.href = `order-confirmation.html?order=${encodeURIComponent(
      orderNumber
    )}`;
  }

  function openRazorpay(data) {
    // Nothing this callback receives is trusted. Razorpay's server-to-server
    // webhook is what marks the order paid; this handler only decides which
    // page the customer lands on. A tampered response changes the redirect
    // and nothing else.
    const options = {
      key: data.razorpay_key_id,
      order_id: data.razorpay_order_id,
      amount: data.advance_amount_paise,
      currency: data.currency || "INR",
      name: "Safe Creatives",
      description: `Refundable advance — ${data.order_number}`,
      prefill: {
        name: profile?.full_name || "",
        email: profile?.email || "",
        contact: profile?.phone || "",
      },
      notes: { order_number: data.order_number },
      theme: { color: "#6f222a" },
      handler: function () {
        message("Payment received. Confirming...");
        toConfirmation(data.order_number);
      },
      modal: {
        ondismiss: function () {
          // There is no self-service retry yet -- paying again would need a
          // fresh Razorpay session, which only create-order can mint, and it
          // works from the cart rather than an existing order. Don't promise
          // the customer a button that isn't there.
          message(
            `Payment cancelled. Order ${data.order_number} is reserved but unpaid — our team will follow up with payment details.`,
            true
          );
          reserveButton.disabled = false;
        },
      },
    };

    if (typeof window.Razorpay !== "function") {
      message(
        "The payment window could not load. Check your connection and try again.",
        true
      );
      reserveButton.disabled = false;
      return;
    }

    const checkout = new window.Razorpay(options);
    checkout.on("payment.failed", function (response) {
      message(
        `Payment failed: ${response?.error?.description || "unknown error"}. Your order is still reserved.`,
        true
      );
      reserveButton.disabled = false;
    });
    checkout.open();
  }

  // supabase-js collapses every non-2xx into "Edge Function returned a
  // non-2xx status code" and leaves the actual response on error.context.
  // create-order puts a human-readable reason in that body, so dig it out --
  // otherwise every server-side failure looks identical from the UI.
  async function describeFunctionError(error) {
    const response = error?.context;
    if (!response || typeof response.clone !== "function") return error;

    try {
      const body = await response.clone().json();
      if (body?.error) return new Error(body.error);
    } catch {
      // Not JSON; fall through to text.
    }

    try {
      const text = await response.clone().text();
      if (text) return new Error(`${response.status}: ${text}`);
    } catch {
      // Body already consumed or unreadable.
    }

    return error;
  }

  async function reserve() {
    reserveButton.disabled = true;
    message("Reserving your order...");

    try {
      const { data, error } = await sb.functions.invoke("create-order");
      if (error) throw await describeFunctionError(error);
      if (data?.error) throw new Error(data.error);

      // create-order recomputes the total from the catalog, so these amounts
      // are authoritative and may differ from what this page displayed.
      if (!data.razorpay_order_id) {
        // Order reserved, but no payment session — gateway keys are probably
        // not configured. Better to land the customer on a page that says so
        // than to leave them on a checkout that looks broken.
        toConfirmation(data.order_number);
        return;
      }

      message(
        `Reserved as ${data.order_number}. Opening payment for ${SC.money(
          data.advance_amount_paise
        )}...`
      );
      openRazorpay(data);
    } catch (reserveError) {
      message(
        `Could not reserve your order: ${reserveError.message}. Nothing has been charged.`,
        true
      );
      reserveButton.disabled = false;
    }
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  async function render() {
    cartPackages.textContent = "";
    const { items } = await loadCart();

    if (!items.length) {
      cartEmpty.hidden = false;
      cartReserve.hidden = true;
      cartAdvance.hidden = true;
      cartTotal.textContent = SC.money(0);
      return;
    }

    cartEmpty.hidden = true;
    items.forEach((item) => cartPackages.appendChild(renderItem(item)));

    const subtotal = items.reduce(
      (sum, item) => sum + Number(item.line_total_paise || 0),
      0
    );

    cartTotal.textContent = SC.money(subtotal);
    advancePercent.textContent = ADVANCE_PERCENT;
    advanceAmount.textContent = SC.money(
      Math.round((subtotal * ADVANCE_PERCENT) / 100)
    );
    cartAdvance.hidden = false;
    cartReserve.hidden = false;
    updateReserveState();
  }

  reserveButton.addEventListener("click", reserve);
  await render();
})();
