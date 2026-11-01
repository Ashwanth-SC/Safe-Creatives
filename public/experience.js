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
    requestAnimationFrame(() => { if (loading) loading.classList.add("is-hidden"); });

    // -------- helpers --------
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

    async function goCategory(i) {
      if (busy || i < 0 || i >= cats.length) return;
      busy = true;
      const forward = i > step;
      introP.classList.remove("is-on");
      outroP.classList.remove("is-on");
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

    function goOutro() {
      step = cats.length; busy = false;
      nav.style.display = "none";
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
      const view = el("div", "tour-cat is-on");
      view.innerHTML =
        `<div class="tour-cat-head">` +
          `<div class="step">STOP ${i + 1} / ${cats.length}</div>` +
          `<h2>${esc(cat.name || "")}</h2>` +
          (cat.note ? `<p class="note">${esc(cat.note)}</p>` : "") +
        `</div>` +
        `<div class="tour-hero"><figure>${png ? `<img src="${esc(png)}" alt="${esc(cat.name || "")}">` : heroPh(cat.name)}</figure></div>` +
        `<div class="tour-info">` +
          `<p class="eyebrow">YOUR CHOICE</p>` +
          `<h3>${esc(cat.name || "")}</h3>` +
          `<p class="variant" id="variant-line">${esc(variantLabel(cat, s))}</p>` +
          (cat.blurb ? `<p class="blurb">${esc(cat.blurb)}</p>` : "") +
          `<ul class="tour-feats">${(cat.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
        `</div>` +
        `<div class="tour-choose">` +
          `<div class="choose-group"><span class="choose-label">Size</span><div class="choose-pills">` +
            cat.sizes.map((sz, si) => `<button type="button" class="choose-pill${si === s.size ? " is-on" : ""}" data-size="${si}">${esc(sz.name)}</button>`).join("") +
          `</div></div>` +
          `<div class="choose-group"><span class="choose-label">Colour — <em id="color-name">${esc((cat.colors[s.color] || {}).name || "")}</em></span><div class="choose-swatches">` +
            cat.colors.map((c, ci) => `<button type="button" class="choose-swatch${ci === s.color ? " is-on" : ""}" data-color="${ci}" title="${esc(c.name)}" style="--sw:${esc(c.swatch || "#999")}"><span></span></button>`).join("") +
          `</div></div>` +
        `</div>`;

      catWrap.textContent = "";
      catWrap.appendChild(view);

      const heroFig = view.querySelector(".tour-hero figure");
      const heroImg = view.querySelector(".tour-hero img");
      if (heroImg) heroImg.onerror = () => { heroImg.outerHTML = heroPh(cat.name); };

      // Update the hero + labels in place when size/colour changes.
      const refresh = () => {
        const url = productPng(cat, s);
        heroFig.innerHTML = url ? `<img src="${esc(url)}" alt="${esc(cat.name || "")}">` : heroPh(cat.name);
        const im = heroFig.querySelector("img");
        if (im) im.onerror = () => { im.outerHTML = heroPh(cat.name); };
        const vl = view.querySelector("#variant-line"); if (vl) vl.textContent = variantLabel(cat, s);
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
