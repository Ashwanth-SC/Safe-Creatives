// ============================================================================
// Safe Creatives — package configurator
// ============================================================================
//
// Renders products, their option groups (Size, Colour, anything added later),
// and add-ons from the catalog tables, then writes the selection to the
// customer's Supabase cart.
//
// Nothing here is aware of what a group MEANS. A group renders from its
// display_as hint, so adding "Fabric" or "Wood finish" in the admin page needs
// no change to this file.
//
// The cart stores IDs only -- never prices. The total shown is a convenience;
// the authoritative figure is recomputed server-side at checkout. Tampering
// with this page changes what you see, not what you are charged.
// ============================================================================

(async function () {
  await SC.ready;

  const packageKey = document.body.dataset.packageKey;
  const editItemId = new URLSearchParams(window.location.search).get("item");

  const productsWrap = document.querySelector(".products-wrap");
  const addonGrid = document.querySelector(".addon-grid");
  const totalElement = document.querySelector("#package-total");
  const saveMessage = document.querySelector("#save-message");

  // groupId -> optionId, and a Set of addon IDs.
  const chosenOption = new Map();
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
         product_option_groups (
           id, key, name, display_as, sort_order,
           product_options ( id, key, name, description, price_delta_paise,
                             image_paths, swatch_hex, finish, material, sort_order )
         )
       ),
       package_addons ( id, key, name, description, image_path, price_paise,
                        is_default_selected, sort_order )`
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

  // PostgREST does not order embedded rows, so sort every level here.
  const bySort = (a, b) => a.sort_order - b.sort_order;
  pkg.package_products.sort(bySort);
  pkg.package_products.forEach((product) => {
    product.product_option_groups.sort(bySort);
    product.product_option_groups.forEach((group) =>
      group.product_options.sort(bySort)
    );
  });
  pkg.package_addons.sort(bySort);

  const allGroups = pkg.package_products.flatMap((p) => p.product_option_groups);
  const groupById = new Map(allGroups.map((g) => [g.id, g]));

  function optionById(groupId, optionId) {
    return groupById.get(groupId)?.product_options.find((o) => o.id === optionId);
  }

  // ------------------------------------------------------------------
  // Restore a previous configuration
  // ------------------------------------------------------------------

  async function loadExistingSelection() {
    if (!editItemId) return false;

    const { data: item } = await sb
      .from("cart_items")
      .select(
        `id, package_id,
         cart_item_options ( group_id, option_id ),
         cart_item_addons ( addon_id )`
      )
      .eq("id", editItemId)
      .maybeSingle();

    if (!item || item.package_id !== pkg.id) return false;

    item.cart_item_options.forEach((choice) => {
      // Ignore selections whose option has since been removed from the
      // catalog; the default below fills the gap.
      if (optionById(choice.group_id, choice.option_id)) {
        chosenOption.set(choice.group_id, choice.option_id);
      }
    });
    item.cart_item_addons.forEach((a) => chosenAddons.add(a.addon_id));
    return true;
  }

  const isEditing = await loadExistingSelection();

  // Anything not restored falls back to the first option in its group.
  allGroups.forEach((group) => {
    if (!chosenOption.has(group.id) && group.product_options.length) {
      chosenOption.set(group.id, group.product_options[0].id);
    }
  });

  // A NEW configuration starts with the default add-ons already selected --
  // the customer removes what they do not want rather than hunting for what
  // they do. Editing an existing cart item does NOT do this: their saved
  // choices are the truth, and re-ticking a removed add-on would silently
  // put back something they had deliberately taken out.
  if (!isEditing) {
    pkg.package_addons.forEach((addon) => {
      if (addon.is_default_selected) chosenAddons.add(addon.id);
    });
  }

  // ------------------------------------------------------------------
  // Totals (display only)
  // ------------------------------------------------------------------

  function totalPaise() {
    let total = pkg.base_price_paise;
    chosenOption.forEach((optionId, groupId) => {
      total += optionById(groupId, optionId)?.price_delta_paise || 0;
    });
    pkg.package_addons.forEach((addon) => {
      if (chosenAddons.has(addon.id)) total += addon.price_paise;
    });
    return total;
  }

  function updateTotal() {
    totalElement.textContent = SC.money(totalPaise());
  }

  // Images belong to whichever selected option carries them -- normally the
  // colour. Size deliberately has none: a King bed in Sand looks like the Sand
  // photos, so size changes price and nothing else.
  function imageOptionFor(product) {
    for (const group of product.product_option_groups) {
      const selected = optionById(group.id, chosenOption.get(group.id));
      if (selected?.image_paths?.length) return selected;
    }
    return null;
  }

  // Which photo in the current option's gallery is showing, per product.
  // Resets to the first whenever the option changes.
  const galleryIndex = new Map();

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  function renderProducts() {
    pkg.package_products.forEach((product, index) => {
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
        <div class="product-media">
          <div class="product-gallery">
            <span class="product-number">${String(index + 1).padStart(2, "0")}</span>
            <img src="" alt="${product.name}" />
          </div>
          <div class="gallery-thumbs"></div>
        </div>
        <div class="product-info">
          <p class="product-type">MAIN PRODUCT</p>
          <h2>${product.name}</h2>
          <p class="product-description">${product.description || ""}</p>
          <div class="option-groups"></div>
          <div class="specs">
            <div><span>FINISH</span><strong data-spec="finish"></strong></div>
            <div><span>MATERIAL</span><strong data-spec="material"></strong></div>
            ${specRows}
          </div>
        </div>`;

      const groupsWrap = article.querySelector(".option-groups");
      product.product_option_groups.forEach((group) =>
        groupsWrap.appendChild(renderGroup(article, product, group))
      );

      productsWrap.appendChild(article);
      refreshProduct(article, product);
    });
  }

  function renderGroup(article, product, group) {
    const wrap = document.createElement("div");
    wrap.className = "option-group";
    wrap.dataset.groupId = group.id;

    const label = document.createElement("p");
    label.className = "option-group-label";
    label.textContent = group.name;
    wrap.appendChild(label);

    const isSwatch = group.display_as === "swatch";

    if (group.display_as === "dropdown") {
      const select = document.createElement("select");
      select.className = "option-select";
      select.setAttribute("aria-label", `${product.name} — ${group.name}`);
      group.product_options.forEach((option) => {
        const el = document.createElement("option");
        el.value = option.id;
        el.textContent = labelFor(option);
        if (option.id === chosenOption.get(group.id)) el.selected = true;
        select.appendChild(el);
      });
      select.addEventListener("change", () => {
        chosenOption.set(group.id, select.value);
        refreshProduct(article, product);
        updateTotal();
      });
      wrap.appendChild(select);
      return wrap;
    }

    const list = document.createElement("div");
    list.className = isSwatch ? "color-options" : "chip-options";

    group.product_options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.optionId = option.id;

      if (isSwatch) {
        // data-color keeps the existing packages.css rules working; the inline
        // background is what guarantees a swatch renders, including for
        // colours the stylesheet has never heard of.
        button.className = "color-option";
        button.dataset.color = option.name;
        button.style.background = option.swatch_hex || "#cccccc";
        button.setAttribute("aria-label", `${product.name} in ${option.name}`);
      } else {
        button.className = "chip-option";
        button.textContent = labelFor(option);
      }

      if (option.id === chosenOption.get(group.id)) button.classList.add("active");

      button.addEventListener("click", () => {
        chosenOption.set(group.id, option.id);
        galleryIndex.set(product.id, 0);
        refreshProduct(article, product);
        updateTotal();
      });

      list.appendChild(button);
    });

    wrap.appendChild(list);
    return wrap;
  }

  function labelFor(option) {
    return option.price_delta_paise
      ? `${option.name} (+${SC.money(option.price_delta_paise)})`
      : option.name;
  }

  // Re-syncs image, specs, and which buttons look selected. Called after any
  // change rather than mutating individual bits, so the DOM can never drift
  // out of step with chosenOption.
  function refreshProduct(article, product) {
    const image = article.querySelector(".product-gallery img");
    const thumbs = article.querySelector(".gallery-thumbs");
    const shown = imageOptionFor(product);
    const gallery = shown?.image_paths ?? [];

    const index = Math.min(galleryIndex.get(product.id) ?? 0, Math.max(gallery.length - 1, 0));

    if (gallery.length) {
      image.src = gallery[index];
      image.alt = `${product.name} in ${shown.name}`;
    }

    // Only worth showing thumbnails when there is more than one photo.
    thumbs.textContent = "";
    if (gallery.length > 1) {
      gallery.forEach((src, position) => {
        const thumb = document.createElement("button");
        thumb.type = "button";
        thumb.className = `gallery-thumb${position === index ? " active" : ""}`;
        thumb.setAttribute(
          "aria-label",
          `${product.name} in ${shown.name}, photo ${position + 1} of ${gallery.length}`
        );
        thumb.innerHTML = `<img src="${src}" alt="" />`;
        thumb.addEventListener("click", () => {
          galleryIndex.set(product.id, position);
          refreshProduct(article, product);
        });
        thumbs.appendChild(thumb);
      });
    }

    article.querySelector('[data-spec="finish"]').textContent =
      shown?.finish || "—";
    article.querySelector('[data-spec="material"]').textContent =
      shown?.material || "—";

    product.product_option_groups.forEach((group) => {
      const selectedId = chosenOption.get(group.id);
      article
        .querySelectorAll(`[data-group-id="${group.id}"] button`)
        .forEach((button) =>
          button.classList.toggle("active", button.dataset.optionId === selectedId)
        );
    });
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
    const { data: existing, error: readError } = await sb
      .from("carts")
      .select("id")
      .eq("user_id", SC.userId)
      .eq("status", "active")
      .maybeSingle();

    if (readError) throw readError;
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
    // Replace rather than diff: the selection is small, and this keeps the
    // stored rows exactly matching what is on screen.
    await sb.from("cart_item_options").delete().eq("cart_item_id", cartItemId);
    await sb.from("cart_item_addons").delete().eq("cart_item_id", cartItemId);

    const optionRows = [...chosenOption.entries()].map(([group_id, option_id]) => ({
      cart_item_id: cartItemId,
      group_id,
      option_id,
    }));
    if (optionRows.length) {
      const { error } = await sb.from("cart_item_options").insert(optionRows);
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
          body: "This package is already in your cart. Would you like to add a second one with the options currently selected?",
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
    // Deliberately does NOT offer to save. Offering it here misled people who
    // had already pressed Save into saving a second copy. This only checks
    // they meant to move on.
    const proceed = await confirmDialog({
      eyebrow: "REVIEW YOUR ORDER",
      title: "Saved this package?",
      body: "Only saved packages appear in your order review. If you have not pressed Save to cart yet, go back and do that first.",
      cancelText: "Go back",
      confirmText: "Yes, continue",
    });

    if (proceed) window.location.href = "checkout.html";
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
