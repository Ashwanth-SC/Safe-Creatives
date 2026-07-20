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

    const cta = document.createElement("strong");
    cta.textContent = "Explore package ↗";

    copy.append(eyebrow, title, description, cta);
    card.append(number, copy);
    grid.appendChild(card);
  });
})();
