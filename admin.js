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
           id, key, name, description, specs, hsn_code, sort_order,
           product_option_groups (
             id, key, name, display_as, sort_order,
             product_options ( id, key, name, price_delta_paise, image_paths,
                               swatch_hex, finish, material, parent_option_id,
                               is_active, sort_order )
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

  // Generic element builder used by the CSV bulk-fill UI. (The local `const el`
  // above is a different, function-scoped variable — it does not clash.)
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  async function confirmDelete(what, extra) {
    return window.confirm(
      `Delete ${what}?\n\n${extra}\n\nThis cannot be undone.`
    );
  }

  // Merchandising minimums, enforced in the UI so the catalog can never be left
  // unusable (a package with no products, a size with no colours, and so on).
  // A delete that would drop below the minimum is refused with a popup instead.
  // The database enforces integrity separately; this is the friendly guard.
  let packageCount = 0;
  let selectedPackageId = null;
  function guardMinimum(count, min, whatPlural) {
    if (count > min) return false;
    window.alert(
      `You must keep at least ${min} ${whatPlural}.\n\n` +
        "Add another before deleting this one."
    );
    return true;
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
      const siblingColours = group.product_options.filter(
        (o) => o.parent_option_id === option.parent_option_id && o.is_active !== false
      ).length;
      if (guardMinimum(siblingColours, 1, "colour per size")) return;
      if (
        !(await confirmDelete(
          `the colour "${option.name}"`,
          "Any cart still holding this colour simply drops it; past orders keep their record."
        ))
      )
        return;
      action(delBtn, () => remove("product_options", option.id), "Colour deleted")();
    });

    actions.append(saveBtn, delBtn);
    row.appendChild(actions);
    return row;
  }

  // ------------------------------------------------------------------
  // Sizes (each with its own colours)
  // ------------------------------------------------------------------
  // Colours are children of a size via parent_option_id, each with its own
  // gallery. So a size expands to reveal that size's colours; add/remove
  // colours per size, and add more sizes.

  function coloursOfSize(colourGroup, sizeOption) {
    return colourGroup
      ? colourGroup.product_options.filter(
          (o) => o.parent_option_id === sizeOption.id && o.is_active !== false
        )
      : [];
  }

  function renderSize(product, sizeGroup, colourGroup, sizeOption) {
    const box = document.createElement("details");
    box.className = "admin-group";
    box.dataset.key = `size:${sizeOption.id}`;

    const colours = coloursOfSize(colourGroup, sizeOption);

    const summary = document.createElement("summary");
    summary.innerHTML = `<strong>Size: ${sizeOption.name}</strong> <span class="admin-subtle">${colours.length} colour(s)</span>`;
    box.appendChild(summary);

    const name = field("Size name", sizeOption.name);
    const price = moneyField("Price change (₹)", sizeOption.price_delta_paise);
    const sort = field("Order", sizeOption.sort_order, { type: "number" });

    const head = document.createElement("div");
    head.className = "admin-inline";
    head.append(name, price, sort);
    box.appendChild(head);

    const saveBtn = button("Save size", "admin-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(
        saveBtn,
        () =>
          save("product_options", sizeOption.id, {
            name: name.input.value.trim(),
            price_delta_paise: toPaise(price.input.value),
            sort_order: Number(sort.input.value) || 0,
          }),
        "Size saved"
      )
    );

    const delBtn = button("Delete size", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      const sizeCount = sizeGroup.product_options.filter(
        (o) => !o.parent_option_id && o.is_active !== false
      ).length;
      if (guardMinimum(sizeCount, 1, "size per product")) return;
      if (
        !(await confirmDelete(
          `the size "${sizeOption.name}"`,
          `Its ${colours.length} colour(s) go too, and it's removed from any cart that held it.`
        ))
      )
        return;
      action(delBtn, () => remove("product_options", sizeOption.id), "Size deleted")();
    });

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";
    actions.append(saveBtn, delBtn);
    box.appendChild(actions);

    const coloursTitle = document.createElement("p");
    coloursTitle.className = "admin-section-title";
    coloursTitle.textContent = "Colours for this size";
    box.appendChild(coloursTitle);

    // Reuse the option editor (swatch + gallery) for each colour.
    colours.forEach((colour) => box.appendChild(renderOption(colourGroup, colour)));

    const addColour = button("+ Add colour", "admin-small", () => {});
    addColour.addEventListener(
      "click",
      action(
        addColour,
        async () => {
          if (!colourGroup) throw new Error("This product has no colour group.");
          const label = window.prompt("Colour name (e.g. Charcoal)");
          if (!label) return;
          await create("product_options", {
            group_id: colourGroup.id,
            parent_option_id: sizeOption.id,
            key: slugify(label),
            name: label,
            price_delta_paise: 0,
            sort_order: colours.length + 1,
          });
        },
        "Colour added — set its swatch and images"
      )
    );
    box.appendChild(addColour);

    return box;
  }

  // ------------------------------------------------------------------
  // Products
  // ------------------------------------------------------------------

  function renderProduct(pkg, product) {
    const box = document.createElement("details");
    box.className = "admin-product";
    box.dataset.key = `prod:${product.id}`;

    const sizeGroup = product.product_option_groups.find((g) => g.key === "size");
    const colourGroup = product.product_option_groups.find((g) => g.key === "colour");
    const sizeCount = sizeGroup ? sizeGroup.product_options.length : 0;

    const summary = document.createElement("summary");
    summary.innerHTML = `<strong>${product.name}</strong> <span class="admin-subtle">${sizeCount} size(s)</span>`;
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

    // Spec sub-headings — the fixed rows shown on the product page (COMFORT,
    // CONTROL, TEMPERATURE, …). FINISH and MATERIAL are deliberately NOT here:
    // those come from each colour. These are the rows that don't vary by colour.
    const specsTitle = document.createElement("p");
    specsTitle.className = "admin-section-title";
    specsTitle.textContent = "Spec sub-headings";
    const specsWrap = document.createElement("div");
    specsWrap.className = "admin-specs";
    const specEntries = [];

    function addSpecRow(label = "", value = "") {
      const rowEl = document.createElement("div");
      rowEl.className = "admin-inline admin-spec-row";
      const labelField = field("Sub-heading", label, { placeholder: "COMFORT" });
      const valueField = field("Text below", value, { placeholder: "Medium-soft" });
      const entry = { labelField, valueField };
      const removeBtn = button("Remove", "admin-danger admin-small", () => {
        const i = specEntries.indexOf(entry);
        if (i >= 0) specEntries.splice(i, 1);
        rowEl.remove();
      });
      rowEl.append(labelField, valueField, removeBtn);
      specEntries.push(entry);
      specsWrap.appendChild(rowEl);
    }

    (Array.isArray(product.specs) ? product.specs : []).forEach((s) =>
      addSpecRow(s.label || "", s.value || "")
    );
    const addSpec = button("+ Add sub-heading", "admin-small", () => addSpecRow());
    box.append(specsTitle, specsWrap, addSpec);

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
            specs: specEntries
              .map((e) => ({
                label: e.labelField.input.value.trim(),
                value: e.valueField.input.value.trim(),
              }))
              .filter((s) => s.label || s.value),
          }),
        "Product saved"
      )
    );

    const delBtn = button("Delete product", "admin-danger", () => {});
    delBtn.addEventListener("click", async () => {
      if (guardMinimum(pkg.package_products.length, 1, "main product per package")) return;
      if (
        !(await confirmDelete(
          `the product "${product.name}"`,
          "Its option groups and all their options go too, and it's removed from any cart."
        ))
      )
        return;
      action(delBtn, () => remove("package_products", product.id), "Product deleted")();
    });

    const actions = document.createElement("div");
    actions.className = "admin-row-actions";
    actions.append(saveBtn, delBtn);
    box.appendChild(actions);

    const sizesTitle = document.createElement("p");
    sizesTitle.className = "admin-section-title";
    sizesTitle.textContent = "Sizes & colours";
    box.appendChild(sizesTitle);

    if (sizeGroup) {
      sizeGroup.product_options.forEach((sizeOption) =>
        box.appendChild(renderSize(product, sizeGroup, colourGroup, sizeOption))
      );

      const addSize = button("+ Add size", "admin-small", () => {});
      addSize.addEventListener(
        "click",
        action(
          addSize,
          async () => {
            const label = window.prompt("Size name (e.g. King, or 200 × 300 cm)");
            if (!label) return;
            await create("product_options", {
              group_id: sizeGroup.id,
              key: slugify(label),
              name: label,
              price_delta_paise: 0,
              sort_order: sizeGroup.product_options.length + 1,
            });
          },
          "Size added — now add its colours"
        )
      );
      box.appendChild(addSize);
    } else {
      const note = document.createElement("p");
      note.className = "admin-subtle";
      note.style.margin = "8px 22px";
      note.textContent =
        "This product has no Size group. Products created here get one automatically; older ones may need it added in SQL.";
      box.appendChild(note);
    }

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
      if (guardMinimum(pkg.package_addons.length, 1, "add-on per package")) return;
      if (
        !(await confirmDelete(
          `the add-on "${addon.name}"`,
          "It's removed from any cart that had it selected; past orders keep their record."
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

  // ------------------------------------------------------------------
  // Bulk-fill products from a CSV
  // ------------------------------------------------------------------
  // The file is parsed in the browser into a preview — NOTHING is written until
  // the admin reviews it and presses save, which then uses the same create()
  // calls as adding a product by hand. One row per colour, with the product and
  // size columns repeated down the rows.

  const CSV_HEADERS = [
    "product_name", "product_description", "product_hsn",
    "size_name", "size_price_delta_inr",
    "colour_name", "colour_price_delta_inr",
    "swatch_hex", "finish", "material",
    "image_1", "image_2", "image_3", "image_4",
  ];

  // A small CSV reader that understands quoted fields, so a value may contain a
  // comma. Returns an array of arrays.
  function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    text = text.replace(/\r\n?/g, "\n");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else quoted = false;
        } else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function csvToObjects(text) {
    const grid = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
    if (grid.length < 2) return [];
    const headers = grid[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, "_"));
    return grid.slice(1).map((cells) => {
      const obj = {};
      headers.forEach((h, i) => (obj[h] = cells[i] != null ? cells[i] : ""));
      return obj;
    });
  }

  function csvTemplateDataUri() {
    const example = [
      "Calm Corner Sofa", "A low, softly structured sofa", "9401",
      "Standard - 280 x 160 cm", "0",
      "Sand", "0", "#d0b28e", "Warm sand", "Textured linen",
      "https://your-storage-url/sand-1.jpg", "", "", "",
    ];
    const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = CSV_HEADERS.join(",") + "\n" + example.map(cell).join(",") + "\n";
    return "data:text/csv;charset=utf-8," + encodeURIComponent(csv);
  }

  // Group the flat rows into products -> sizes -> colours, collecting notes.
  function buildProductsFromCsv(rows) {
    const products = [];
    const byProduct = new Map();
    const warnings = [];

    rows.forEach((r, i) => {
      const line = i + 2; // +1 for the header row, +1 for 1-based counting
      const pName = (r.product_name || "").trim();
      const sName = (r.size_name || "").trim();
      const cName = (r.colour_name || r.color_name || "").trim();
      if (!pName && !sName && !cName) return;
      if (!pName || !sName || !cName) {
        warnings.push(`Row ${line}: needs a product, size and colour name — skipped.`);
        return;
      }

      let product = byProduct.get(pName);
      if (!product) {
        product = {
          name: pName,
          description: (r.product_description || "").trim(),
          hsn: (r.product_hsn || "").trim(),
          sizes: [],
          _sizes: new Map(),
        };
        byProduct.set(pName, product);
        products.push(product);
      }

      let size = product._sizes.get(sName);
      if (!size) {
        size = {
          name: sName,
          priceDelta: toPaise(r.size_price_delta_inr || 0),
          colours: [],
          _colours: new Set(),
        };
        product._sizes.set(sName, size);
        product.sizes.push(size);
      }

      if (size._colours.has(cName.toLowerCase())) {
        warnings.push(`Row ${line}: "${cName}" repeats under ${pName} / ${sName} — skipped.`);
        return;
      }
      size._colours.add(cName.toLowerCase());

      const hex = (r.swatch_hex || "").trim();
      if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) {
        warnings.push(`Row ${line}: "${hex}" is not a #RRGGBB colour — saved as-is, fix later.`);
      }

      size.colours.push({
        name: cName,
        hex,
        finish: (r.finish || "").trim(),
        material: (r.material || "").trim(),
        priceDelta: toPaise(r.colour_price_delta_inr || 0),
        images: [r.image_1, r.image_2, r.image_3, r.image_4]
          .map((x) => (x || "").trim())
          .filter(Boolean),
      });
    });

    return { products, warnings };
  }

  async function saveProductsToPackage(pkg, products) {
    let productSort = pkg.package_products ? pkg.package_products.length : 0;
    for (const product of products) {
      productSort++;
      const productId = await create("package_products", {
        package_id: pkg.id,
        key: slugify(product.name),
        name: product.name,
        description: product.description || null,
        hsn_code: product.hsn || null,
        sort_order: productSort,
      });
      const sizeGroupId = await create("product_option_groups", {
        product_id: productId, key: "size", name: "Size", display_as: "chip", sort_order: 1,
      });
      const colourGroupId = await create("product_option_groups", {
        product_id: productId, key: "colour", name: "Colour", display_as: "swatch", sort_order: 2,
      });

      let sizeSort = 0;
      for (const size of product.sizes) {
        sizeSort++;
        const sizeId = await create("product_options", {
          group_id: sizeGroupId,
          key: slugify(size.name),
          name: size.name,
          price_delta_paise: size.priceDelta,
          sort_order: sizeSort,
        });
        let colourSort = 0;
        for (const colour of size.colours) {
          colourSort++;
          await create("product_options", {
            group_id: colourGroupId,
            parent_option_id: sizeId,
            key: slugify(colour.name),
            name: colour.name,
            price_delta_paise: colour.priceDelta,
            swatch_hex: colour.hex || null,
            finish: colour.finish || null,
            material: colour.material || null,
            image_paths: colour.images,
            sort_order: colourSort,
          });
        }
      }
    }
  }

  function renderCsvReview(pkg, text, container) {
    container.textContent = "";
    let rows;
    try {
      rows = csvToObjects(text);
    } catch (error) {
      container.appendChild(el("p", "admin-csv-error", `Could not read the CSV: ${error.message}`));
      return;
    }

    const { products, warnings } = buildProductsFromCsv(rows);
    if (!products.length) {
      container.appendChild(
        el("p", "admin-csv-error", "No products found. Check the column headings match the template.")
      );
      return;
    }

    const colourCount = products.reduce(
      (n, p) => n + p.sizes.reduce((m, s) => m + s.colours.length, 0), 0
    );
    container.appendChild(
      el("p", "admin-section-title",
        `Review — ${products.length} product(s), ${colourCount} colour(s) into "${pkg.name}"`)
    );

    const tree = el("ul", "admin-csv-tree");
    products.forEach((p) => {
      const li = el("li");
      li.appendChild(el("strong", null, p.name + (p.hsn ? ` · HSN ${p.hsn}` : "")));
      const sizeUl = el("ul");
      p.sizes.forEach((s) => {
        sizeUl.appendChild(
          el("li", null,
            `${s.name}${s.priceDelta ? ` (+${SC.money(s.priceDelta)})` : ""} — ${s.colours.map((c) => c.name).join(", ")}`)
        );
      });
      li.appendChild(sizeUl);
      tree.appendChild(li);
    });
    container.appendChild(tree);

    if (warnings.length) {
      const w = el("div", "admin-csv-warnings");
      w.appendChild(el("p", null, "Notes:"));
      const ul = el("ul");
      warnings.forEach((x) => ul.appendChild(el("li", null, x)));
      w.appendChild(ul);
      container.appendChild(w);
    }

    const saveBtn = button(`Save ${products.length} product(s)`, "admin-primary-small", () => {});
    saveBtn.addEventListener(
      "click",
      action(saveBtn, () => saveProductsToPackage(pkg, products),
        `Added ${products.length} product(s) from the CSV`)
    );
    const cancelBtn = button("Cancel", "admin-small", () => { container.textContent = ""; });
    const actions = el("div", "admin-row-actions");
    actions.append(saveBtn, cancelBtn);
    container.appendChild(actions);
  }

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
      if (guardMinimum(packageCount, 2, "packages")) return;
      if (
        !(await confirmDelete(
          `the package "${pkg.name}"`,
          "Every product, option and add-on inside it goes too, along with any cart holding it. Past orders keep their record."
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

    // Bulk-fill the products above from a CSV (reviewed before anything saves).
    const csvInput = document.createElement("input");
    csvInput.type = "file";
    csvInput.accept = ".csv,text/csv";
    csvInput.style.display = "none";
    const csvReview = el("div", "admin-csv-review");
    csvInput.addEventListener("change", async () => {
      const file = csvInput.files[0];
      if (!file) return;
      const text = await file.text();
      csvInput.value = ""; // let the same file be picked again after a cancel
      renderCsvReview(pkg, text, csvReview);
    });
    const csvBtn = button("Fill products from CSV", "admin-small", () => csvInput.click());
    const csvTmpl = el("a", "admin-csv-template", "Download template");
    csvTmpl.href = csvTemplateDataUri();
    csvTmpl.download = "products-template.csv";
    const csvWrap = el("div", "admin-csv");
    csvWrap.append(csvBtn, csvTmpl, csvInput, csvReview);
    box.appendChild(csvWrap);

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

    packageCount = catalog.length;

    // Keep the previously chosen package selected if it still exists.
    if (!catalog.some((p) => p.id === selectedPackageId)) {
      selectedPackageId = catalog[0]?.id ?? null;
    }

    const packageEls = [];
    catalog.forEach((pkg) => {
      const el = renderPackage(pkg);
      el.dataset.key = `pkg:${pkg.id}`;
      el.dataset.pkgId = pkg.id;
      packagesWrap.appendChild(el);
      packageEls.push(el);
    });

    // Show one package's editor at a time, chosen from a dropdown, so the page
    // stays focused instead of listing every package expanded at once.
    function showSelected() {
      const solo = catalog.length > 1;
      packageEls.forEach((el) => {
        el.hidden = solo && el.dataset.pkgId !== selectedPackageId;
        if (!el.hidden) el.open = true;
      });
    }

    if (catalog.length > 1) {
      const picker = document.createElement("div");
      picker.className = "admin-picker";
      const pickerLabel = document.createElement("label");
      pickerLabel.textContent = "Editing package";
      const pickerSelect = document.createElement("select");
      catalog.forEach((pkg) => {
        const opt = document.createElement("option");
        opt.value = pkg.id;
        opt.textContent = pkg.name + (pkg.is_active ? "" : " (hidden)");
        if (pkg.id === selectedPackageId) opt.selected = true;
        pickerSelect.appendChild(opt);
      });
      pickerSelect.addEventListener("change", () => {
        selectedPackageId = pickerSelect.value;
        showSelected();
      });
      pickerLabel.appendChild(pickerSelect);
      picker.appendChild(pickerLabel);
      packagesWrap.insertBefore(picker, packagesWrap.firstChild);
    }

    showSelected();

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
