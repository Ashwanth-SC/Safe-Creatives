// ============================================================================
// Sensory Rooms — guided video tour / configurator
// ============================================================================
//
// Reads experience.json and plays the walkthrough video as a stepped tour:
//
//   intro  -> press "Start"
//   each category: the video plays forward to that category's `pauseAt` frame
//                  and stops; the options appear centred in the frame; the
//                  visitor picks one (carried forward)
//   outro  -> a summary of the picks + a CTA to build the package
//
// Everything is data-driven. Drop a web-optimised walkthrough video at
// room.video, transparent product PNGs at each option's `png`, and set each
// category's `pauseAt` (seconds) to the frame it should stop on. Missing assets
// fall back to labelled placeholders, so the flow works before the art is ready.
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
    .then(build)
    .catch((err) => { console.error("Experience load failed:", err); if (loading) loading.textContent = "Could not load the experience."; });

  function build(data) {
    const cats = data.categories || [];
    const selected = cats.map(() => 0); // default pick = first option
    let step = -1;   // -1 intro, 0..n-1 categories, n outro
    let busy = false;

    // -------- DOM --------
    const tour = el("div", "tour");

    const poster = document.createElement("img");
    poster.className = "tour-poster"; poster.alt = ""; poster.src = data.poster || "";

    const video = document.createElement("video");
    video.className = "tour-video";
    video.muted = true; video.playsInline = true; video.preload = "auto";
    video.setAttribute("muted", ""); video.setAttribute("playsinline", "");
    const playSpeed = Number(data.playSpeed) > 0 ? Number(data.playSpeed) : 2.5; // brisk walk between stops
    let videoOk = !!data.video;
    if (data.video) video.src = data.video;
    video.addEventListener("error", () => { videoOk = false; video.style.display = "none"; });

    const scrim = el("div", "tour-scrim");
    const catWrap = el("div");

    const introP = el("div", "tour-panel");
    introP.innerHTML =
      `<div class="tour-panel-inner">` +
        `<p class="eyebrow">${esc((data.intro || {}).eyebrow || "SENSORY ROOMS")}</p>` +
        `<h1>${esc((data.intro || {}).title || "Step inside")}</h1>` +
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
      catWrap.textContent = ""; // clear old stop while the camera moves
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

    // Play the video forward to `target` seconds and pause there. Going back (or
    // when the video isn't available) it just seeks/returns so the UI still runs.
    function playTo(target, forward) {
      return new Promise((resolve) => {
        const v = video;
        if (!videoOk) { resolve(); return; }

        const run = () => {
          if (isNaN(v.duration)) { resolve(); return; }
          const t = Math.min(target, v.duration || target);
          // Going back, or already there: seek to the stop (works on a host that
          // serves byte ranges — Netlify does; a plain dev server may not).
          if (!forward || t <= v.currentTime + 0.1) {
            try { v.pause(); if (Math.abs(v.currentTime - t) > 0.15) v.currentTime = t; } catch (e) { /* ignore */ }
            resolve();
            return;
          }
          // Going forward: just play up to the stop and pause there — no seek, so
          // it's reliable even where seeking isn't supported.
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

        // The first stop may be reached before the video's metadata has loaded,
        // so wait until it's ready (with a safety timeout) before playing.
        if (v.readyState >= 1 && !isNaN(v.duration)) { run(); return; }
        let done = false;
        const onReady = () => {
          if (done) return; done = true;
          v.removeEventListener("loadedmetadata", onReady);
          v.removeEventListener("canplay", onReady);
          run();
        };
        v.addEventListener("loadedmetadata", onReady);
        v.addEventListener("canplay", onReady);
        setTimeout(onReady, 4000);
      });
    }

    // -------- category view --------
    function renderCat(i) {
      const cat = cats[i];
      const sel = selected[i];
      const opt = cat.options[sel] || {};
      const view = el("div", "tour-cat is-on");
      view.innerHTML =
        `<div class="tour-cat-head">` +
          `<div class="step">STOP ${i + 1} / ${cats.length}</div>` +
          `<h2>${esc(cat.name || "")}</h2>` +
          (cat.note ? `<p class="note">${esc(cat.note)}</p>` : "") +
        `</div>` +
        `<div class="tour-hero"><figure>${opt.png ? `<img src="${esc(opt.png)}" alt="${esc(opt.name || "")}">` : heroPh(opt.name)}</figure></div>` +
        `<div class="tour-info">` +
          `<p class="eyebrow">THIS PIECE</p>` +
          `<h3>${esc(opt.name || "")}</h3>` +
          (opt.blurb ? `<p class="blurb">${esc(opt.blurb)}</p>` : "") +
          `<ul class="tour-feats">${(opt.features || []).map((f) => `<li>${esc(f)}</li>`).join("")}</ul>` +
        `</div>` +
        `<div class="tour-options">` +
          `<span class="pick-label">Choose one</span>` +
          cat.options.map((o, oi) => optHtml(o, oi === sel)).join("") +
        `</div>`;

      catWrap.textContent = "";
      catWrap.appendChild(view);

      const heroImg = view.querySelector(".tour-hero img");
      if (heroImg) heroImg.onerror = () => { const d = el("div", "tour-hero-ph"); d.innerHTML = `<b>${esc(opt.name || "Product")}</b><small>PNG goes here</small>`; heroImg.replaceWith(d); };
      view.querySelectorAll(".tour-opt-thumb img").forEach((img) => (img.onerror = () => img.replaceWith(phSpan())));
      view.querySelectorAll(".tour-opt").forEach((b, oi) => b.addEventListener("click", () => { if (selected[i] === oi) return; selected[i] = oi; renderCat(i); }));
    }

    function optHtml(o, isSel) {
      return (
        `<button type="button" class="tour-opt${isSel ? " is-selected" : ""}">` +
          `<span class="tour-opt-thumb">${o.png ? `<img src="${esc(o.png)}" alt="">` : `<span>PNG</span>`}</span>` +
          `<b>${esc(o.name || "")}</b>` +
          `<span class="tick">✓</span>` +
        `</button>`
      );
    }

    function outroHtml() {
      const o = data.outro || {};
      const sum = cats.map((c, i) => {
        const opt = c.options[selected[i]] || {};
        return `<div class="tour-sum"><span class="t">${opt.png ? `<img src="${esc(opt.png)}" alt="">` : `<span>PNG</span>`}</span><div><small>${esc(c.name)}</small><b>${esc(opt.name || "")}</b></div></div>`;
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
    function phSpan() { const s = document.createElement("span"); s.textContent = "PNG"; return s; }
  }
})();
