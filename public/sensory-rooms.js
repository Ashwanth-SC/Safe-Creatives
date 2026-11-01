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
  }

  // Admin gate (preview): sensory rooms is admin-only for now; everyone else
  // keeps the "coming soon" overlay. Fail closed if auth isn't available.
  if (window.SC && SC.ready) {
    SC.ready.then(function () {
      if (!SC.isAdmin) return;
      const gate = document.getElementById("sc-gate");
      if (gate) gate.remove();
      run();
    });
  }
})();
