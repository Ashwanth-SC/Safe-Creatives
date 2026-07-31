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

  // GST state codes. Shared by the registration and checkout address forms;
  // the code decides the CGST/SGST vs IGST split on invoices, so it comes
  // from a fixed list rather than free text.
  const STATES = [
    ["01", "Jammu & Kashmir"], ["02", "Himachal Pradesh"], ["03", "Punjab"],
    ["04", "Chandigarh"], ["05", "Uttarakhand"], ["06", "Haryana"],
    ["07", "Delhi"], ["08", "Rajasthan"], ["09", "Uttar Pradesh"],
    ["10", "Bihar"], ["11", "Sikkim"], ["12", "Arunachal Pradesh"],
    ["13", "Nagaland"], ["14", "Manipur"], ["15", "Mizoram"],
    ["16", "Tripura"], ["17", "Meghalaya"], ["18", "Assam"],
    ["19", "West Bengal"], ["20", "Jharkhand"], ["21", "Odisha"],
    ["22", "Chhattisgarh"], ["23", "Madhya Pradesh"], ["24", "Gujarat"],
    ["26", "Dadra & Nagar Haveli and Daman & Diu"], ["27", "Maharashtra"],
    ["29", "Karnataka"], ["30", "Goa"], ["31", "Lakshadweep"],
    ["32", "Kerala"], ["33", "Tamil Nadu"], ["34", "Puducherry"],
    ["35", "Andaman & Nicobar Islands"], ["36", "Telangana"],
    ["37", "Andhra Pradesh"], ["38", "Ladakh"],
  ];

  // Fills a <select> with the states, keeping a leading placeholder option.
  function fillStateSelect(select, selectedCode) {
    STATES.forEach(([code, name]) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      if (code === selectedCode) option.selected = true;
      select.appendChild(option);
    });
  }

  function stateNameOf(code) {
    return STATES.find(([c]) => c === code)?.[1] ?? null;
  }

  const state = { session: null, profile: null };

  // --------------------------------------------------------------------
  // Formatting
  // --------------------------------------------------------------------
  // Prices come from the database in paise. Nothing in the UI should ever
  // do this conversion inline — one helper, one place to get it wrong.

  function money(paise) {
    return `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
  }

  // GST and the installment splits are floored to whole rupees so the figure
  // SHOWN always equals the figure CHARGED. Razorpay bills the exact paise, so a
  // fractional-rupee GST would be charged in full while the rounded rupee display
  // hid the paise — we drop the fraction at the source instead. The same formula
  // is mirrored server-side (create-order / revise-order / create-installment-link).
  function floorRupees(paise) {
    return Math.floor(Number(paise || 0) / 100) * 100;
  }
  function gstPaise(subtotalPaise, percent) {
    return floorRupees((Number(subtotalPaise || 0) * Number(percent)) / 100);
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
      .select(
        "id, full_name, email, phone, address_line, city, state_name, state_code, pin_code, gstin, customer_number, is_admin"
      )
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
    // Print-oriented pages (the invoice) opt out: a floating account icon
    // has no place on a document headed for paper.
    if (document.body.dataset.noMenu === "true") return;

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

    // Staff get a way into the catalog admin without memorising the URL.
    // This is convenience, not security: admin.html is protected by RLS, so
    // anyone who finds the address without the flag sees "Admin only".
    const adminLink = state.profile?.is_admin
      ? '<a class="account-admin-link" href="dashboard.html">Dashboard</a>' +
        '<a class="account-admin-link" href="admin.html">Catalog admin</a>'
      : "";

    // Every signed-in customer can follow their orders' progress and payments.
    const trackLink =
      '<a class="account-admin-link" href="track-order.html">Track my orders</a>';

    dropdown.innerHTML = `<span class="account-status"></span>${adminLink}${trackLink}<button type="button" class="logout-button">Log out</button>`;
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
  // WhatsApp enquiry button
  // --------------------------------------------------------------------
  // A floating chat CTA — for a high-consideration purchase, a direct message
  // often converts better than a form. Public-facing pages only: kept off the
  // auth, checkout, dashboard, admin and printable-invoice pages.

  const WHATSAPP_NUMBER = "919789890877";
  const WHATSAPP_HIDDEN_PAGES = [
    "login.html", "register.html", "checkout.html", "order-confirmation.html",
    "dashboard.html", "admin.html", "invoice.html",
  ];

  function setUpWhatsApp() {
    if (document.body.dataset.noMenu === "true") return;
    if (WHATSAPP_HIDDEN_PAGES.includes(currentPage())) return;
    if (document.querySelector(".whatsapp-float")) return;

    const message =
      "Hi Safe Creatives, I'd like to know more about your sensory rooms.";
    const link = document.createElement("a");
    link.className = "whatsapp-float";
    link.href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.setAttribute("aria-label", "Chat with us on WhatsApp");
    link.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12.04 2c-5.46 0-9.91 4.45-9.91 9.91 0 1.75.46 3.45 1.32 4.95L2.05 22l5.25-1.38c1.45.79 3.08 1.21 4.74 1.21 5.46 0 9.91-4.45 9.91-9.91S17.5 2 12.04 2zm0 18.15c-1.48 0-2.93-.4-4.2-1.15l-.3-.18-3.12.82.83-3.04-.2-.31a8.13 8.13 0 0 1-1.26-4.35c0-4.54 3.7-8.23 8.24-8.23 2.2 0 4.27.86 5.82 2.42a8.18 8.18 0 0 1 2.41 5.83c0 4.54-3.7 8.24-8.24 8.24zm4.52-6.16c-.25-.12-1.47-.72-1.69-.81-.23-.08-.39-.12-.56.12-.16.25-.64.81-.79.97-.14.17-.29.19-.54.06-.25-.12-1.05-.39-1.99-1.23-.74-.66-1.23-1.47-1.38-1.72-.14-.25-.02-.38.11-.51.11-.11.25-.29.37-.43.12-.14.16-.25.25-.41.08-.17.04-.31-.02-.43-.06-.12-.56-1.34-.76-1.84-.2-.48-.4-.42-.56-.43-.14 0-.31-.01-.47-.01-.17 0-.43.06-.66.31-.23.25-.86.85-.86 2.07 0 1.22.89 2.4 1.01 2.56.12.17 1.75 2.67 4.23 3.74.59.26 1.05.41 1.41.52.59.19 1.13.16 1.56.1.48-.07 1.47-.6 1.68-1.18.21-.58.21-1.07.14-1.18-.06-.11-.22-.17-.47-.29z"/></svg>';
    document.body.appendChild(link);
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
    setUpWhatsApp();
    if (state.session) startInactivityTimer();
  });

  return {
    ready,
    money,
    floorRupees,
    gstPaise,
    logout,
    toLogin,
    STATES,
    fillStateSelect,
    stateNameOf,
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
