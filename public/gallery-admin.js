// ============================================================================
// Safe Creatives — Gallery admin (curate the turnkey portfolio)
// ============================================================================
//
// Staff create standalone gallery items (title, category, location, blurb),
// upload final photos to the public 'turnkey-gallery' bucket, pick a cover, and
// publish. Published items appear on the public gallery page. Needs migration
// 050. Admin only.
// ============================================================================

(async function () {
  await SC.ready;

  const denied = document.querySelector("#denied");
  const bodyEl = document.querySelector("#ga-body");
  const panel = document.querySelector("#ga-panel");
  const messageEl = document.querySelector("#ga-message");
  const lightbox = document.querySelector("#ga-lightbox");

  if (!SC.isAdmin) { denied.hidden = false; return; }
  bodyEl.hidden = false;

  const BUCKET = "turnkey-gallery";
  const CATEGORIES = ["Residential", "Commercial"];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function field(labelText, control) {
    const wrap = el("label", "admin-field");
    wrap.appendChild(el("span", null, labelText));
    wrap.appendChild(control);
    return wrap;
  }
  function selectEl(options, value, blankLabel) {
    const s = document.createElement("select");
    if (blankLabel != null) s.appendChild(new Option(blankLabel, ""));
    options.forEach((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; s.appendChild(new Option(l, v)); });
    if (value != null) s.value = value;
    return s;
  }
  function message(text, isError) {
    messageEl.textContent = text || "";
    messageEl.className = `admin-message${isError ? " is-error" : text ? " is-ok" : ""}`;
  }
  const photoUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  const lbImg = lightbox.querySelector("img");
  lightbox.querySelector(".ctrk-lightbox-close").addEventListener("click", () => { lightbox.hidden = true; lbImg.src = ""; });
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) { lightbox.hidden = true; lbImg.src = ""; } });

  async function loadItems() {
    const { data, error } = await sb
      .from("turnkey_gallery")
      .select("id, title, category, location, blurb, cover_photo, photos, published, sort_order, created_at")
      .order("sort_order", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data || [];
  }

  async function render() {
    panel.textContent = "";
    panel.appendChild(el("p", "dash-note", "Loading…"));
    let items;
    try { items = await loadItems(); }
    catch (error) { panel.textContent = ""; panel.appendChild(el("p", "admin-message is-error", `Could not load: ${error.message}. If the table/bucket is missing, run migration 050.`)); return; }
    panel.textContent = "";
    panel.appendChild(galleryEditor(null, render));
    panel.appendChild(galleryList(items, render));
  }

  // The add / edit form for one gallery item.
  function galleryEditor(existing, onSaved) {
    const item = existing ? { ...existing, photos: Array.isArray(existing.photos) ? [...existing.photos] : [] } : { id: crypto.randomUUID(), photos: [], published: false };
    const block = el("details", "admin-package tk-add");
    block.open = !existing;
    block.appendChild(el("summary", null, existing ? `Edit — ${existing.title || "untitled"}` : "+ Add a project"));

    const titleI = document.createElement("input"); titleI.type = "text"; titleI.placeholder = "Project title (e.g. Whitefield 3BHK)"; titleI.value = item.title || "";
    const catS = selectEl(CATEGORIES, item.category || "", "Category…");
    const locI = document.createElement("input"); locI.type = "text"; locI.placeholder = "Location (e.g. Chennai)"; locI.value = item.location || "";
    const blurbI = document.createElement("textarea"); blurbI.rows = 3; blurbI.placeholder = "Short description shown on the project"; blurbI.className = "grid-input"; blurbI.value = item.blurb || "";
    const sortI = document.createElement("input"); sortI.type = "number"; sortI.placeholder = "0"; sortI.style.maxWidth = "90px"; if (item.sort_order != null) sortI.value = item.sort_order;
    const pubI = document.createElement("input"); pubI.type = "checkbox"; pubI.checked = !!item.published;
    const pubWrap = el("label", "admin-field ga-check"); pubWrap.appendChild(pubI); pubWrap.appendChild(el("span", null, "Published (visible on the public gallery)"));

    const grid = el("div", "admin-inline");
    grid.append(field("Title", titleI), field("Category", catS), field("Location", locI), field("Sort order", sortI));
    const grid2 = el("div", "admin-inline");
    grid2.append(field("Description", blurbI));

    // Photos with a chosen cover.
    const photosWrap = el("div", "tk-box-section");
    photosWrap.appendChild(el("div", "tk-box-section-head", "Photos"));
    photosWrap.appendChild(el("p", "dash-note", "Upload final photos. Click a photo to set it as the cover (shown in the gallery grid)."));
    const gallery = el("div", "ga-photo-grid");
    const fileInput = document.createElement("input"); fileInput.type = "file"; fileInput.accept = "image/*"; fileInput.multiple = true; fileInput.style.display = "none";
    const addBtn = el("button", "admin-primary-small", "+ Add photos"); addBtn.type = "button";
    addBtn.addEventListener("click", () => fileInput.click());
    photosWrap.append(gallery, addBtn, fileInput);

    const drawPhotos = () => {
      gallery.textContent = "";
      if (!item.cover_photo && item.photos.length) item.cover_photo = item.photos[0];
      item.photos.forEach((path) => {
        const cell = el("div", "ga-photo-item" + (path === item.cover_photo ? " is-cover" : ""));
        const img = document.createElement("img"); img.src = photoUrl(path); img.alt = ""; img.className = "ga-photo-thumb";
        img.title = "Set as cover";
        img.addEventListener("click", () => { item.cover_photo = path; drawPhotos(); });
        if (path === item.cover_photo) cell.appendChild(el("span", "ga-cover-tag", "Cover"));
        const del = el("button", "tk-photo-del", "✕"); del.type = "button"; del.title = "Remove";
        del.addEventListener("click", async () => {
          del.disabled = true;
          try { await sb.storage.from(BUCKET).remove([path]); } catch (_e) { /* best effort */ }
          item.photos = item.photos.filter((p) => p !== path);
          if (item.cover_photo === path) item.cover_photo = item.photos[0] || null;
          drawPhotos();
        });
        cell.append(img, del);
        gallery.appendChild(cell);
      });
    };
    drawPhotos();

    fileInput.addEventListener("change", async () => {
      const files = [...(fileInput.files || [])];
      if (!files.length) return;
      addBtn.disabled = true; addBtn.textContent = "Uploading…";
      for (const file of files) {
        const path = `${item.id}/${Date.now()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
        const { error } = await sb.storage.from(BUCKET).upload(path, file, { contentType: file.type || undefined, upsert: false });
        if (error) { message(`Upload failed: ${error.message}`, true); continue; }
        item.photos.push(path);
      }
      fileInput.value = "";
      addBtn.disabled = false; addBtn.textContent = "+ Add photos";
      drawPhotos();
    });

    const msg = el("p", "admin-hint", "");
    const saveBtn = el("button", "admin-primary", existing ? "Save changes" : "Save project");
    saveBtn.type = "button";
    saveBtn.addEventListener("click", async () => {
      if (!titleI.value.trim()) { msg.textContent = "Add a title first."; return; }
      saveBtn.disabled = true; msg.textContent = "Saving…";
      const record = {
        id: item.id,
        title: titleI.value.trim(),
        category: catS.value || null,
        location: locI.value.trim() || null,
        blurb: blurbI.value.trim() || null,
        photos: item.photos,
        cover_photo: item.cover_photo || item.photos[0] || null,
        published: pubI.checked,
        sort_order: sortI.value === "" ? null : parseInt(sortI.value, 10),
      };
      try {
        const { error } = await sb.from("turnkey_gallery").upsert(record);
        if (error) throw error;
        msg.textContent = "";
        message(existing ? "Project updated." : "Project added.");
        onSaved();
      } catch (e) {
        msg.textContent = `Save failed: ${e.message}`;
      } finally {
        saveBtn.disabled = false;
      }
    });

    const actions = el("div", "admin-row-actions"); actions.append(saveBtn, msg);
    block.append(grid, grid2, photosWrap, pubWrap, actions);
    return block;
  }

  function galleryList(items, onChanged) {
    const wrap = el("div");
    wrap.appendChild(el("p", "dash-note", "Saved projects. Open to edit, or delete."));
    if (!items.length) { wrap.appendChild(el("p", "dash-empty", "No projects yet.")); return wrap; }
    const scroll = el("div", "table-scroll");
    const t = el("table", "dash-table");
    const thead = el("thead"); const hr = el("tr");
    ["Cover", "Title", "Category", "Location", "Photos", "Published", ""].forEach((h) => hr.appendChild(el("th", null, h)));
    thead.appendChild(hr);
    const tb = el("tbody");
    items.forEach((it) => {
      const tr = el("tr");
      const coverTd = el("td");
      if (it.cover_photo) { const img = document.createElement("img"); img.src = photoUrl(it.cover_photo); img.className = "ga-photo-thumb"; coverTd.appendChild(img); } else coverTd.textContent = "—";
      tr.appendChild(coverTd);
      [it.title || "—", it.category || "—", it.location || "—", String((it.photos || []).length)].forEach((c) => { const td = el("td"); td.textContent = c; tr.appendChild(td); });
      const pubTd = el("td"); pubTd.appendChild(el("span", `ctrk-badge ${it.published ? "ctrk-badge-completed" : "ctrk-badge-not_started"}`, it.published ? "Published" : "Draft")); tr.appendChild(pubTd);

      const open = el("button", "tk-email-link", "Open"); open.type = "button";
      open.addEventListener("click", () => { panel.textContent = ""; panel.appendChild(galleryEditor(it, render)); panel.appendChild(galleryList(items, onChanged)); window.scrollTo({ top: 0, behavior: "smooth" }); });
      const del = el("button", "tk-delete-link", "Delete"); del.type = "button";
      del.addEventListener("click", async () => {
        if (!window.confirm(`Delete "${it.title || "untitled"}"? This cannot be undone.`)) return;
        try {
          if ((it.photos || []).length) { try { await sb.storage.from(BUCKET).remove(it.photos); } catch (_e) { /* best effort */ } }
          const { error } = await sb.from("turnkey_gallery").delete().eq("id", it.id);
          if (error) throw error;
          message("Project deleted.");
          onChanged();
        } catch (e) { message(`Could not delete: ${e.message}`, true); }
      });
      const actions = el("div", "tk-cell-actions"); actions.append(open, del);
      const actTd = el("td"); actTd.appendChild(actions); tr.appendChild(actTd);
      tb.appendChild(tr);
    });
    t.append(thead, tb); scroll.appendChild(t); wrap.appendChild(scroll);
    return wrap;
  }

  render();
})();
