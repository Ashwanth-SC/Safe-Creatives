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

    // Feature hotspots sit on the full-frame image (16:9, object-fit:cover), so
    // they map through the same cover transform and track the image on resize.
    let curSpots = []; // [{ el, x, y }] hover circles for the current stop
    let curGlows = []; // [{ el, x, y, w, h }] light-glow overlays for the current stop
    let curSprays = []; // [{ el, x, y }] fragrance-spray points for the current stop
    function placeHotspots() {
      if (!curSpots.length && !curGlows.length && !curSprays.length) return;
      const vw = window.innerWidth, vh = window.innerHeight, a = 16 / 9;
      const dw = Math.max(vw, vh * a), dh = dw / a, offX = (vw - dw) / 2, offY = (vh - dh) / 2;
      const atPoint = (p) => { if (!p.el.isConnected) return; p.el.style.left = (offX + p.x * dw) + "px"; p.el.style.top = (offY + p.y * dh) + "px"; };
      curSpots.forEach(atPoint);
      curSprays.forEach(atPoint);
      for (const g of curGlows) {
        if (!g.el.isConnected) continue;
        g.el.style.left = (offX + g.x * dw) + "px";
        g.el.style.top = (offY + g.y * dh) + "px";
        g.el.style.width = (g.w * dw) + "px";
        g.el.style.height = (g.h * dh) + "px";
      }
    }
    window.addEventListener("resize", placeHotspots);

    const scrim = el("div", "tour-scrim");
    const catWrap = el("div");

    const introP = el("div", "tour-panel");
    introP.innerHTML =
      `<div class="tour-panel-inner">` +
        `<p class="eyebrow">${esc((data.intro || {}).eyebrow || data.name || "SENSORY ROOMS")}</p>` +
        `<h1>${esc((data.intro || {}).title || data.name || "Step inside")}</h1>` +
        `<p>${esc((data.intro || {}).text || "")}</p>` +
        (data.smart ? `<div class="tour-intro-modes"><p class="eyebrow">TWO MODES, ONE VOICE</p><div class="tour-intro-modes-body"></div></div>` : "") +
        `<button type="button" class="btn btn-primary" id="tour-start">${esc((data.intro || {}).button || "Start")}</button>` +
      `</div>`;
    if (data.smart && window.SCSmart) {
      SCSmart.renderModes(introP.querySelector(".tour-intro-modes-body"), { compact: true, set: data.smartSet });
    }
    // Begin-the-walk backdrop: the package's cover render, behind a dark scrim,
    // with the intro text on a frosted card so it stays readable over a bright image.
    if (data.cover) { introP.classList.add("has-cover"); introP.style.setProperty("--cover", `url("${data.cover}")`); }

    const outroP = el("div", "tour-panel");

    // Curtain: a title card (package name + a warm line) that fades in over the
    // video's first frame when the walk begins, then lifts as the camera moves.
    const curtainP = el("div", "tour-curtain");
    const cur = data.curtain || {};
    curtainP.innerHTML =
      `<div class="tour-curtain-inner">` +
        (cur.eyebrow ? `<p class="eyebrow">${esc(cur.eyebrow)}</p>` : "") +
        `<h1>${esc((data.intro || {}).title || data.name || "")}</h1>` +
        (cur.text ? `<p>${esc(cur.text)}</p>` : "") +
      `</div>`;

    const nav = el("div", "tour-nav");
    nav.style.display = "none";
    const backBtn = el("button", "btn btn-ghost"); backBtn.type = "button"; backBtn.textContent = "← Back";
    const dots = el("div", "tour-dots");
    cats.forEach(() => dots.appendChild(document.createElement("i")));
    const nextBtn = el("button", "btn btn-primary"); nextBtn.type = "button"; nextBtn.textContent = "Next →";
    nav.append(backBtn, dots, nextBtn);

    tour.append(poster, video, scrim, catWrap, nav, introP, outroP, curtainP);
    root.appendChild(tour);

    // Begin the walk: fade the cover intro out, settle on the video's first
    // frame, fade in the name + warm line, then start the camera toward the
    // first product as the title lifts away.
    function beginWalk() {
      if (busy) return;
      introP.classList.remove("is-on");
      try { video.pause(); if (videoOk) video.currentTime = 0; } catch (e) { /* not ready */ }
      setTimeout(() => {
        curtainP.classList.add("is-on");
        setTimeout(() => {
          curtainP.classList.remove("is-on");
          goCategory(0);
        }, 2800);
      }, 540);
    }
    introP.querySelector("#tour-start").addEventListener("click", beginWalk);
    nextBtn.addEventListener("click", () => { if (step < cats.length - 1) goCategory(step + 1); else goOutro(); });
    backBtn.addEventListener("click", () => { if (step <= 0) goIntro(); else goCategory(step - 1); });

    introP.classList.add("is-on");
    // Strong preloader: hold the loader until the video AND every variant image
    // (all size x colour combos) are decoded, so nothing ever buffers — walking
    // and switching options/colours is seamless. Shows progress.
    preloadAssets().then(() => { if (loading) loading.classList.add("is-hidden"); });

    // -------- helpers --------
    // Decoded-image cache: every product variant + reveal is preloaded AND
    // decoded, and the Image objects are kept here so switching size/colour is
    // instant (no re-fetch, no decode stall) — the hero then cross-fades.
    const imgCache = new Map();
    function allImageUrls() {
      const urls = new Set();
      if (data.cover) urls.add(data.cover);
      cats.forEach((c) => {
        const sizes = (c.sizes && c.sizes.length) ? c.sizes : [null];
        const colors = (c.colors && c.colors.length) ? c.colors : [null];
        sizes.forEach((_, si) => colors.forEach((__, ci) => {
          const u = productPng(c, { size: si, color: ci });
          if (u) urls.add(u);
        }));
        // feature "reveal" renders: a fixed `render`, or a `renderPattern` with
        // {size}/{color} resolved at hover — preload every combo so it never buffers.
        const addRenders = (arr) => (arr || []).forEach((f) => {
          if (!f) return;
          if (f.render) urls.add(f.render);
          if (f.renderPattern) sizes.forEach((sz) => colors.forEach((co) =>
            urls.add(f.renderPattern.replace(/\{size\}/g, (sz || {}).id || "").replace(/\{color\}/g, (co || {}).id || ""))));
        });
        if (Array.isArray(c.features)) addRenders(c.features);
        else if (c.features && typeof c.features === "object") Object.values(c.features).forEach(addRenders);
      });
      return [...urls];
    }
    function preloadAssets() {
      if (loading) loading.innerHTML =
        `<div class="exp-load-inner"><p>PREPARING YOUR ROOM</p><div class="exp-load-bar"><i></i></div></div>`;
      const bar = loading && loading.querySelector(".exp-load-bar > i");
      const urls = allImageUrls();
      const total = urls.length + 1; // + the video
      let done = 0;
      const bump = () => { done++; if (bar) bar.style.width = Math.round((done / total) * 100) + "%"; };
      const imgs = urls.map((u) => new Promise((res) => {
        const im = new Image(); im.decoding = "async";
        const done2 = () => { imgCache.set(u, im); bump(); res(); };
        im.onload = () => { if (im.decode) im.decode().then(done2).catch(done2); else done2(); };
        im.onerror = done2;
        im.src = u;
      }));
      const vid = new Promise((res) => {
        const fin = () => { bump(); res(); };
        if (!videoOk || video.readyState >= 2) { fin(); return; }
        const d = () => { video.removeEventListener("loadeddata", d); video.removeEventListener("canplay", d); fin(); };
        video.addEventListener("loadeddata", d);
        video.addEventListener("canplay", d);
      });
      return Promise.race([
        Promise.all([...imgs, vid]),
        new Promise((res) => setTimeout(res, 15000)),
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

    // -------- cart (localStorage, shared across packages) --------
    const CART_KEY = "aurem.cart.v1";
    const pkgKey = new URLSearchParams(location.search).get("pkg") || (data.name || "package");
    const pkgName = data.name || data.room || "Package";
    let cart = (function () { try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch (e) { return []; } })();
    const cartSave = () => { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (e) { /* private mode */ } };
    const keyCat = (it) => it.pkg + "|" + it.catId;
    const keyExact = (it) => keyCat(it) + "|" + it.sizeId + "|" + it.colorId;
    const cartIndexExact = (it) => cart.findIndex((x) => keyExact(x) === keyExact(it));
    const cartHasCatOther = (it) => cart.some((x) => keyCat(x) === keyCat(it) && keyExact(x) !== keyExact(it));
    function itemFor(cat, s) {
      const sz = cat.sizes[s.size] || {}, co = cat.colors[s.color] || {};
      return {
        pkg: pkgKey, pkgName, catId: cat.id, catName: cat.name || "",
        sizeId: sz.id || "", sizeName: (cat.sizes.length > 1 ? (sz.name || "") : ""),
        colorId: co.id || "", colorName: co.name || "", img: productPng(cat, s),
      };
    }

    // top-right cart widget
    document.querySelectorAll(".exp-cart").forEach((n) => n.remove());
    const cartWidget = el("div", "exp-cart");
    document.body.appendChild(cartWidget);
    let refreshAddBtn = () => {};
    function renderCart() {
      if (!cart.length) { cartWidget.classList.remove("has-items"); cartWidget.innerHTML = ""; return; }
      cartWidget.classList.add("has-items");
      cartWidget.innerHTML =
        `<div class="exp-cart-head"><span>Your cart</span><b>${cart.length}</b></div>` +
        `<ul>` + cart.map((it, i) =>
          `<li><span class="ec-line"><span class="ec-name">${esc(it.catName)}</span>` +
          `<span class="ec-var">${esc([it.sizeName, it.colorName].filter(Boolean).join(" · "))}</span></span>` +
          `<button type="button" class="ec-rm" data-i="${i}" aria-label="Remove">&times;</button></li>`
        ).join("") + `</ul>`;
      cartWidget.querySelectorAll(".ec-rm").forEach((b) =>
        b.addEventListener("click", () => { cart.splice(Number(b.dataset.i), 1); cartSave(); renderCart(); refreshAddBtn(); }));
    }
    renderCart();

    // duplicate-category confirm dialog -> resolves true/false
    function confirmDup(catName) {
      return new Promise((resolve) => {
        const ov = el("div", "exp-modal");
        ov.innerHTML =
          `<div class="exp-modal-card" role="dialog" aria-modal="true">` +
            `<p>Are you sure? You already have another product from the <b>${esc(catName)}</b> category.</p>` +
            `<div class="exp-modal-actions"><button type="button" class="btn btn-ghost" data-no>Cancel</button>` +
            `<button type="button" class="btn btn-primary" data-yes>Add anyway</button></div>` +
          `</div>`;
        document.body.appendChild(ov);
        const close = (v) => { ov.remove(); resolve(v); };
        ov.querySelector("[data-no]").addEventListener("click", () => close(false));
        ov.querySelector("[data-yes]").addEventListener("click", () => close(true));
        ov.addEventListener("click", (e) => { if (e.target === ov) close(false); });
        requestAnimationFrame(() => ov.classList.add("is-on"));
        ov.querySelector("[data-yes]").focus();
      });
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
          const startedAt = (typeof performance !== "undefined" ? performance.now() : Date.now());
          const tick = () => {
            const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
            if (v.currentTime >= t - 0.05 || elapsed > 12000) {
              try { v.pause(); v.playbackRate = 1; if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t; } catch (e) { /* ignore */ }
              cancelAnimationFrame(raf);
              resolve();
              return;
            }
            if (v.paused) { try { v.play(); } catch (e) { /* ignore */ } } // resume if backgrounding paused us
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
      const fName = (f) => (typeof f === "string" ? f : (f && f.name) || "");
      const fDesc = (f) => (typeof f === "string" ? "" : (f && f.desc) || "");
      // Features can be a flat array (all sizes) or an object keyed by size id
      // (per-size — e.g. the TV, whose 5 ft / 7 ft differ). Read for the current size.
      const catFeats = () => {
        const f = cat.features;
        if (Array.isArray(f)) return f;
        if (f && typeof f === "object") return f[(cat.sizes[s.size] || {}).id] || [];
        return [];
      };
      // A feature's reveal image: a fixed `render`, or a `renderPattern` whose
      // {size}/{color} resolve against the CURRENT selection at hover time (so a
      // per-colour reveal — e.g. the study — follows the chosen finish live).
      const resolveRender = (f) => {
        if (!f) return "";
        if (f.render) return f.render;
        if (f.renderPattern) {
          const size = (cat.sizes[s.size] || {}).id || "", color = (cat.colors[s.color] || {}).id || "";
          return f.renderPattern.replace(/\{size\}/g, size).replace(/\{color\}/g, color);
        }
        return "";
      };
      const view = el("div", "tour-cat is-on");
      view.innerHTML =
        `<div class="tour-hero${coverMode ? " is-cover" : ""}"><figure>${png ? `<img src="${esc(png)}" alt="${esc(cat.name || "")}">` : heroPh(cat.name)}</figure>${coverMode ? `<img class="tour-reveal" alt="">` : ""}</div>` +
        `<div class="tour-glows"></div>` +
        `<div class="tour-sprays"></div>` +
        `<div class="tour-hotspots"></div>` +
        // LEFT card: unit name + size / colour selectors
        `<div class="tour-info">` +
          `<p class="eyebrow">YOUR CHOICE</p>` +
          `<h3>${esc(cat.name || "")}</h3>` +
          (cat.sizes.length > 1
            ? `<div class="choose-group"><span class="choose-label">Size</span><div class="choose-pills">` +
                cat.sizes.map((sz, si) => `<button type="button" class="choose-pill${si === s.size ? " is-on" : ""}" data-size="${si}">${esc(sz.name)}</button>`).join("") +
              `</div></div>`
            : "") +
          `<div class="choose-group"><span class="choose-label">Colour — <em id="color-name">${esc((cat.colors[s.color] || {}).name || "")}</em></span><div class="choose-swatches">` +
            cat.colors.map((c, ci) => `<button type="button" class="choose-swatch${ci === s.color ? " is-on" : ""}" data-color="${ci}" title="${esc(c.name)}" style="--sw:${esc(c.swatch || "#999")}"><span></span></button>`).join("") +
          `</div></div>` +
          `<button type="button" class="tour-add">Add to cart</button>` +
        `</div>` +
        // RIGHT card: features (filled by buildFeatures for the current size)
        `<div class="tour-feats-card">` +
          `<p class="eyebrow">FEATURES</p>` +
          `<div class="tour-feats-body"></div>` +
        `</div>`;

      catWrap.textContent = "";
      catWrap.appendChild(view);
      // Fade this category in (image + cards). rAF so the transition runs.
      requestAnimationFrame(() => requestAnimationFrame(() => view.classList.add("is-shown")));

      // Build the FEATURES list + hotspots/glows/reveal for the CURRENT size.
      // A feature hover (or its list item) highlights the circle and, optionally,
      // blooms a light glow and/or cross-fades the frame to a "reveal" render
      // (e.g. shutters opening, pelmet fascia lifting to show the mechanism).
      const spotLayer = view.querySelector(".tour-hotspots");
      const glowLayer = view.querySelector(".tour-glows");
      const sprayLayer = view.querySelector(".tour-sprays");
      const featsBody = view.querySelector(".tour-feats-body");
      const revealImg = view.querySelector(".tour-reveal");
      function buildFeatures() {
        const feats = catFeats();
        featsBody.innerHTML = feats.length
          ? `<ul class="tour-feats">${feats.map((f, fi) => `<li data-feat="${fi}"><span class="tf-name">${esc(fName(f))}</span>${fDesc(f) ? `<span class="tf-desc">${esc(fDesc(f))}</span>` : ""}</li>`).join("")}</ul>`
          : `<p class="feats-empty">Details coming soon.</p>`;
        spotLayer.textContent = ""; glowLayer.textContent = ""; if (sprayLayer) sprayLayer.textContent = "";
        curSpots = []; curGlows = []; curSprays = [];
        if (revealImg) { revealImg.classList.remove("is-on"); revealImg.removeAttribute("src"); }
        feats.forEach((f, fi) => {
          if (!f || typeof f !== "object") return;
          const glowDefs = Array.isArray(f.glows) ? f.glows : (f.glow ? [f.glow] : []);
          const myGlows = [];
          glowDefs.forEach((g) => {
            if (g && g.x != null && g.y != null) {
              const ge = el("div", "tour-glow" + (g.rgb ? " is-rgb" : "")); glowLayer.appendChild(ge);
              curGlows.push({ el: ge, x: g.x, y: g.y, w: g.w || 0.05, h: g.h || 0.05 });
              myGlows.push(ge);
            }
          });
          // optional fragrance-mist "spray" that puffs while this feature is hovered
          let sprayEl = null;
          if (f.spray && sprayLayer) {
            const sp = (typeof f.spray === "object") ? f.spray : {};
            const sxp = sp.x != null ? sp.x : f.x, syp = sp.y != null ? sp.y : f.y;
            if (sxp != null && syp != null) {
              sprayEl = el("div", "tour-spray");
              sprayEl.innerHTML = "<i></i><i></i><i></i><i></i><i></i><i></i>";
              sprayLayer.appendChild(sprayEl);
              curSprays.push({ el: sprayEl, x: sxp, y: syp });
            }
          }
          if (f.x == null || f.y == null) return;
          const b = el("button", "tour-spot" + (f.below ? " below" : "") + ((f.render || f.renderPattern) ? " is-reveal" : ""));
          b.type = "button"; b.dataset.feat = fi;
          b.setAttribute("aria-label", fName(f));
          b.innerHTML = `<span class="spot-dot"></span><span class="spot-card"><b>${esc(fName(f))}</b>${fDesc(f) ? `<span>${esc(fDesc(f))}</span>` : ""}</span>`;
          spotLayer.appendChild(b);
          curSpots.push({ el: b, x: f.x, y: f.y });
          const li = featsBody.querySelector(`li[data-feat="${fi}"]`);
          const hasReveal = !!(f.render || f.renderPattern);
          const on = () => {
            b.classList.add("is-active"); if (li) li.classList.add("is-active");
            myGlows.forEach((g) => g.classList.add("is-active"));
            if (sprayEl) sprayEl.classList.add("is-active");
            if (hasReveal && revealImg) { const r = resolveRender(f); if (r) { if (revealImg.getAttribute("src") !== r) revealImg.setAttribute("src", r); revealImg.classList.add("is-on"); } }
          };
          const off = () => {
            b.classList.remove("is-active"); if (li) li.classList.remove("is-active");
            myGlows.forEach((g) => g.classList.remove("is-active"));
            if (sprayEl) sprayEl.classList.remove("is-active");
            if (hasReveal && revealImg) revealImg.classList.remove("is-on");
          };
          b.addEventListener("mouseenter", on); b.addEventListener("mouseleave", off);
          b.addEventListener("focus", on); b.addEventListener("blur", off);
          if (li) { li.addEventListener("mouseenter", on); li.addEventListener("mouseleave", off); }
        });
        placeHotspots();
      }
      buildFeatures();

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

      // Seamless swap for full-frame (cover) renders: decode the next image
      // (already preloaded) first, cross-fade it in over the current one, then
      // drop the old — so changing size or colour never flashes or buffers.
      function swapHero(url) {
        if (!heroFig) return;
        if (!url) { heroFig.innerHTML = heroPh(cat.name); return; }
        const cur = heroFig.querySelector("img:not(.tour-hero-next)");
        if (cur && cur.getAttribute("src") === url && cur.complete) return;
        heroFig.querySelectorAll("img.tour-hero-next").forEach((n) => n.remove());
        const cached = imgCache.get(url);
        const next = document.createElement("img");
        next.className = "tour-hero-next"; next.alt = cat.name || ""; next.decoding = "async";
        const show = () => {
          if (!heroFig.isConnected) return;
          heroFig.appendChild(next);
          requestAnimationFrame(() => requestAnimationFrame(() => next.classList.add("is-in")));
          const fin = () => {
            next.removeEventListener("transitionend", fin);
            heroFig.querySelectorAll("img").forEach((im) => { if (im !== next) im.remove(); });
            next.classList.remove("tour-hero-next", "is-in");
          };
          next.addEventListener("transitionend", fin);
          setTimeout(fin, 560);
        };
        next.onerror = () => { if (cur) cur.setAttribute("src", url); else heroFig.innerHTML = heroPh(cat.name); };
        next.src = url;
        if (next.decode) next.decode().then(show).catch(show);
        else if (next.complete || (cached && cached.complete)) show();
        else next.addEventListener("load", show, { once: true });
      }

      // Update the hero + labels in place when size/colour changes.
      const refresh = () => {
        const url = productPng(cat, s);
        if (coverMode) {
          swapHero(url);
        } else {
          heroFig.innerHTML = url ? `<img src="${esc(url)}" alt="${esc(cat.name || "")}">` : heroPh(cat.name);
          const im = heroFig.querySelector("img");
          if (im) { im.onerror = () => { im.outerHTML = heroPh(cat.name); }; if (placed) im.addEventListener("load", placeHero); }
          if (placed) placeHero();
        }
        const cn = view.querySelector("#color-name"); if (cn) cn.textContent = (cat.colors[s.color] || {}).name || "";
        syncAddBtn();
      };

      // Add-to-cart for the current variant (toggles; warns on same-category dup).
      const addBtn = view.querySelector(".tour-add");
      function syncAddBtn() {
        if (!addBtn) return;
        const inCart = cartIndexExact(itemFor(cat, s)) >= 0;
        addBtn.classList.toggle("is-in", inCart);
        addBtn.textContent = inCart ? "✓ Added to cart" : "Add to cart";
      }
      refreshAddBtn = syncAddBtn;
      if (addBtn) addBtn.addEventListener("click", () => {
        const it = itemFor(cat, s);
        const idx = cartIndexExact(it);
        if (idx >= 0) { cart.splice(idx, 1); cartSave(); renderCart(); syncAddBtn(); return; } // undo
        if (cartHasCatOther(it)) {
          confirmDup(it.catName).then((ok) => { if (ok) { cart.push(it); cartSave(); renderCart(); syncAddBtn(); } });
          return;
        }
        cart.push(it); cartSave(); renderCart(); syncAddBtn();
      });
      syncAddBtn();

      view.querySelectorAll(".choose-pill").forEach((b) => b.addEventListener("click", () => {
        const si = Number(b.dataset.size);
        if (si === s.size) return;
        s.size = si;
        view.querySelectorAll(".choose-pill").forEach((x) => x.classList.toggle("is-on", Number(x.dataset.size) === si));
        refresh();
        buildFeatures(); // features can differ per size (e.g. the TV)
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
      const has = cart.length > 0;
      const items = has
        ? cart.map((it) =>
            `<div class="tour-sum"><span class="t">${it.img ? `<img src="${esc(it.img)}" alt="">` : `<span>—</span>`}</span>` +
            `<div><small>${esc(it.pkgName)}</small><b>${esc(it.catName)}</b>` +
            `<em>${esc([it.sizeName, it.colorName].filter(Boolean).join(" · ")) || "&nbsp;"}</em></div></div>`
          ).join("")
        : `<p class="tour-cart-empty">Your cart is empty — add the pieces you like as you walk through, then come back here to review.</p>`;
      return (
        `<div class="tour-panel-inner">` +
          `<p class="eyebrow">${esc(has ? "YOUR SELECTION" : (o.eyebrow || "YOUR ROOM"))}</p>` +
          `<h1>${esc(has ? "Review your selection." : (o.title || "Here's your room."))}</h1>` +
          `<div class="tour-summary">${items}</div>` +
          `<div class="tour-outro-actions">` +
            `<a class="btn btn-ghost" href="sensory-rooms.html">+ Add from another package</a>` +
            (has ? `<a class="btn btn-primary" href="checkout.html">Review &amp; place order &rarr;</a>` : "") +
          `</div>` +
          `<button type="button" class="tour-restart-link" id="tour-restart">&#8635; Start the walk over</button>` +
        `</div>`
      );
    }

    function heroPh(name) { return `<div class="tour-hero-ph"><b>${esc(name || "Product")}</b><small>PNG goes here</small></div>`; }
    function phSpan() { const s2 = document.createElement("span"); s2.textContent = "PNG"; return s2; }
  }
})();
