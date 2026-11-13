// ============================================================================
// Smart features — the "common" story shared across the whole living-room
// journey: the voice device + the two modes (Ambient / Focus) and what each
// one does. Defined ONCE here and rendered on sensory-rooms, the experience
// intro, the package page and checkout, so the message stays identical.
//
//   SCSmart.renderModes(hostEl, { compact })  -> interactive Ambient/Focus toggle
//   SCSmart.renderRecap(hostEl)               -> compact "included" summary
//
// Visuals are styled graphics (icons + colour/mood shift). A future upgrade can
// cross-fade real Ambient/Focus room renders by giving each mode an `image`.
// ============================================================================
(function () {
  "use strict";
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const S = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const ICON = {
    fragrance: S('<path d="M9 4h6M10 4v3M14 4v3"/><path d="M8 7h8a0 0 0 0 1 0 0v9a4 4 0 0 1-4 4h0a4 4 0 0 1-4-4V7z"/><path d="M12 12v3"/>'),
    sound: S('<rect x="3" y="9" width="4" height="6" rx="1"/><path d="M7 10l6-4v12l-6-4"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8 8 0 0 1 0 12"/>'),
    light: S('<path d="M9 18h6M10 21h4"/><path d="M12 3a6 6 0 0 1 4 10.5c-.7.6-1 1.2-1 2.5H9c0-1.3-.3-1.9-1-2.5A6 6 0 0 1 12 3z"/>'),
    curtain: S('<path d="M3 3h18M4 3v16M20 3v16M4 19c3-1 3-13 3-16M20 19c-3-1-3-13-3-16M12 3v16"/>'),
    ac: S('<rect x="3" y="5" width="18" height="7" rx="2"/><path d="M6 9h8"/><path d="M7 15c0 1.5 1 2 1 3.5M12 15c0 1.5 1 2 1 3.5M17 15c0 1.5 1 2 1 3.5"/>'),
    voice: S('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"/>'),
  };

  const MODES = [
    {
      id: "ambient", name: "Ambient", eyebrow: "SIT BACK",
      tagline: "Sink in, watch, and unwind.",
      bullets: [
        { icon: "fragrance", text: "Fragrance shifts to relaxing scent tones" },
        { icon: "sound", text: "TV and surround sound switch on" },
        { icon: "light", text: "RGB strip light waves with the screen" },
        { icon: "curtain", text: "Curtains draw closed to 80%" },
        { icon: "ac", text: "AC switches on and cools the room" },
      ],
    },
    {
      id: "focus", name: "Focus", eyebrow: "HOST & TALK",
      tagline: "Open up, host, and converse.",
      bullets: [
        { icon: "light", text: "Every light lifts to warm white" },
        { icon: "sound", text: "TV volume eases down" },
        { icon: "curtain", text: "Curtains open to 20% for daylight" },
        { icon: "fragrance", text: "Fragrance shifts to alert, focus tones" },
      ],
    },
  ];

  const byId = (id) => MODES.find((m) => m.id === id) || MODES[0];
  const bulletList = (m) => `<ul class="scm-bullets">${m.bullets.map((b) => `<li><span class="scm-ic">${ICON[b.icon] || ""}</span>${esc(b.text)}</li>`).join("")}</ul>`;

  function renderModes(host, opts) {
    if (!host) return;
    opts = opts || {};
    const compact = !!opts.compact;
    const start = opts.mode || "ambient";
    host.classList.add("scm");
    if (compact) host.classList.add("is-compact");
    host.setAttribute("data-mode", start);
    host.innerHTML =
      `<div class="scm-toggle" role="tablist">` +
        MODES.map((m) => `<button type="button" role="tab" data-mode="${m.id}" class="${m.id === start ? "is-on" : ""}">${esc(m.name)}</button>`).join("") +
        `<span class="scm-thumb"></span>` +
      `</div>` +
      `<div class="scm-panel"></div>` +
      `<p class="scm-voice"><span class="scm-ic">${ICON.voice}</span>Say <b>“Ambient”</b> or <b>“Focus”</b> — the voice device on your table does the rest.</p>`;

    const panel = host.querySelector(".scm-panel");
    const thumb = host.querySelector(".scm-thumb");
    const btns = [...host.querySelectorAll(".scm-toggle button")];
    function paint(id, animate) {
      const m = byId(id);
      host.setAttribute("data-mode", id);
      btns.forEach((b) => b.classList.toggle("is-on", b.dataset.mode === id));
      const idx = MODES.findIndex((x) => x.id === id);
      if (thumb) thumb.style.transform = `translateX(${idx * 100}%)`;
      panel.innerHTML =
        `<p class="scm-eyebrow">${esc(m.eyebrow)}</p>` +
        `<p class="scm-tag">${esc(m.tagline)}</p>` +
        bulletList(m);
      if (animate) { panel.classList.remove("scm-in"); void panel.offsetWidth; panel.classList.add("scm-in"); }
    }
    btns.forEach((b) => b.addEventListener("click", () => paint(b.dataset.mode, true)));
    paint(start, false);
    return { set: (id) => paint(id, true) };
  }

  function renderRecap(host) {
    if (!host) return;
    host.classList.add("scm-recap");
    host.innerHTML =
      `<div class="scm-recap-head"><span class="scm-ic">${ICON.voice}</span><div>` +
        `<p class="scm-eyebrow">INCLUDED · SMART HOME</p>` +
        `<p class="scm-recap-title">Voice-controlled, with two modes</p>` +
      `</div></div>` +
      `<p class="scm-recap-sub">Your sockets, lights, curtains, AC, sound and fragrance all run from one voice device on your table — switch the whole room between <b>Ambient</b> and <b>Focus</b> with a word.</p>` +
      `<div class="scm-recap-modes">` +
        MODES.map((m) => `<div class="scm-recap-mode"><b>${esc(m.name)}</b><span>${esc(m.tagline)}</span></div>`).join("") +
      `</div>`;
  }

  window.SCSmart = { MODES, ICON, renderModes, renderRecap };
})();
