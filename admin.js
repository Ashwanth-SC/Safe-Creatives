// ============================================================================
// Safe Creatives — catalog admin
// ============================================================================
//
// CRUD over packages, products, option groups, options, and add-ons.
//
// Two things this page exists to prevent:
//
//   1. Paise mistakes. Prices are stored as 18500000 for ₹1,85,000. Typing
//      185000 into a raw table cell is a 100x error on a live price with
//      nothing to catch it. Every money field here is in RUPEES and converted
//      on save, and shows the stored paise value beneath so the conversion is
//      never a black box.
//
//   2. UUID juggling. Adding a package by hand means ~19 rows across 4 tables
//      with ids copied between them. Here the parent id is filled in for you.
//
// Access is enforced by RLS (is_admin()), not by this file. Hiding the UI is
// convenience; the database is what actually refuses a non-admin's write.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const body = document.querySelector("#admin-body");
  const packagesWrap = document.querySelector("#packages");
  const messageEl = document.querySelector("#admin-message");

  if (!SC.isAdmin) {
    denied.hidden = false;
    return;
  }
  body.hidden = false;

  // ------------------------------------------------------------------
  // Money helpers
  // ------------------------------------------------------------------

  const toPaise = (rupees) => Math.round(Number(rupees || 0) * 100);
  const toRupees = (paise) => Number(paise || 0) / 100;

  function message(text, isError) {
    messageEl.textContent = text;
    messageEl.className = `admin-message${isError ? " is-error" : " is-ok"}`;
    window.clearTimeout(message.timer);
    message.timer = window.setTimeout(() => {
      messageEl.textContent = "";
      messageEl.className = "admin-message";
    }, 4000);
  }

  // Turns "Calm Corner Sofa" into "calm-corner-sofa". Keys are the stable
  // identifier the seed and any external reference use, so they are generated
  // once from the name and then left alone.
  function slugify(value) {
    return value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
  }

  // ------------------------------------------------------------------
  // Data access
  // ------------------------------------------------------------------

  async function loadCatalog() {
    const { data, error } = await sb
      .from("packages")
      .select(
        `id, key, name, description, base_price_paise, cover_image_path,
         hsn_code, is_active, sort_order,
         package_products (
           id, key, name, description, hsn_code, sort_order,
           product_option_groups (
             id, key, name, display_as, sort_order,
             product_options ( id, key, name, price_delta_paise, image_paths,
                               swatch_hex, finish, material, is_active, sort_order )
           )
         ),
         package_addons ( id, key, name, description, image_path, price_paise,
                          hsn_code, is_default_selected, is_active, sort_order )`
      )
      .order("sort_order");

    if (error) throw error;

    const bySort = (a, b) => a.sort_order - b.sort_order;
    data.forEach((pkg) => {
      pkg.package_products.sort(bySort);
      pkg.package_products.forEach((product) => {
        product.product_option_groups.sort(bySort);
        product.product_option_groups.forEach((group) =>
          group.product_options.sort(bySort)
        );
      });
      pkg.package_addons.sort(bySort);
    });

    return data;
  }

  async function save(table, id, patch) {
    const { error } = await sb.from(table).update(patch).eq("id", id);
    if (error) throw error;
  }

  async function create(table, row) {
    const { data, error } = await sb.from(table).insert(row).select("id").single();
    if (error) throw error;
    return data.id;
  }

  async function remove(table, id) {
    const { error } = await sb.from(table).delete().eq("id", id);
    if (error) throw error;
  }

  // ------------------------------------------------------------------
  // Small DOM builders
  // ------------------------------------------------------------------

  function field(label, value, opts = {}) {
    const wrap = document.createElement("label");
    wrap.className = "admin-field";

    const text = document.createElement("span");
    text.textContent = label;
    wrap.appendChild(text);

    const input = opts.multiline
      ? document.createElement("textarea")
      : document.createElement("input");

    if (opts.multiline) input.rows = opts.rows || 2;
    else input.type = opts.type || "text";

    input.value = value ?? "";
    if (opts.placeholder) input.placeholder = opts.placeholder;
    if (opts.step) input.step = opts.step;

    wrap.appendChild(input);

    if (opts.hint) {
      const hint = document.createElement("small");
      hint.className = "admin-hint";
      hint.textContent = opts.hint;
      wrap.appendChild(hint);
    }

    wrap.input = input;
    return wrap;
  }

  // Money fields show the stored paise value live, so the rupee-to-paise
  // conversion is visible rather than implied.
  function moneyField(label, paise) {
    const wrap = field(label, toRupees(paise), {
      type: "number",
      step: "1",
      hint: `stored as ${Number(paise || 0).toLocaleString("en-IN")} paise`,
    });
    const hint = wrap.querySelector(".admin-hint");
    wrap.input.addEventListener("input", () => {
      hint.textContent = `stored as ${toPaise(wrap.input.value).toLocaleString("en-IN")} paise`;
    });
    return wrap;
  }

  function select(label, value, options) {
    const wrap = document.createElement("label");
    wrap.className = "admin-field";
    const text = document.createElement("span");
    text.textContent = label;
    const el = document.createElement("select");
    options.forEach(([val, name]) => {
      const opt = document.createElement("option");
      opt.value = val;
      opt.textContent = name;
      if (val === value) opt.selected = true;
      el.appendChild(opt);
    });
    wrap.append(text, el);
    wrap.input = el;
    return wrap;
  }

  function button(text, className, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = text;
    el.addEventListener("click", onClick);
    return el;
  }

  async function confirmDelete(what, extra) {
    return window.confirm(
      `Delete ${what}?\n\n${extra}\n\nThis cannot be undone.`
    );
  }

  // Wraps a save/delete handler so every failure surfaces the same way and the
  // button cannot be double-clicked mid-request.
  function action(btn, work, okText) {
    return async () => {
      btn.disabled = true;
      try {
        await work();
        message(okText);
        await render();
      } catch (error) {
        message(error.message, true);
      } finally {
        btn.disabled = false;
      }
    };
  }

  // ------------------------------------------------------------------
  // Options
  // ------------------------------------------------------------------

  function renderOption(group, option) {
    const row = document.createElement("div");
    row.className = "admin-option";

    const isSwatch = group.display_as === "swatch";

    const name = field("Name", option.name);
    const price = moneyField("Price change (₹)", option.price_delta_paise);
    const sort = field("Order", option.sort_order, { type: "number" });

    row.append(name, price, sort);

    let hex, finish, material, images;

    if (isSwatch) {
      hex = field("Swatch colour", option.swatch_hex || "#cccccc", {
        placeholder: "#d0b28e",
        hint: "hex, e.g. #d0b28e",
      });
      finish = field("Finish", option.finish, { placeholder: "Warm sand" });
      material = field("Material", option.material, { placeholder: "Textured linen" });
      row.append(hex, finish, material);

      // Four slots because that is the house style; the column is an array so
      // more is possible without a schema change.
      const gallery = document.createElement("div");
      gallery.className = "admin-gallery";
      const galleryLabel = document.createElement("p");
      galleryLabel.className = "admin-subtle";
      galleryLabel.textContent = "Images (4) — first is the main photo";
      gallery.appendChild(galleryLabel);

      images = [0, 1, 2, 3].map((i) => {
        const f = field(`Image ${i + 1}`, option.image_paths?.[i] || "", {
          placeholder: "https://...",
        });
        gallery.appendChild(f);
        return f;
      });
      row.appendChild(gallery);
    }

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";

    const saveBtn = button("Save", "admin-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        async () => {
          const patch = {
            name: name.input.value.trim(),
            price_delta_paise: toPaise(price.input.value),
            sort_order: Number(sort.input.value) || 0,
          };
          if (isSwatch) {
            patch.swatch_hex = hex.input.value.trim() || null;
            patch.finish = finish.input.value.trim() || null;
            patch.material = material.input.value.trim() || null;
            patch.image_paths = images
              .map((f) => f.input.value.trim())
              .filter(Boolean);
          }
          await save("product_options", option.id, patch);
        },
        `Saved "${option.name}"`
      )
    );

    const delBtn = button("Delete", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      if (
        !(await confirmDelete(
          `the option "${option.name}"`,
          "Carts and orders that already reference it will block the delete."
        ))
      )
        return;
      action(delBtn, () => remove("product_options", option.id), "Option deleted")();
    });

    actions.append(saveBtn, delBtn);
    row.appendChild(actions);
    return row;
  }

  // ------------------------------------------------------------------
  // Option groups
  // ------------------------------------------------------------------

  function renderGroup(product, group) {
    const box = document.createElement("details");
    box.className = "admin-group";
    // Keys let render() restore which sections were open after a save.
    box.dataset.key = `grp:${group.id}`;

    const summary = document.createElement("summary");
    summary.innerHTML = `<strong>${group.name}</strong> <span class="admin-subtle">${group.display_as} · ${group.product_options.length} option(s)</span>`;
    box.appendChild(summary);

    const name = field("Group name", group.name);
    const display = select("Shown as", group.display_as, [
      ["swatch", "Colour swatches"],
      ["chip", "Chips (best for sizes)"],
      ["dropdown", "Dropdown (long lists)"],
    ]);
    const sort = field("Order", group.sort_order, { type: "number" });

    const head = document.createElement("div");
    head.className = "admin-inline";
    head.append(name, display, sort);

    const saveBtn = button("Save group", "admin-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        () =>
          save("product_option_groups", group.id, {
            name: name.input.value.trim(),
            display_as: display.input.value,
            sort_order: Number(sort.input.value) || 0,
          }),
        "Group saved"
      )
    );

    const delBtn = button("Delete group", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      if (
        !(await confirmDelete(
          `the "${group.name}" group`,
          `All ${group.product_options.length} option(s) inside it go too.`
        ))
      )
        return;
      action(delBtn, () => remove("product_option_groups", group.id), "Group deleted")();
    });

    const headActions = document.createElement("div");
    headActions.className = "admin-row-actions";
    headActions.append(saveBtn, delBtn);

    box.append(head, headActions);

    group.product_options.forEach((option) =>
      box.appendChild(renderOption(group, option))
    );

    const addBtn = button("+ Add option", "admin-small", () => {});
    addBtn.addEventListener(
      "click",
      action(
        addBtn,
        async () => {
          const label = window.prompt("Option name (e.g. King, or Charcoal)");
          if (!label) return;
          await create("product_options", {
            group_id: group.id,
            key: slugify(label),
            name: label,
            price_delta_paise: 0,
            sort_order: group.product_options.length + 1,
          });
        },
        "Option added"
      )
    );
    box.appendChild(addBtn);

    return box;
  }

  // ------------------------------------------------------------------
  // Products
  // ------------------------------------------------------------------

  function renderProduct(pkg, product) {
    const box = document.createElement("details");
    box.className = "admin-product";
    box.dataset.key = `prod:${product.id}`;

    const summary = document.createElement("summary");
    summary.innerHTML = `<strong>${product.name}</strong> <span class="admin-subtle">${product.product_option_groups.length} option group(s)</span>`;
    box.appendChild(summary);

    const name = field("Product name", product.name);
    const description = field("Description", product.description, {
      multiline: true,
      rows: 2,
    });
    const sort = field("Order", product.sort_order, { type: "number" });
    const hsn = field("HSN code", product.hsn_code, {
      placeholder: "9403",
      hint: "For reference and line descriptions",
    });

    const head = document.createElement("div");
    head.className = "admin-inline";
    head.append(name, sort, hsn);
    box.append(head, description);

    const saveBtn = button("Save product", "admin-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        () =>
          save("package_products", product.id, {
            name: name.input.value.trim(),
            description: description.input.value.trim() || null,
            hsn_code: hsn.input.value.trim() || null,
            sort_order: Number(sort.input.value) || 0,
          }),
        "Product saved"
      )
    );

    const delBtn = button("Delete product", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      if (
        !(await confirmDelete(
          `the product "${product.name}"`,
          "Its option groups and all their options go too."
        ))
      )
        return;
      action(delBtn, () => remove("package_products", product.id), "Product deleted")();
    });

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";
    actions.append(saveBtn, delBtn);
    box.appendChild(actions);

    product.product_option_groups.forEach((group) =>
      box.appendChild(renderGroup(product, group))
    );

    const addGroup = button("+ Add option group", "admin-small", () => {});
    addGroup.addEventListener(
      "click",
      action(
        addGroup,
        async () => {
          const label = window.prompt("Group name (e.g. Size, Colour, Fabric)");
          if (!label) return;
          await create("product_option_groups", {
            product_id: product.id,
            key: slugify(label),
            name: label,
            display_as: "chip",
            sort_order: product.product_option_groups.length + 1,
          });
        },
        "Group added"
      )
    );
    box.appendChild(addGroup);

    return box;
  }

  // ------------------------------------------------------------------
  // Add-ons
  // ------------------------------------------------------------------

  function renderAddon(pkg, addon) {
    const row = document.createElement("div");
    row.className = "admin-option";

    const name = field("Name", addon.name);
    const price = moneyField("Price (₹)", addon.price_paise);
    const sort = field("Order", addon.sort_order, { type: "number" });
    const description = field("Description", addon.description, {
      multiline: true,
      rows: 2,
    });
    const image = field("Image", addon.image_path, { placeholder: "https://..." });
    const hsn = field("HSN code", addon.hsn_code, { placeholder: "9404" });
    const preselected = select(
      "Pre-selected",
      String(addon.is_default_selected),
      [
        ["true", "Yes — ticked by default"],
        ["false", "No — customer opts in"],
      ]
    );

    const head = document.createElement("div");
    head.className = "admin-inline";
    head.append(name, price, sort, hsn, preselected);
    row.append(head, description, image);

    const saveBtn = button("Save", "admin-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        () =>
          save("package_addons", addon.id, {
            name: name.input.value.trim(),
            description: description.input.value.trim() || null,
            image_path: image.input.value.trim() || null,
            hsn_code: hsn.input.value.trim() || null,
            price_paise: toPaise(price.input.value),
            is_default_selected: preselected.input.value === "true",
            sort_order: Number(sort.input.value) || 0,
          }),
        `Saved "${addon.name}"`
      )
    );

    const delBtn = button("Delete", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      if (
        !(await confirmDelete(
          `the add-on "${addon.name}"`,
          "Carts and orders that already reference it will block the delete."
        ))
      )
        return;
      action(delBtn, () => remove("package_addons", addon.id), "Add-on deleted")();
    });

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";
    actions.append(saveBtn, delBtn);
    row.appendChild(actions);

    return row;
  }

  // ------------------------------------------------------------------
  // Packages
  // ------------------------------------------------------------------

  function renderPackage(pkg) {
    const box = document.createElement("details");
    box.className = "admin-package";
    box.open = false;

    const summary = document.createElement("summary");
    summary.innerHTML = `<strong>${pkg.name}</strong> <span class="admin-subtle">${SC.money(
      pkg.base_price_paise
    )} base · ${pkg.package_products.length} product(s) · ${
      pkg.package_addons.length
    } add-on(s)${pkg.is_active ? "" : " · HIDDEN"}</span>`;
    box.appendChild(summary);

    const name = field("Package name", pkg.name);
    const price = moneyField("Base price (₹)", pkg.base_price_paise);
    const sort = field("Order", pkg.sort_order, { type: "number" });
    const description = field("Description", pkg.description, {
      multiline: true,
      rows: 2,
    });
    const active = select("Visible in store", String(pkg.is_active), [
      ["true", "Yes"],
      ["false", "No — hidden"],
    ]);
    const cover = field("Cover image", pkg.cover_image_path, {
      placeholder: "https://...",
      hint: "Shown on the Sensory Rooms cards",
    });
    const hsn = field("HSN / SAC code", pkg.hsn_code, {
      placeholder: "9403",
      hint: "Printed on invoice lines for this package",
    });

    const head = document.createElement("div");
    head.className = "admin-inline";
    head.append(name, price, sort, active);
    box.append(head, description, cover, hsn);

    const saveBtn = button("Save package", "admin-primary-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        () =>
          save("packages", pkg.id, {
            name: name.input.value.trim(),
            description: description.input.value.trim() || null,
            base_price_paise: toPaise(price.input.value),
            cover_image_path: cover.input.value.trim() || null,
            hsn_code: hsn.input.value.trim() || null,
            is_active: active.input.value === "true",
            sort_order: Number(sort.input.value) || 0,
          }),
        "Package saved"
      )
    );

    const delBtn = button("Delete package", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      if (
        !(await confirmDelete(
          `the package "${pkg.name}"`,
          "Every product, option group, option and add-on inside it goes too. If it appears in any cart or order, the database will refuse — hide it instead."
        ))
      )
        return;
      action(delBtn, () => remove("packages", pkg.id), "Package deleted")();
    });

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";
    actions.append(saveBtn, delBtn);
    box.appendChild(actions);

    const productsTitle = document.createElement("h3");
    productsTitle.className = "admin-section-title";
    productsTitle.textContent = "Main products";
    box.appendChild(productsTitle);

    pkg.package_products.forEach((product) =>
      box.appendChild(renderProduct(pkg, product))
    );

    const addProduct = button("+ Add product", "admin-small", () => {});
    addProduct.addEventListener(
      "click",
      action(
        addProduct,
        async () => {
          const label = window.prompt("Product name (e.g. Reading Chair)");
          if (!label) return;
          const productId = await create("package_products", {
            package_id: pkg.id,
            key: slugify(label),
            name: label,
            sort_order: pkg.package_products.length + 1,
          });
          // A product with no groups cannot be configured, so give it the two
          // it will almost certainly need rather than leaving an empty shell.
          await create("product_option_groups", {
            product_id: productId,
            key: "size",
            name: "Size",
            display_as: "chip",
            sort_order: 1,
          });
          await create("product_option_groups", {
            product_id: productId,
            key: "colour",
            name: "Colour",
            display_as: "swatch",
            sort_order: 2,
          });
        },
        "Product added with Size and Colour groups"
      )
    );
    box.appendChild(addProduct);

    const addonsTitle = document.createElement("h3");
    addonsTitle.className = "admin-section-title";
    addonsTitle.textContent = "Add-ons";
    box.appendChild(addonsTitle);

    pkg.package_addons.forEach((addon) => box.appendChild(renderAddon(pkg, addon)));

    const addAddon = button("+ Add add-on", "admin-small", () => {});
    addAddon.addEventListener(
      "click",
      action(
        addAddon,
        async () => {
          const label = window.prompt("Add-on name (e.g. Blackout blind)");
          if (!label) return;
          await create("package_addons", {
            package_id: pkg.id,
            key: slugify(label),
            name: label,
            price_paise: 0,
            sort_order: pkg.package_addons.length + 1,
          });
        },
        "Add-on added — set its price"
      )
    );
    box.appendChild(addAddon);

    return box;
  }

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  // Which <details> were open, so a save does not collapse everything.
  function openKeys() {
    return new Set(
      [...packagesWrap.querySelectorAll("details[open]")].map(
        (el) => el.dataset.key
      )
    );
  }

  async function render() {
    const wasOpen = openKeys();
    packagesWrap.textContent = "";

    let catalog;
    try {
      catalog = await loadCatalog();
    } catch (error) {
      message(`Could not load the catalog: ${error.message}`, true);
      return;
    }

    catalog.forEach((pkg) => {
      const el = renderPackage(pkg);
      el.dataset.key = `pkg:${pkg.id}`;
      packagesWrap.appendChild(el);
    });

    packagesWrap.querySelectorAll("details").forEach((el) => {
      if (el.dataset.key && wasOpen.has(el.dataset.key)) el.open = true;
    });
  }

  // ------------------------------------------------------------------
  // Invoice settings
  // ------------------------------------------------------------------
  // Business-wide, not per-package: the advance is the same booking service
  // whichever room it reserves, so its SAC lives on seller_settings.

  async function renderInvoiceSettings() {
    const container = document.querySelector("#invoice-settings");
    container.textContent = "";

    const { data: settings, error } = await sb
      .from("seller_settings")
      .select("advance_hsn_code")
      .eq("id", true)
      .maybeSingle();

    if (error) {
      message(`Could not load invoice settings: ${error.message}`, true);
      return;
    }

    const box = document.createElement("div");
    box.className = "admin-option admin-settings";

    const title = document.createElement("p");
    title.className = "admin-section-title";
    title.style.margin = "0 0 10px";
    title.textContent = "Invoice settings";

    const hsn = field("Advance HSN / SAC code", settings?.advance_hsn_code, {
      placeholder: "9954",
      hint: "Printed on the advance line of every invoice. Confirm the classification with your CA — the advance is a service, not goods.",
    });

    const saveBtn = button("Save settings", "admin-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        async () => {
          const { error: saveError } = await sb
            .from("seller_settings")
            .update({
              advance_hsn_code: hsn.input.value.trim() || null,
              updated_at: new Date().toISOString(),
            })
            .eq("id", true);
          if (saveError) throw saveError;
        },
        "Invoice settings saved"
      )
    );

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";
    actions.appendChild(saveBtn);

    box.append(title, hsn, actions);
    container.appendChild(box);
  }

  document.querySelector("#add-package").addEventListener("click", async () => {
    const label = window.prompt("Package name (e.g. Study Package)");
    if (!label) return;
    try {
      await create("packages", {
        key: slugify(label),
        name: label,
        base_price_paise: 0,
        is_active: false,
        sort_order: 99,
      });
      message("Package created — hidden until you set a price and unhide it");
      await render();
    } catch (error) {
      message(error.message, true);
    }
  });

  await renderInvoiceSettings();
  await render();
})();
