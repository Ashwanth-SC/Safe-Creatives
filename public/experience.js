// ============================================================================
// Sensory Rooms — guided video tour / configurator
// ============================================================================
//
//   experience.html?pkg=radiance   (Living room — Aurem Radiance)
//   experience.html?pkg=revive     (Bedroom    — Aurem Revive)
//
// The package's walkthrough video plays forward to each category's keyframe
// (pauseAt) and stops; at each stop the visitor chooses a SIZE and a COLOUR,
// the product PNG (derived from pngPattern) shows centred in the frame, and the
// choices carry forward to a summary at the end.
//
// Data-driven from experience.json. Missing assets fall back to placeholders,
// so the flow works before the art is ready.
// ============================================================================

(function () {
  "use strict";

  const root = document.getElementById("exp");
  const loading = document.getElementById("exp-loading");
  if (!root) return;

  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  function begin() {
    fetch("experience.json")
      .then((r) => { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then((all) => {
        const packages = all.packages || {};
        const key = new URLSearchParams(location.search).get("pkg");
        const data = (key && packages[key]) || packages[Object.keys(packages)[0]];
        if (!data) throw new Error("No package data");
        build(data);
      })
      .catch((err) => { console.error("Experience load failed:", err); if (loading) loading.textContent = "Could not load the experience."; });
  }

  // Admin gate (preview): the tours are admin-only for now; everyone else keeps
  // the "coming soon" overlay. Fail closed if auth isn't available.
  if (window.SC && SC.ready) {
    SC.ready.then(function () {
      if (!SC.isAdmin) return;
      const gate = document.getElementById("sc-gate");
      if (gate) gate.remove();
      begin();
    });
  }

  function build(data) {
    const cats = data.categories || [];
    const playSpeed = Number(data.playSpeed) > 0 ? Number(data.playSpeed) : 2;
    const sel = cats.map(() => ({ size: 0, color: 0 })); // chosen size/colour index per category
    let step = -1;  // -1 intro, 0..n-1 categories, n outro
    let busy = false;

    // -------- DOM --------
    const tour = el("div", "tour");
    const poster = document.createElement("img");
    poster.className = "tour-poster"; poster.alt = ""; poster.src = data.poster || "";

    const video = document.createElement("video");
    video.className = "tour-video";
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
    let videoOk = !!data.video;
    if (data.video) video.src = data.video;
    video.addEventListener("error", () => { videoOk = false; video.style.display = "none"; });

    // --- product placement -------------------------------------------------
    // A product can be pinned to the room instead of floating in the centre.
    // Its category's `hero` gives frame-relative coords (fractions of the paused
    // video frame), in one of two modes, with `baseY` = the floor line it stands on:
    //   • width span  { x0, x1, baseY } — left/right edges (e.g. door frame -> wall);
    //                   height follows the image's aspect.
    //   • height      { cx, baseY, h }  — centred at cx, product height h; width
    //                   follows the image's aspect.
    // We map these through the video's object-fit:cover transform so the product
    // tracks the room on any screen, keeping the image's real proportions.
    let placed = null; // { fig, hero } currently pinned, or null (centred)
    function videoAspect() {
      return (video.videoWidth > 0 && video.videoHeight > 0)
        ? video.videoWidth / video.videoHeight : 16 / 9;
    }
    function placeHero() {
      if (!placed || !placed.fig.isConnected) return;
      const vw = window.innerWidth, vh = window.innerHeight, a = videoAspect();
      const dw = Math.max(vw, vh * a), dh = dw / a;   // displayed video size (cover)
      const offX = (vw - dw) / 2, offY = (vh - dh) / 2; // crop offsets (<= 0)
      const h = placed.hero;
      const img = placed.fig.querySelector("img");
      const asp = (img && img.naturalWidth > 0) ? img.naturalWidth / img.naturalHeight : (h.aspect || 1);
      let wpx, hpx, leftpx;
      if (h.x0 != null && h.x1 != null) {        // width span (door frame -> wall)
        wpx = (h.x1 - h.x0) * dw; hpx = wpx / asp; leftpx = offX + h.x0 * dw;
        placed.fig.style.transform = "none";
      } else {                                    // height-based, centred on cx
        hpx = h.h * dh; wpx = hpx * asp; leftpx = offX + (h.cx != null ? h.cx : 0.5) * dw;
        placed.fig.style.transform = "translateX(-50%)";
      }
      placed.fig.style.width = wpx + "px";
      placed.fig.style.height = hpx + "px";
      placed.fig.style.left = leftpx + "px";
      placed.fig.style.top = (offY + h.baseY * dh - hpx) + "px";
    }
    window.addEventListener("resize", placeHero);
    video.addEventListener("loadedmetadata", placeHero);

    const scrim = el("div", "tour-scrim");
    const catWrap = el("div");

    const introP = el("div", "tour-panel");
    introP.innerHTML =
      `<div class="tour-panel-inner">` +
        `<p class="eyebrow">${esc((data.intro || {}).eyebrow || data.name || "SENSORY ROOMS")}</p>` +
        `<h1>${esc((data.intro || {}).title || data.name || "Step inside")}</h1>` +
        `<p>${esc((data.intro || {}).text || "")}</p>` +
        `<button type="button" class="btn btn-primary" id="tour-start">${esc((data.intro || {}).button || "Start")}</button>` +
      `</div>`;

    const outroP = el("div", "tour-panel");

    const nav = el("div", "tour-nav");
    nav.style.display = "none";
    const backBtn = el("button", "btn btn-ghost"); backBtn.type = "button"; backBtn.textContent = "← Back";
    const dots = el("div", "tour-dots");
    cats.forEach(() => dots.appendChild(document.createElement("i")));
    const nextBtn = el("button", "btn btn-primary"); nextBtn.type = "button"; nextBtn.textContent = "Next →";
    nav.append(backBtn, dots, nextBtn);

    tour.append(poster, video, scrim, catWrap, nav, introP, outroP);
    root.appendChild(tour);

    introP.querySelector("#tour-start").addEventListener("click", () => goCategory(0));
    nextBtn.addEventListener("click", () => { if (step < cats.length - 1) goCategory(step + 1); else goOutro(); });
    backBtn.addEventListener("click", () => { if (step <= 0) goIntro(); else goCategory(step - 1); });

    introP.classList.add("is-on");
    // Hold the loader until the video + the first composite of every stop are
    // decoded, so the first fade-in never shows a half-loaded image.
    preloadAssets().then(() => { if (loading) loading.classList.add("is-hidden"); });

    // -------- helpers --------
    // Warm the browser cache for the video's first frame and each category's
    // first-option image, with a timeout so we never hang on a missing asset.
    function preloadAssets() {
      const imgs = cats
        .map((c) => productPng(c, { size: 0, color: 0 }))
        .filter(Boolean)
        .map((u) => new Promise((res) => { const im = new Image(); im.onload = im.onerror = () => res(); im.src = u; }));
      const vid = new Promise((res) => {
        if (!videoOk || video.readyState >= 2) { res(); return; }
        const done = () => { video.removeEventListener("loadeddata", done); video.removeEventListener("canplay", done); res(); };
        video.addEventListener("loadeddata", done);
        video.addEventListener("canplay", done);
      });
      return Promise.race([
        Promise.all([...imgs, vid]),
        new Promise((res) => setTimeout(res, 8000)),
      ]);
    }

    function productPng(cat, s) {
      if (!cat.pngPattern) return "";
      const size = (cat.sizes[s.size] || {}).id || "";
      const color = (cat.colors[s.color] || {}).id || "";
      return cat.pngPattern.replace(/\{size\}/g, size).replace(/\{color\}/g, color);
    }
    function variantLabel(cat, s) {
      const size = (cat.sizes[s.size] || {}).name || "";
      const color = (cat.colors[s.color] || {}).name || "";
      return [size, color].filter(Boolean).join(" · ");
    }

    // -------- state --------
    function goIntro() {
      step = -1; busy = false;
      nav.style.display = "none";
      outroP.classList.remove("is-on");
      catWrap.textContent = "";
      introP.classList.add("is-on");
      try { video.pause(); video.currentTime = 0; } catch (e) { /* not ready */ }
    }

    // Fade the current category (image + cards) out before we move the camera,
    // so every transition — forward or back — is a clean fade, not a cut.
    const FADE_MS = 420;
    function fadeOutCurrent() {
      const cur = catWrap.firstElementChild;
      if (!cur) return Promise.resolve();
      cur.classList.remove("is-shown");
      return new Promise((res) => setTimeout(res, FADE_MS));
    }

    async function goCategory(i) {
      if (busy || i < 0 || i >= cats.length) return;
      busy = true;
      const forward = i > step;
      introP.classList.remove("is-on");
      outroP.classList.remove("is-on");
      await fadeOutCurrent();
      catWrap.textContent = "";
      step = i;
      setDots();
      backBtn.textContent = i === 0 ? "← Intro" : "← Back";
      nextBtn.textContent = i === cats.length - 1 ? "See your room →" : "Next →";
      nav.style.display = "";
      await playTo(cats[i].pauseAt != null ? cats[i].pauseAt : 0, forward);
      renderCat(i);
      busy = false;
    }

    async function goOutro() {
      step = cats.length; busy = false;
      nav.style.display = "none";
      await fadeOutCurrent();
      catWrap.textContent = "";
      outroP.innerHTML = outroHtml();
      outroP.classList.add("is-on");
      const r = outroP.querySelector("#tour-restart");
      if (r) r.addEventListener("click", goIntro);
      outroP.querySelectorAll(".tour-sum img").forEach((img) => (img.onerror = () => img.replaceWith(phSpan())));
      try { video.pause(); } catch (e) { /* ignore */ }
    }

    function setDots() {
      [...dots.children].forEach((d, i) => {
        d.classList.toggle("is-on", i === step);
        d.classList.toggle("is-done", i < step);
      });
    }

    function playTo(target, forward) {
      return new Promise((resolve) => {
        const v = video;
        if (!videoOk) { resolve(); return; }
        const run = () => {
          if (isNaN(v.duration)) { resolve(); return; }
          const t = Math.min(target, v.duration || target);
          if (!forward || t <= v.currentTime + 0.1) {
            try { v.pause(); if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t; } catch (e) { /* ignore */ }
            resolve();
            return;
          }
          try { v.playbackRate = playSpeed; } catch (e) { /* ignore */ }
          let raf;
          const tick = () => {
            if (v.currentTime >= t - 0.05) {
              try { v.pause(); v.playbackRate = 1; } catch (e) { /* ignore */ }
              cancelAnimationFrame(raf);
              resolve();
              return;
            }
            raf = requestAnimationFrame(tick);
          };
          const pr = v.play();
          if (pr && pr.then) pr.then(() => { raf = requestAnimationFrame(tick); }).catch(() => { try { v.currentTime = t; } catch (e) {} resolve(); });
          else raf = requestAnimationFrame(tick);
        };
        if (v.readyState >= 1 && !isNaN(v.duration)) { run(); return; }
        let done = false;
        const onReady = () => { if (done) return; done = true; v.removeEventListener("loadedmetadata", onReady); v.removeEventListener("canplay", onReady); run(); };
        v.addEventListener("loadedmetadata", onReady);
        v.addEventListener("canplay", onReady);
        setTimeout(onReady, 4000);
      });
    }

    // -------- category view --------
    function renderCat(i) {
      const cat = cats[i];
      const s = sel[i];
      const png = productPng(cat, s);
      const hero = cat.hero || {};
      // "cover": the product image is a full-frame render matching the video
      // frame; overlay it edge-to-edge (object-fit:cover) and fade it in.
      const coverMode = hero.cover === true;
      const view = el("div", "tour-cat is-on");
      view.innerHTML =
        `<div class="tour-hero${coverMode ? " is-cover" : ""}"><figure>${png ? `<img src="${esc(png)}" alt="${esc(cat.name || "")}">` : heroPh(cat.name)}</figure></div>` +
        // LEFT card: unit name + size / colour selectors
        `<div class="tour-info">` +
          `<p class="eyebrow">YOUR CHOICE</p>` +
          `<h3>${esc(cat.name || "")}</h3>` +
          `<div class="choose-group"><span class="choose-label">Size</span><div class="choose-pills">` +
            cat.sizes.map((sz, si) => `<button type="button" class="choose-pill${si === s.size ? " is-on" : ""}" data-size="${si}">${esc(sz.name)}</button>`).join("") +
          `</div></div>` +
          `<div class="choose-group"><span class="choose-label">Colour — <em id="color-name">${esc((cat.colors[s.color] || {}).name || "")}</em></span><div class="choose-swatches">` +
            cat.colors.map((c, ci) => `<button type="button" class="choose-swatch${ci === s.color ? " is-on" : ""}" data-color="${ci}" title="${esc(c.name)}" style="--sw:${esc(c.swatch || "#999")}"><span></span></button>`).join("") +
          `</div></div>` +
        `</div>` +
        // RIGHT card: features
        `<div class="tour-feats-card">` +
          `<p class="eyebrow">FEATURES</p>` +
          ((cat.features && cat.features.length)
            ? `<ul class="tour-feats">${cat.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>`
            : `<p class="feats-empty">Details coming soon.</p>`) +
        `</div>`;

      catWrap.textContent = "";
      catWrap.appendChild(view);
      // Fade this category in (image + cards). rAF so the transition runs.
      requestAnimationFrame(() => requestAnimationFrame(() => view.classList.add("is-shown")));

      // Per-category placement. cover → full-frame (handled by class, no pinning).
      // Else frame coords pin the product into the room — width span (x0/x1/baseY)
      // or height (cx/baseY/h). Fallback: scale/bottom, else centred default.
      const heroWrap = view.querySelector(".tour-hero");
      const heroFig = view.querySelector(".tour-hero figure");
      const framePinned = !coverMode && hero.baseY != null &&
        ((hero.x0 != null && hero.x1 != null) || hero.h > 0);
      placed = null;
      if (heroWrap && coverMode) {
        // full-frame overlay; nothing to position
      } else if (heroWrap && framePinned) {
        heroWrap.classList.add("is-placed");
        placed = { fig: heroFig, hero };
        const pimg = heroFig.querySelector("img");
        if (pimg) pimg.addEventListener("load", placeHero);
        placeHero();
      } else if (heroWrap) {
        if (hero.scale > 0) heroWrap.style.setProperty("--hero-h", (hero.scale * 100) + "vh");
        if (hero.bottom != null) {
          heroWrap.style.setProperty("--hero-bottom", hero.bottom + "%");
          heroWrap.classList.add("is-grounded");
        }
      }
      const heroImg = view.querySelector(".tour-hero img");
      if (heroImg) heroImg.onerror = () => { heroImg.outerHTML = heroPh(cat.name); };

      // Update the hero + labels in place when size/colour changes.
      const refresh = () => {
        const url = productPng(cat, s);
        heroFig.innerHTML = url ? `<img src="${esc(url)}" alt="${esc(cat.name || "")}">` : heroPh(cat.name);
        const im = heroFig.querySelector("img");
        if (im) { im.onerror = () => { im.outerHTML = heroPh(cat.name); }; if (placed) im.addEventListener("load", placeHero); }
        if (placed) placeHero();
        const cn = view.querySelector("#color-name"); if (cn) cn.textContent = (cat.colors[s.color] || {}).name || "";
      };

      view.querySelectorAll(".choose-pill").forEach((b) => b.addEventListener("click", () => {
        const si = Number(b.dataset.size);
        if (si === s.size) return;
        s.size = si;
        view.querySelectorAll(".choose-pill").forEach((x) => x.classList.toggle("is-on", Number(x.dataset.size) === si));
        refresh();
      }));
      view.querySelectorAll(".choose-swatch").forEach((b) => b.addEventListener("click", () => {
        const ci = Number(b.dataset.color);
        if (ci === s.color) return;
        s.color = ci;
        view.querySelectorAll(".choose-swatch").forEach((x) => x.classList.toggle("is-on", Number(x.dataset.color) === ci));
        refresh();
      }));
    }

    function outroHtml() {
      const o = data.outro || {};
      const sum = cats.map((c, i) => {
        const png = productPng(c, sel[i]);
        return `<div class="tour-sum"><span class="t">${png ? `<img src="${esc(png)}" alt="">` : `<span>PNG</span>`}</span><div><small>${esc(c.name)}</small><b>${esc(variantLabel(c, sel[i]))}</b></div></div>`;
      }).join("");
      return (
        `<div class="tour-panel-inner">` +
          `<p class="eyebrow">${esc(o.eyebrow || "YOUR ROOM")}</p>` +
          `<h1>${esc(o.title || "Here's your room.")}</h1>` +
          `<div class="tour-summary">${sum}</div>` +
          (o.text ? `<p>${esc(o.text)}</p>` : "") +
          `<div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">` +
            `<button type="button" class="btn btn-ghost" id="tour-restart">↺ Start over</button>` +
            (o.href ? `<a class="btn btn-primary" href="${esc(o.href)}">${esc(o.button || "Continue")}</a>` : "") +
          `</div>` +
        `</div>`
      );
    }

    function heroPh(name) { return `<div class="tour-hero-ph"><b>${esc(name || "Product")}</b><small>PNG goes here</small></div>`; }
    function phSpan() { const s2 = document.createElement("span"); s2.textContent = "PNG"; return s2; }
  }
})();
