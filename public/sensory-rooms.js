// ============================================================================
// Safe Creatives — Sensory Rooms landing (static, immersive)
// ============================================================================
// Just the chrome: the header turns solid once past the hero, and sections
// fade up as they enter view. Packages are hardcoded links to the per-package
// video tour (experience.html?pkg=…), so this page needs no Supabase/auth.
// ============================================================================

(function () {
  "use strict";

  function run() {
    // The page is auth-guarded, so auth.js keeps the body hidden while the
    // session resolves — and browsers defer a hidden <video>'s autoplay, so
    // once we're revealed the hero clip can be sitting paused with a play
    // button over it. Kick it off ourselves; a muted play needs no gesture.
    const hero = document.querySelector(".sr-hero-video");
    if (hero) {
      hero.muted = true;
      const kick = () => { const p = hero.play(); if (p && p.catch) p.catch(function () {}); };
      kick();
      requestAnimationFrame(kick);
    }

    const head = document.getElementById("sr-head");
    if (head) {
      const onScroll = () => head.classList.toggle("is-solid", window.scrollY > window.innerHeight * 0.66);
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }

    const reveals = document.querySelectorAll(".reveal");
    if ("IntersectionObserver" in window && reveals.length) {
      const io = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
          });
        },
        { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
      );
      reveals.forEach((el) => io.observe(el));
    } else {
      reveals.forEach((el) => el.classList.add("is-in"));
    }

    // The shared Ambient/Focus modes toggle (the "common features" story).
    if (window.SCSmart) SCSmart.renderModes(document.getElementById("sr-modes-body"));
  }

  // Registered-user gate: the page is guarded (data-requires-auth), so auth.js
  // sends signed-out visitors to login and unregistered ones to register, and
  // only resolves here for a registered user — then we drop the overlay and run.
  if (window.SC && SC.ready) {
    SC.ready.then(function () {
      const gate = document.getElementById("sc-gate");
      if (gate) gate.remove();
      run();
    });
  }
})();
