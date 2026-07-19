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
  addDetail("Address", profile?.address);

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
           cart_item_colours ( package_products ( name ), product_colours ( name ) ),
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

    const colourTitle = document.createElement("p");
    colourTitle.textContent = "Main product colours";
    selections.appendChild(colourTitle);

    const colourList = document.createElement("ul");
    if (item.cart_item_colours?.length) {
      item.cart_item_colours.forEach((choice) => {
        const row = document.createElement("li");
        row.textContent = `${choice.package_products?.name}: ${choice.product_colours?.name}`;
        colourList.appendChild(row);
      });
    } else {
      const row = document.createElement("li");
      row.textContent = "No colours selected";
      colourList.appendChild(row);
    }
    selections.appendChild(colourList);

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
        // cart_item_colours and cart_item_addons cascade on delete.
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

  async function reserve() {
    reserveButton.disabled = true;
    message("Reserving your order...");

    try {
      const { data, error } = await sb.functions.invoke("create-order");
      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      // The function returns the authoritative amounts. If they differ from
      // what this page displayed, the customer sees the real figure before
      // being sent to pay.
      window.location.href = `order-confirmation.html?order=${encodeURIComponent(
        data.order_number
      )}`;
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
  }

  reserveButton.addEventListener("click", reserve);
  await render();
})();
