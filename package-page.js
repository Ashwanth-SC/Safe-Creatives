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
         id, key, name, description, sub_heading, specs, sort_order,
         product_option_groups (
           id, key, name, display_as, sort_order,
           product_options ( id, key, name, description, price_delta_paise,
                             image_paths, swatch_hex, finish, material,
                             parent_option_id, is_active, sort_order )
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

  // Browsing is open to everyone, but saving to a cart needs an account. When a
  // logged-out visitor configures a package and hits save, the selection is
  // stashed in localStorage and they are sent to log in; on return to this page
  // it is restored so nothing is retyped. Keyed by package so the two do not mix.
  const stashKey = `sc-config-${packageKey}`;

  function stashSelection() {
    try {
      localStorage.setItem(
        stashKey,
        JSON.stringify({
          options: [...chosenOption.entries()],
          addons: [...chosenAddons],
        })
      );
    } catch (_ignored) {
      // Private mode or quota: not worth blocking the login redirect over.
    }
  }

  function restoreStashedSelection() {
    if (editItemId) return false; // editing a saved item takes precedence
    let raw = null;
    try {
      raw = localStorage.getItem(stashKey);
    } catch (_ignored) {
      return false;
    }
    if (!raw) return false;
    try {
      localStorage.removeItem(stashKey);
    } catch (_ignored) {
      /* ignore */
    }
    try {
      const saved = JSON.parse(raw);
      (saved.options || []).forEach(([groupId, optionId]) => {
        // Skip anything the catalog has since dropped; defaults fill the gap.
        if (optionById(groupId, optionId)) chosenOption.set(groupId, optionId);
      });
      (saved.addons || []).forEach((id) => chosenAddons.add(id));
      return true;
    } catch (_ignored) {
      return false;
    }
  }

  const isRestored = restoreStashedSelection();

  // Defaults, size-then-colour aware: colours are children of a size, so the
  // colour default (and any restored colour) must belong to the chosen size.
  function firstColourFor(colourGroup, sizeId) {
    return colourGroup.product_options.find(
      (o) => o.parent_option_id === sizeId && o.is_active !== false
    );
  }

  pkg.package_products.forEach((product) => {
    const sizeGroup = product.product_option_groups.find((g) => g.key === "size");
    const colourGroup = product.product_option_groups.find((g) => g.key === "colour");

    if (sizeGroup && !chosenOption.has(sizeGroup.id) && sizeGroup.product_options.length) {
      chosenOption.set(sizeGroup.id, sizeGroup.product_options[0].id);
    }

    if (colourGroup) {
      const sizeId = sizeGroup ? chosenOption.get(sizeGroup.id) : null;
      const current = colourGroup.product_options.find(
        (o) => o.id === chosenOption.get(colourGroup.id)
      );
      const validForSize =
        current && current.parent_option_id === sizeId && current.is_active !== false;
      if (!validForSize) {
        const first = firstColourFor(colourGroup, sizeId);
        if (first) chosenOption.set(colourGroup.id, first.id);
        else chosenOption.delete(colourGroup.id);
      }
    }

    // Any other groups (defensive) fall back to their first option.
    product.product_option_groups.forEach((g) => {
      if (
        g.key !== "size" &&
        g.key !== "colour" &&
        !chosenOption.has(g.id) &&
        g.product_options.length
      ) {
        chosenOption.set(g.id, g.product_options[0].id);
      }
    });
  });

  // A NEW configuration starts with the default add-ons already selected --
  // the customer removes what they do not want rather than hunting for what
  // they do. Editing an existing cart item does NOT do this: their saved
  // choices are the truth, and re-ticking a removed add-on would silently
  // put back something they had deliberately taken out.
  if (!isEditing && !isRestored) {
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

  // Colours are children of a size (parent_option_id), each with its own
  // gallery. The photo shown comes from the chosen colour; the visible colours
  // are only those belonging to the chosen size.
  function groupByKey(product, key) {
    return product.product_option_groups.find((g) => g.key === key);
  }
  function chosenSizeId(product) {
    const g = groupByKey(product, "size");
    return g ? chosenOption.get(g.id) : null;
  }
  function coloursForSize(product) {
    const cg = groupByKey(product, "colour");
    if (!cg) return [];
    const sizeId = chosenSizeId(product);
    return cg.product_options.filter(
      (o) => o.parent_option_id === sizeId && o.is_active !== false
    );
  }
  function chosenColour(product) {
    const cg = groupByKey(product, "colour");
    return cg ? optionById(cg.id, chosenOption.get(cg.id)) : null;
  }

  // Which photo in the current gallery is showing, per product. Resets to the
  // first whenever the size or colour changes.
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
          ${product.sub_heading ? `<p class="product-subheading">${product.sub_heading}</p>` : ""}
          <p class="product-description">${product.description || ""}</p>
          <div class="option-groups"></div>
          <div class="specs">
            <div><span>FINISH</span><strong data-spec="finish"></strong></div>
            <div><span>MATERIAL</span><strong data-spec="material"></strong></div>
            ${specRows}
          </div>
        </div>`;

      renderOptionGroups(article, product);
      productsWrap.appendChild(article);
      refreshProduct(article, product);
    });
  }

  // Size chips, then the colours for the chosen size. Rebuilt whole on a size
  // change so the colour set always matches the size.
  function renderOptionGroups(article, product) {
    const wrap = article.querySelector(".option-groups");
    wrap.textContent = "";

    const sizeGroup = groupByKey(product, "size");
    const colourGroup = groupByKey(product, "colour");

    if (sizeGroup) {
      wrap.appendChild(
        buildOptionGroup(sizeGroup, sizeGroup.product_options, product, false, (option) => {
          chosenOption.set(sizeGroup.id, option.id);
          // Colours are per-size — jump to the new size's first colour.
          const colours = coloursForSize(product);
          if (colourGroup) {
            if (colours.length) chosenOption.set(colourGroup.id, colours[0].id);
            else chosenOption.delete(colourGroup.id);
          }
          galleryIndex.set(product.id, 0);
          renderOptionGroups(article, product);
          refreshProduct(article, product);
          updateTotal();
        })
      );
    }

    if (colourGroup) {
      wrap.appendChild(
        buildOptionGroup(colourGroup, coloursForSize(product), product, true, (option) => {
          chosenOption.set(colourGroup.id, option.id);
          galleryIndex.set(product.id, 0);
          refreshProduct(article, product);
          updateTotal();
        })
      );
    }
  }

  function buildOptionGroup(group, options, product, isSwatch, onSelect) {
    const wrap = document.createElement("div");
    wrap.className = "option-group";
    wrap.dataset.groupId = group.id;

    const label = document.createElement("p");
    label.className = "option-group-label";
    label.textContent = group.name;
    wrap.appendChild(label);

    const list = document.createElement("div");
    list.className = isSwatch ? "color-options" : "chip-options";

    options.forEach((option) => {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.optionId = option.id;

      if (isSwatch) {
        button.className = "color-option";
        button.dataset.color = option.name;
        button.style.background = option.swatch_hex || "#cccccc";
        button.setAttribute("aria-label", `${product.name} in ${option.name}`);
      } else {
        button.className = "chip-option";
        button.textContent = labelFor(option);
      }

      if (option.id === chosenOption.get(group.id)) button.classList.add("active");
      button.addEventListener("click", () => onSelect(option));
      list.appendChild(button);
    });

    wrap.appendChild(list);
    return wrap;
  }

  // Size chips carry no price of their own — the price lives on the colour
  // (size × colour) — so the chip is just the size name.
  function labelFor(option) {
    return option.name;
  }

  // Re-syncs image, specs, and which buttons look selected. Called after any
  // change rather than mutating individual bits, so the DOM can never drift
  // out of step with chosenOption.
  function refreshProduct(article, product) {
    const image = article.querySelector(".product-gallery img");
    const thumbs = article.querySelector(".gallery-thumbs");
    const shown = chosenColour(product);
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

  // Gate the cart actions. Returns true if the visitor may proceed; otherwise it
  // stashes the current selection and sends them to log in — the `next` param
  // carries back to this page through the whole login + registration flow.
  function requireLogin() {
    if (SC.session) return true;
    stashSelection();
    SC.toLogin();
    return false;
  }

  async function savePackage() {
    if (!requireLogin()) return false;

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
    if (!requireLogin()) return;

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
