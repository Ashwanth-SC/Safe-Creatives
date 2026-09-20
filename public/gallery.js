// ============================================================================
// Safe Creatives — public turnkey gallery
// ============================================================================
//
// Loads PUBLISHED items from turnkey_gallery (world-readable via RLS, migration
// 050), renders a filterable card grid, and opens a photo modal per project.
// Public page — no auth; uses the anon client `sb`.
// ============================================================================

(function () {
  const BUCKET = "turnkey-gallery";
  const grid = document.getElementById("gallery-grid");
  const statusEl = document.getElementById("gallery-status");
  const filtersEl = document.getElementById("gallery-filters");

  const modal = document.getElementById("gallery-modal");
  const gmPhoto = document.getElementById("gm-photo");
  const gmThumbs = document.getElementById("gm-thumbs");
  const gmCat = document.getElementById("gm-cat");
  const gmTitle = document.getElementById("gm-title");
  const gmLoc = document.getElementById("gm-loc");
  const gmBlurb = document.getElementById("gm-blurb");

  const photoUrl = (path) => sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  let items = [];
  let activeFilter = "All";

  function photosOf(it) {
    const arr = Array.isArray(it.photos) ? it.photos.slice() : [];
    if (it.cover_photo && arr.includes(it.cover_photo)) { arr.splice(arr.indexOf(it.cover_photo), 1); arr.unshift(it.cover_photo); }
    return arr;
  }

  // ---- modal ---------------------------------------------------------------
  function openModal(it) {
    const photos = photosOf(it);
    gmCat.textContent = it.category || "";
    gmTitle.textContent = it.title || "";
    gmLoc.textContent = it.location || "";
    gmBlurb.textContent = it.blurb || "";
    gmThumbs.textContent = "";
    const show = (p) => { gmPhoto.src = photoUrl(p); [...gmThumbs.children].forEach((c) => c.classList.toggle("is-active", c.dataset.p === p)); };
    photos.forEach((p) => {
      const t = document.createElement("img");
      t.src = photoUrl(p); t.alt = ""; t.className = "gm-thumb"; t.dataset.p = p;
      t.addEventListener("click", () => show(p));
      gmThumbs.appendChild(t);
    });
    gmThumbs.hidden = photos.length < 2;
    if (photos.length) show(photos[0]); else gmPhoto.removeAttribute("src");
    modal.hidden = false;
    document.body.style.overflow = "hidden";
  }
  function closeModal() { modal.hidden = true; gmPhoto.removeAttribute("src"); document.body.style.overflow = ""; }
  modal.querySelector(".gallery-modal-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) closeModal(); });

  // ---- grid ----------------------------------------------------------------
  function card(it) {
    const c = el("button", "gallery-card");
    c.type = "button";
    const media = el("div", "gallery-card-media");
    if (it.cover_photo) { const img = document.createElement("img"); img.src = photoUrl(it.cover_photo); img.alt = it.title || "Project"; img.loading = "lazy"; media.appendChild(img); }
    else media.appendChild(el("span", "gallery-card-ph", "Safe Creatives"));
    const body = el("div", "gallery-card-body");
    if (it.category) body.appendChild(el("span", "gallery-card-cat", it.category));
    body.appendChild(el("h3", "gallery-card-title", it.title || "Untitled"));
    if (it.location) body.appendChild(el("span", "gallery-card-loc", it.location));
    c.append(media, body);
    c.addEventListener("click", () => openModal(it));
    return c;
  }

  function renderGrid() {
    grid.textContent = "";
    const shown = activeFilter === "All" ? items : items.filter((it) => (it.category || "") === activeFilter);
    if (!shown.length) { statusEl.hidden = false; statusEl.textContent = "No projects in this category yet."; return; }
    statusEl.hidden = true;
    shown.forEach((it) => grid.appendChild(card(it)));
  }

  function renderFilters() {
    const cats = [...new Set(items.map((it) => it.category).filter(Boolean))];
    if (!cats.length) { filtersEl.hidden = true; return; }
    const mk = (label) => {
      const b = el("button", "gallery-filter" + (label === activeFilter ? " is-active" : ""), label);
      b.type = "button";
      b.addEventListener("click", () => { activeFilter = label; [...filtersEl.children].forEach((c) => c.classList.toggle("is-active", c.textContent === label)); renderGrid(); });
      return b;
    };
    filtersEl.textContent = "";
    ["All", ...cats].forEach((l) => filtersEl.appendChild(mk(l)));
  }

  async function load() {
    try {
      const { data, error } = await sb
        .from("turnkey_gallery")
        .select("id, title, category, location, blurb, cover_photo, photos")
        .eq("published", true)
        .order("sort_order", { ascending: true, nullsFirst: false })
        .order("created_at", { ascending: false });
      if (error) throw error;
      items = data || [];
    } catch (e) {
      statusEl.textContent = "Could not load the gallery right now. Please try again later.";
      return;
    }
    if (!items.length) { statusEl.textContent = "Our project gallery is coming soon."; return; }
    renderFilters();
    renderGrid();
  }

  load();
})();
