// ============================================================================
// Safe Creatives — package index
// ============================================================================
//
// Renders the package cards from the catalog. Previously the two cards were
// hardcoded in markup with their photos set in packages.css as .living-card
// and .bedroom-card, so a package created in admin appeared nowhere and a
// third one needed a stylesheet edit.
//
// Only is_active packages are returned -- RLS filters them out, so a hidden
// package is invisible here without this page knowing anything about it.
// ============================================================================

(async function () {
  await SC.ready;

  const grid = document.querySelector(".package-catalog");

  const { data: packages, error } = await sb
    .from("packages")
    .select("key, name, description, cover_image_path, sort_order")
    .order("sort_order");

  if (error) {
    grid.innerHTML = `<p class="catalog-empty">The packages could not be loaded: ${error.message}</p>`;
    return;
  }

  if (!packages.length) {
    grid.innerHTML = `<p class="catalog-empty">No packages are available just now. Please check back shortly.</p>`;
    return;
  }

  grid.textContent = "";

  packages.forEach((pkg, index) => {
    const card = document.createElement("a");
    card.className = "package-card";
    card.href = `${pkg.key}-package.html`;

    if (pkg.cover_image_path) {
      card.style.backgroundImage = `url("${pkg.cover_image_path}")`;
    }

    const number = document.createElement("span");
    number.textContent = String(index + 1).padStart(2, "0");

    const copy = document.createElement("div");

    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "SENSORY ROOM PACKAGE";

    const title = document.createElement("h2");
    title.textContent = pkg.name;

    const description = document.createElement("p");
    description.textContent = pkg.description || "";

    // A quick, scannable line of what matters on a listing — no price yet
    // (starting prices are being finalised and are set on the package page).
    const meta = document.createElement("p");
    meta.className = "package-meta";
    meta.textContent = "Fully customisable · Installed in ~20 days · 5-year warranty";

    const cta = document.createElement("strong");
    cta.textContent = "Explore package ↗︎";

    copy.append(eyebrow, title, description, meta, cta);
    card.append(number, copy);
    grid.appendChild(card);
  });
})();

// ---------------------------------------------------------------------------
// Sense posters — click any poster to open it full-size in a lightbox. The
// posters are static markup; this only wires the open/close behaviour. A poster
// whose image hasn't loaded yet (file not added) simply does nothing on click.
// ---------------------------------------------------------------------------
(function () {
  const lightbox = document.getElementById("sense-lightbox");
  if (!lightbox) return;
  const lightboxImg = lightbox.querySelector("img");

  function close() {
    lightbox.hidden = true;
    lightboxImg.removeAttribute("src");
    document.body.style.overflow = "";
  }

  document.querySelectorAll(".sense-poster").forEach((poster) => {
    poster.addEventListener("click", () => {
      const img = poster.querySelector("img");
      if (!img) return; // image not added yet — nothing to enlarge
      lightboxImg.src = poster.dataset.full || img.currentSrc || img.src;
      lightboxImg.alt = img.alt || "";
      lightbox.hidden = false;
      document.body.style.overflow = "hidden";
    });
  });

  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox || event.target.closest(".sense-lightbox-close")) {
      close();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !lightbox.hidden) close();
  });
})();
