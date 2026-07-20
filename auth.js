// ============================================================================
// Safe Creatives — shared auth
// ============================================================================
//
// Replaces auth-local.js. Every page now reads the same Supabase session,
// which is what fixes the login redirect loop: previously login.html created
// a Supabase session while every other page looked for a localStorage one,
// so a successful login still read as logged out.
//
// Load order on every page:
//   1. supabase-js CDN
//   2. supabase-client.js   (defines `sb`)
//   3. auth.js              (this file, defines `SC`)
//   4. the page's own script
//
// Sessions are async, so page scripts must wait:
//   const { session, profile } = await SC.ready;
// ============================================================================

window.SC = (function () {
  const INACTIVITY_MS = 10 * 60 * 1000;

  const state = { session: null, profile: null };

  // --------------------------------------------------------------------
  // Formatting
  // --------------------------------------------------------------------
  // Prices come from the database in paise. Nothing in the UI should ever
  // do this conversion inline — one helper, one place to get it wrong.

  function money(paise) {
    return `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  }

  // --------------------------------------------------------------------
  // Flash prevention
  // --------------------------------------------------------------------
  // Guarded pages must not paint their contents before we know whether the
  // visitor is allowed to see them. Hide immediately, reveal once resolved.

  const isGuarded = document.body?.dataset.requiresAuth === "true";
  // register.html sets this: it is the page that completes a profile, so the
  // incomplete-profile redirect below must skip it or it would loop.
  const allowIncomplete = document.body?.dataset.allowIncomplete === "true";
  let revealStyle = null;

  if (isGuarded) {
    revealStyle = document.createElement("style");
    revealStyle.textContent = "body { visibility: hidden; }";
    document.head.appendChild(revealStyle);
  }

  function reveal() {
    revealStyle?.remove();
    revealStyle = null;
  }

  // --------------------------------------------------------------------
  // Session
  // --------------------------------------------------------------------

  function currentPage() {
    return window.location.pathname.split("/").pop() || "index.html";
  }

  function toLogin(nextPage) {
    window.location.replace(
      `login.html?next=${encodeURIComponent(nextPage || currentPage())}`
    );
  }

  function toRegister(nextPage) {
    window.location.replace(
      `register.html?next=${encodeURIComponent(nextPage || currentPage())}`
    );
  }

  // A profile row always exists once signup has run, so "registered" means
  // the name has actually been filled in rather than the row being present.
  function isRegistered(profile) {
    return Boolean(profile?.full_name?.trim());
  }

  async function loadProfile(userId) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, full_name, email, phone, address, is_admin")
      .eq("id", userId)
      .maybeSingle();

    if (error) {
      console.error("Could not load profile:", error.message);
      return null;
    }
    return data;
  }

  async function resolve() {
    let session = null;

    try {
      ({
        data: { session },
      } = await sb.auth.getSession());
    } catch (sessionError) {
      // A network failure here must not leave a guarded page permanently
      // blank. Reveal it and treat the visitor as signed out; the guard
      // below still sends them to login.
      console.error("Could not read session:", sessionError);
      reveal();
    }

    state.session = session;

    if (!session) {
      if (isGuarded) {
        toLogin();
        // Deliberately never resolves: the page is navigating away, and
        // letting page scripts continue here would make them render against
        // a null session for a frame.
        return new Promise(() => {});
      }
      reveal();
      return state;
    }

    state.profile = await loadProfile(session.user.id);

    // Verified but never finished registering. Deep-linking to a guarded page
    // must not skip this: create-order needs a name and phone, and the
    // checkout would otherwise render a profile card full of blanks.
    if (isGuarded && !allowIncomplete && !isRegistered(state.profile)) {
      toRegister();
      return new Promise(() => {});
    }

    reveal();
    return state;
  }

  const ready = resolve();

  // --------------------------------------------------------------------
  // Logout
  // --------------------------------------------------------------------

  async function logout() {
    await sb.auth.signOut();
    window.location.href = "index.html";
  }

  // Signing out in another tab should not leave this one showing a
  // logged-in view of a guarded page.
  sb.auth.onAuthStateChange((event) => {
    if (event === "SIGNED_OUT" && isGuarded) toLogin();
  });

  // --------------------------------------------------------------------
  // Links that require login
  // --------------------------------------------------------------------

  function guardLinks() {
    document.querySelectorAll("[data-auth-required]").forEach((link) => {
      link.addEventListener("click", (event) => {
        if (!state.session) {
          event.preventDefault();
          toLogin(link.dataset.authRequired);
        }
      });
    });
  }

  // --------------------------------------------------------------------
  // Account menu
  // --------------------------------------------------------------------

  function accountIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"></circle><path d="M4.5 20c.5-4 3.4-6.5 7.5-6.5s7 2.5 7.5 6.5"></path></svg>';
  }

  function setUpAccountMenu() {
    let trigger = document.querySelector(".account-link");
    let container = trigger?.parentElement;

    if (!trigger) {
      container =
        document.querySelector(".site-header") ||
        document.querySelector(".package-topbar") ||
        document.body;
      trigger = document.createElement("a");
      trigger.className = "account-link auth-generated";
      trigger.href = "login.html";
      trigger.setAttribute("aria-label", "Open account menu");
      trigger.innerHTML = accountIcon();
      container.appendChild(trigger);
    }

    if (!state.session) return;

    const dropdown = document.createElement("div");
    dropdown.className = "account-dropdown";
    dropdown.hidden = true;
    dropdown.innerHTML =
      '<span class="account-status"></span><button type="button" class="logout-button">Log out</button>';
    container.appendChild(dropdown);

    dropdown.querySelector(".account-status").textContent =
      state.profile?.full_name || state.session.user.email;

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      dropdown.hidden = !dropdown.hidden;
    });
    dropdown.querySelector(".logout-button").addEventListener("click", logout);
  }

  // --------------------------------------------------------------------
  // Inactivity timeout
  // --------------------------------------------------------------------

  function startInactivityTimer() {
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(logout, INACTIVITY_MS);
    };
    ["pointerdown", "mousemove", "keydown", "scroll", "touchstart"].forEach(
      (name) => window.addEventListener(name, reset, { passive: true })
    );
    reset();
  }

  // --------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------

  ready.then(() => {
    guardLinks();
    setUpAccountMenu();
    if (state.session) startInactivityTimer();
  });

  return {
    ready,
    money,
    logout,
    toLogin,
    get session() {
      return state.session;
    },
    get profile() {
      return state.profile;
    },
    get userId() {
      return state.session?.user?.id ?? null;
    },
    get isAdmin() {
      return state.profile?.is_admin === true;
    },
  };
})();
