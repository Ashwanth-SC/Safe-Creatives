// ============================================================================
// Sensory Rooms — scroll-driven product experience
// ============================================================================
//
// Reads experience.json and plays a single scene as the visitor scrolls:
//
//   1. the empty room shell, full view
//   2. scroll "moves onto" the TV / media wall (the scene zooms to room.focus)
//   3. it holds there while the product PNGs reveal in their exact positions
//   4. tapping a product opens a feature-video preview
//
// Everything is data-driven: edit experience.json and drop real assets at the
// paths it references (room render, product PNGs, feature videos). Missing
// assets fall back to a labelled placeholder, so the flow works before the art
// is ready.
// ============================================================================

(function () {
  "use strict";

  const root = document.getElementById("exp");
  const loading = document.getElementById("exp-loading");
  if (!root) return;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  fetch("experience.json")
    .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
    .then(build)
    .catch((err) => {
      console.error("Experience load failed:", err);
      if (loading) loading.textContent = "Could not load the experience.";
    });

  function build(data) {
    const room = data.room || {};
    const focus = room.focus || { x: 50, y: 50, scale: 1.8 };
    const products = data.products || [];

    // ---------------- DOM ----------------
    const runway = el("section", "exp-runway");
    runway.style.height = "360vh"; // scroll distance for the whole journey

    const sticky = el("div", "exp-sticky");
    const stage = el("div", "exp-stage");
    const scene = el("div", "exp-scene");
    scene.style.setProperty("--aspect", String(room.aspect || 1.6));
    scene.style.transformOrigin = `${focus.x}% ${focus.y}%`;

    const bg = document.createElement("img");
    bg.className = "exp-bg";
    bg.alt = "";
    bg.src = room.shell || "";
    bg.onerror = () => bg.replaceWith(bgPlaceholder());

    const layer = el("div", "exp-layer");
    products.forEach((p, i) => layer.appendChild(hotspot(p, i)));

    scene.append(bg, layer, el("div", "exp-vignette"));
    stage.appendChild(scene);

    const introCap = el("div", "exp-caption");
    introCap.innerHTML =
      `<p class="eyebrow">SENSORY ROOMS</p>` +
      `<h1>${esc(data.title || "Step inside your room")}</h1>` +
      `<p>${esc(data.intro || "")}</p>`;

    const focusCap = el("div", "exp-caption");
    focusCap.style.opacity = "0";
    focusCap.innerHTML =
      `<p class="eyebrow">EXPLORE</p>` +
      `<p>${esc(data.focusCaption || "Tap any piece to see its features.")}</p>`;

    const hint = el("div", "exp-scrollhint");
    hint.innerHTML = `Scroll to walk in<span></span>`;

    sticky.append(stage, introCap, focusCap, hint);
    runway.appendChild(sticky);

    const prog = el("div", "exp-progress");
    const progBar = el("i");
    prog.appendChild(progBar);

    const cta = el("section", "exp-cta");
    const c = data.cta || {};
    cta.innerHTML =
      `<p class="eyebrow">READY WHEN YOU ARE</p>` +
      `<h2>${esc(c.heading || "Make this room yours.")}</h2>` +
      `<p>${esc(c.text || "")}</p>` +
      (c.href ? `<a href="${esc(c.href)}">${esc(c.label || "Continue")}</a>` : "");

    const modal = buildModal(products, data.cta);

    root.append(prog, runway, cta, modal.el);

    // ---------------- scroll engine ----------------
    let ticking = false;
    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        const rect = runway.getBoundingClientRect();
        const total = rect.height - window.innerHeight;
        const p = clamp(-rect.top / (total || 1), 0, 1);

        // 1-2: zoom onto the media wall over the first ~42% of the runway
        const zoom = easeInOut(clamp(p / 0.42, 0, 1));
        scene.style.transform = `scale(${lerp(1, focus.scale, zoom)})`;

        // 3: reveal the products once we've arrived
        layer.classList.toggle("is-revealed", p >= 0.46);

        introCap.style.opacity = String(clamp(1 - p / 0.14, 0, 1));
        focusCap.style.opacity = String(clamp((p - 0.5) / 0.08, 0, 1));
        hint.style.opacity = String(clamp(1 - p / 0.05, 0, 1));
        progBar.style.width = (p * 100).toFixed(1) + "%";
      });
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    onScroll();
    requestAnimationFrame(() => { if (loading) loading.classList.add("is-hidden"); });

    // ---------------- builders ----------------
    function hotspot(p, i) {
      const pos = p.position || {};
      const btn = el("button", "exp-hot");
      btn.type = "button";
      btn.style.left = (pos.left != null ? pos.left : 0) + "%";
      btn.style.top = (pos.top != null ? pos.top : 0) + "%";
      btn.style.width = (pos.width != null ? pos.width : 10) + "%";
      if (pos.height != null) btn.style.height = pos.height + "%";
      btn.style.zIndex = String(p.z != null ? p.z : i + 1);
      btn.style.setProperty("--i", String(i));
      btn.setAttribute("aria-label", p.name || "Product");

      const img = document.createElement("img");
      img.alt = p.name || "";
      img.src = p.png || "";
      img.onerror = () => img.replaceWith(phBox(p.name));
      btn.appendChild(img);
      btn.appendChild(el("span", "exp-dot"));

      btn.addEventListener("click", () => { btn.classList.add("is-seen"); modal.open(i); });
      return btn;
    }
  }

  function buildModal(products, cta) {
    const wrap = el("div", "exp-modal");
    const card = el("div", "exp-card");
    card.innerHTML =
      `<div class="exp-media"><button class="exp-close" aria-label="Close">×</button><div class="exp-media-slot"></div></div>` +
      `<div class="exp-card-body">` +
        `<p class="eyebrow">FEATURE PREVIEW</p>` +
        `<h2 class="exp-name"></h2>` +
        `<p class="blurb exp-blurb"></p>` +
        `<ul class="exp-feats"></ul>` +
        `<div class="exp-card-nav">` +
          `<div class="nav-btns"><button class="exp-btn exp-prev" type="button">← Previous</button><button class="exp-btn exp-next" type="button">Next →</button></div>` +
          (cta && cta.href ? `<a class="exp-btn primary" href="${esc(cta.href)}">${esc(cta.label || "Reserve")}</a>` : "") +
        `</div>` +
      `</div>`;
    wrap.appendChild(card);

    const slot = card.querySelector(".exp-media-slot");
    const nameEl = card.querySelector(".exp-name");
    const blurbEl = card.querySelector(".exp-blurb");
    const featsEl = card.querySelector(".exp-feats");
    let idx = 0;

    function mediaPh() {
      const d = el("div", "exp-media-ph");
      d.innerHTML = `<div class="play"></div><small>FEATURE VIDEO GOES HERE</small>`;
      return d;
    }
    function render(i) {
      idx = (i + products.length) % products.length;
      const p = products[idx];
      nameEl.textContent = p.name || "";
      blurbEl.textContent = p.blurb || "";
      featsEl.innerHTML = (p.features || []).map((f) => `<li>${esc(f)}</li>`).join("");
      slot.innerHTML = "";
      if (p.video) {
        const v = document.createElement("video");
        v.src = p.video;
        v.autoplay = true; v.muted = true; v.loop = true; v.playsInline = true; v.controls = true;
        v.onerror = () => { slot.innerHTML = ""; slot.appendChild(mediaPh()); };
        slot.appendChild(v);
      } else {
        slot.appendChild(mediaPh());
      }
    }
    function open(i) { render(i); wrap.classList.add("is-open"); document.body.style.overflow = "hidden"; }
    function close() {
      wrap.classList.remove("is-open");
      document.body.style.overflow = "";
      const v = slot.querySelector("video");
      if (v) v.pause();
    }

    card.querySelector(".exp-close").addEventListener("click", close);
    card.querySelector(".exp-prev").addEventListener("click", () => render(idx - 1));
    card.querySelector(".exp-next").addEventListener("click", () => render(idx + 1));
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && wrap.classList.contains("is-open")) close(); });

    return { el: wrap, open };
  }

  // ---------------- small helpers ----------------
  function el(tag, className) {
    const n = document.createElement(tag);
    if (className) n.className = className;
    return n;
  }
  function phBox(name) {
    const d = el("div", "exp-hot-ph");
    d.innerHTML = `<b>${esc(name || "Product")}</b><small>PNG goes here</small>`;
    return d;
  }
  function bgPlaceholder() {
    const d = el("div", "exp-bg");
    d.style.cssText = "display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#efe7da,#d9ccb6);color:#b7aa90;font:600 18px 'DM Mono',monospace;letter-spacing:.1em";
    d.textContent = "ROOM RENDER GOES HERE";
    return d;
  }
})();
