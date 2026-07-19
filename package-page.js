// ============================================================================
// Safe Creatives — package configurator
// ============================================================================
//
// Renders products, colours, and add-ons from the catalog tables and writes
// the customer's selection to their Supabase cart.
//
// The cart stores IDs only — never prices. The total shown here is a
// convenience for the customer; the authoritative figure is recomputed
// server-side at checkout. Tampering with this page changes what you see,
// not what you are charged.
// ============================================================================

(async function () {
  await SC.ready;

  const packageKey = document.body.dataset.packageKey;
  const editItemId = new URLSearchParams(window.location.search).get("item");

  const productsWrap = document.querySelector(".products-wrap");
  const addonGrid = document.querySelector(".addon-grid");
  const totalElement = document.querySelector("#package-total");
  const saveMessage = document.querySelector("#save-message");

  // Current selection: productId -> colourId, and a Set of addon IDs.
  const chosenColour = new Map();
  const chosenAddons = new Set();

  let pkg = null;

  // ------------------------------------------------------------------
  // Load catalog
  // ------------------------------------------------------------------

  const { data, error } = await sb
    .from("packages")
    .select(
      `id, key, name, base_price_paise,
       package_products (
         id, key, name, description, specs, sort_order,
         product_colours ( id, key, name, image_path, finish, material,
                           swatch_hex, price_delta_paise, sort_order )
       ),
       package_addons ( id, key, name, description, image_path, price_paise, sort_order )`
    )
    .eq("key", packageKey)
    .maybeSingle();

  if (error || !data) {
    productsWrap.insertAdjacentHTML(
      "beforeend",
      `<p class="cart-empty">This package could not be loaded${
        error ? `: ${error.message}` : ""
      }. Please refresh, or head back to <a href="sensory-rooms.html">Sensory rooms</a>.</p>`
    );
    return;
  }

  pkg = data;

  // PostgREST does not order embedded rows for us, so sort here.
  const bySort = (a, b) => a.sort_order - b.sort_order;
  pkg.package_products.sort(bySort);
  pkg.package_products.forEach((p) => p.product_colours.sort(bySort));
  pkg.package_addons.sort(bySort);

  // ------------------------------------------------------------------
  // Restore a previous configuration
  // ------------------------------------------------------------------
  // Arriving from "Edit package" carries ?item=<cart_item_id>, which loads
  // that exact line item so editing updates it in place rather than
  // silently adding a second copy to the cart.

  async function loadExistingSelection() {
    if (!editItemId) return false;

    const { data: item } = await sb
      .from("cart_items")
      .select(
        `id, package_id,
         cart_item_colours ( product_id, colour_id ),
         cart_item_addons ( addon_id )`
      )
      .eq("id", editItemId)
      .maybeSingle();

    if (!item || item.package_id !== pkg.id) return false;

    item.cart_item_colours.forEach((c) =>
      chosenColour.set(c.product_id, c.colour_id)
    );
    item.cart_item_addons.forEach((a) => chosenAddons.add(a.addon_id));
    return true;
  }

  const isEditing = await loadExistingSelection();

  // Anything not restored falls back to the first colour.
  pkg.package_products.forEach((product) => {
    if (!chosenColour.has(product.id) && product.product_colours.length) {
      chosenColour.set(product.id, product.product_colours[0].id);
    }
  });

  // ------------------------------------------------------------------
  // Totals (display only)
  // ------------------------------------------------------------------

  function colourById(productId, colourId) {
    return pkg.package_products
      .find((p) => p.id === productId)
      ?.product_colours.find((c) => c.id === colourId);
  }

  function totalPaise() {
    let total = pkg.base_price_paise;
    chosenColour.forEach((colourId, productId) => {
      total += colourById(productId, colourId)?.price_delta_paise || 0;
    });
    pkg.package_addons.forEach((addon) => {
      if (chosenAddons.has(addon.id)) total += addon.price_paise;
    });
    return total;
  }

  function updateTotal() {
    totalElement.textContent = SC.money(totalPaise());
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  function renderProducts() {
    pkg.package_products.forEach((product, index) => {
      const activeColour = colourById(product.id, chosenColour.get(product.id));

      const article = document.createElement("article");
      article.className = "product-block";
      article.dataset.product = product.name;
      article.dataset.productId = product.id;

      const specRows = (product.specs || [])
        .map(
          (spec) =>
            `<div><span>${spec.label}</span><strong>${spec.value}</strong></div>`
        )
        .join("");

      article.innerHTML = `
        <div class="product-gallery">
          <span class="product-number">${String(index + 1).padStart(2, "0")}</span>
          <img src="${activeColour?.image_path || ""}" alt="${product.name}" />
        </div>
        <div class="product-info">
          <p class="product-type">MAIN PRODUCT</p>
          <h2>${product.name}</h2>
          <p class="product-description">${product.description || ""}</p>
          <div class="color-options"></div>
          <div class="specs">
            <div><span>FINISH</span><strong data-spec="finish"></strong></div>
            <div><span>MATERIAL</span><strong data-spec="material"></strong></div>
            ${specRows}
          </div>
        </div>`;

      const options = article.querySelector(".color-options");

      product.product_colours.forEach((colour) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "color-option";
        // data-color keeps the existing packages.css rules working; the
        // inline background is what actually guarantees a swatch renders,
        // including for colours the stylesheet has never heard of.
        button.dataset.color = colour.name;
        button.style.background = colour.swatch_hex;
        button.setAttribute("aria-label", `${product.name} in ${colour.name}`);
        if (colour.id === chosenColour.get(product.id)) {
          button.classList.add("active");
        }
        button.addEventListener("click", () => {
          chosenColour.set(product.id, colour.id);
          applyColour(article, product, colour);
          updateTotal();
        });
        options.appendChild(button);
      });

      productsWrap.appendChild(article);
      if (activeColour) applyColour(article, product, activeColour);
    });
  }

  function applyColour(article, product, colour) {
    const image = article.querySelector("img");
    image.src = colour.image_path;
    image.alt = `${product.name} in ${colour.name}`;
    article.querySelector('[data-spec="finish"]').textContent =
      colour.finish || "—";
    article.querySelector('[data-spec="material"]').textContent =
      colour.material || "—";
    article
      .querySelectorAll(".color-option")
      .forEach((b) => b.classList.remove("active"));
    article
      .querySelector(`.color-option[aria-label="${product.name} in ${colour.name}"]`)
      ?.classList.add("active");
  }

  function renderAddons() {
    pkg.package_addons.forEach((addon) => {
      const selected = chosenAddons.has(addon.id);

      const card = document.createElement("article");
      card.className = `addon-card${selected ? " selected" : ""}`;
      card.dataset.id = addon.key;
      card.innerHTML = `
        <img src="${addon.image_path || ""}" alt="${addon.name}" />
        <div class="addon-copy">
          <h3>${addon.name}</h3>
          <p>${addon.description || ""}</p>
          <div class="addon-bottom">
            <span class="addon-price">${SC.money(addon.price_paise)}</span>
            <button class="addon-toggle${selected ? " selected" : ""}" type="button">${
        selected ? "Remove" : "Add"
      }</button>
          </div>
        </div>`;

      const toggle = card.querySelector(".addon-toggle");
      toggle.addEventListener("click", () => {
        const active = card.classList.toggle("selected");
        toggle.classList.toggle("selected", active);
        toggle.textContent = active ? "Remove" : "Add";
        if (active) chosenAddons.add(addon.id);
        else chosenAddons.delete(addon.id);
        updateTotal();
      });

      addonGrid.appendChild(card);
    });
  }

  // ------------------------------------------------------------------
  // Cart writes
  // ------------------------------------------------------------------

  async function getOrCreateActiveCart() {
    const { data: existing } = await sb
      .from("carts")
      .select("id")
      .eq("user_id", SC.userId)
      .eq("status", "active")
      .maybeSingle();

    if (existing) return existing.id;

    const { data: created, error: createError } = await sb
      .from("carts")
      .insert({ user_id: SC.userId })
      .select("id")
      .single();

    if (createError) throw createError;
    return created.id;
  }

  async function writeSelection(cartItemId) {
    // Replace rather than diff: the selection is small and this keeps the
    // stored rows exactly matching what is on screen.
    await sb.from("cart_item_colours").delete().eq("cart_item_id", cartItemId);
    await sb.from("cart_item_addons").delete().eq("cart_item_id", cartItemId);

    const colourRows = [...chosenColour.entries()].map(
      ([product_id, colour_id]) => ({ cart_item_id: cartItemId, product_id, colour_id })
    );
    if (colourRows.length) {
      const { error } = await sb.from("cart_item_colours").insert(colourRows);
      if (error) throw error;
    }

    const addonRows = [...chosenAddons].map((addon_id) => ({
      cart_item_id: cartItemId,
      addon_id,
    }));
    if (addonRows.length) {
      const { error } = await sb.from("cart_item_addons").insert(addonRows);
      if (error) throw error;
    }
  }

  async function saveAsNewItem() {
    const cartId = await getOrCreateActiveCart();
    const { data: item, error } = await sb
      .from("cart_items")
      .insert({ cart_id: cartId, package_id: pkg.id })
      .select("id")
      .single();
    if (error) throw error;
    await writeSelection(item.id);
    return "added";
  }

  async function saveOverExistingItem() {
    await sb
      .from("cart_items")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", editItemId);
    await writeSelection(editItemId);
    return "updated";
  }

  async function countExistingCopies() {
    const cartId = await getOrCreateActiveCart();
    const { count } = await sb
      .from("cart_items")
      .select("id", { count: "exact", head: true })
      .eq("cart_id", cartId)
      .eq("package_id", pkg.id);
    return count || 0;
  }

  // ------------------------------------------------------------------
  // UI feedback
  // ------------------------------------------------------------------

  function showSaveToast(message) {
    saveMessage.textContent = message;
    saveMessage.classList.add("is-visible");
    window.clearTimeout(showSaveToast.timer);
    showSaveToast.timer = window.setTimeout(
      () => saveMessage.classList.remove("is-visible"),
      2800
    );
  }

  function confirmDialog({ eyebrow, title, body, cancelText, confirmText }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "cart-confirm-overlay";
      overlay.innerHTML = `<div class="cart-confirm-card" role="dialog" aria-modal="true" aria-labelledby="confirm-title"><p class="eyebrow">${eyebrow}</p><h2 id="confirm-title">${title}</h2><p>${body}</p><div class="cart-confirm-actions"><button type="button" class="cart-confirm-cancel">${cancelText}</button><button type="button" class="cart-confirm-save">${confirmText}</button></div></div>`;
      document.body.appendChild(overlay);

      const close = (result) => {
        overlay.remove();
        resolve(result);
      };
      overlay
        .querySelector(".cart-confirm-cancel")
        .addEventListener("click", () => close(false));
      overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close(false);
      });
      overlay
        .querySelector(".cart-confirm-save")
        .addEventListener("click", () => close(true));
      overlay.querySelector(".cart-confirm-save").focus();
    });
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------

  async function savePackage() {
    const button = document.querySelector("#save-package");
    button.disabled = true;

    try {
      if (isEditing) {
        await saveOverExistingItem();
        showSaveToast("Saved — package updated");
        return true;
      }

      if (await countExistingCopies()) {
        const addAnother = await confirmDialog({
          eyebrow: "PACKAGE ALREADY SAVED",
          title: "Add another one?",
          body: "This package is already in your cart. Would you like to add a second one with the add-ons currently selected?",
          cancelText: "Cancel",
          confirmText: "Add another",
        });
        if (!addAnother) return false;
      }

      await saveAsNewItem();
      showSaveToast("Saved — package added to your cart");
      return true;
    } catch (saveError) {
      showSaveToast(`Could not save: ${saveError.message}`);
      return false;
    } finally {
      button.disabled = false;
    }
  }

  async function reviewOrder() {
    const save = await confirmDialog({
      eyebrow: "REVIEW YOUR PACKAGE",
      title: "Save your changes?",
      body: "Would you like to save this package to your cart before continuing to the review page?",
      cancelText: "Continue without saving",
      confirmText: "Save to cart",
    });

    if (save) {
      const saved = await savePackage();
      if (!saved) return;
    }
    window.location.href = "checkout.html";
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  renderProducts();
  renderAddons();
  updateTotal();

  document.querySelector("#save-package").addEventListener("click", savePackage);
  document.querySelector("#review-order").addEventListener("click", reviewOrder);

  if (isEditing) {
    document.querySelector("#save-package").textContent = "Update package";
  }
})();
