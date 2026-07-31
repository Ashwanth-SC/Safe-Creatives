// ============================================================================
// Safe Creatives — registration
// ============================================================================
//
// Reached only after the email is verified, so identity is already
// established. This page fills in the profile row the signup trigger created
// with an empty name.
//
// It never asks for the email: that came from the verified session, and an
// editable field there would let someone claim a different address than the
// one they proved they own.
// ============================================================================

(async function () {
  const { session, profile } = await SC.ready;

  const nextPage =
    new URLSearchParams(window.location.search).get("next") || "index.html";

  const form = document.querySelector("#register-form");
  const nameField = document.querySelector("#full-name");
  const phoneField = document.querySelector("#phone");
  const addressField = document.querySelector("#address");
  const cityField = document.querySelector("#city");
  const stateField = document.querySelector("#state");
  const pinField = document.querySelector("#pin-code");
  const gstinField = document.querySelector("#gstin");

  // 2 state code, 10 PAN, 1 entity, 'Z', 1 check character.
  const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
  const button = document.querySelector("#save-profile");
  const message = document.querySelector("#register-message");
  const emailLabel = document.querySelector("#verified-email");

  emailLabel.textContent = profile?.email || session.user.email;

  // Someone who already registered but came back here directly should see
  // their existing details rather than a blank form.
  nameField.value = profile?.full_name || "";
  phoneField.value = profile?.phone || "";
  addressField.value = profile?.address_line || "";
  cityField.value = profile?.city || "";
  SC.fillStateSelect(stateField, profile?.state_code || "");
  pinField.value = profile?.pin_code || "";
  gstinField.value = profile?.gstin || "";

  function show(text, type = "") {
    message.textContent = text;
    message.className = `form-message ${type}`;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fullName = nameField.value.trim();
    const phone = phoneField.value.trim();
    const address = addressField.value.trim();
    const city = cityField.value.trim();
    const state = stateField.value;
    const pin = pinField.value.trim();
    const gstin = gstinField.value.trim().toUpperCase();

    if (!fullName) {
      show("Please enter your full name.", "error");
      nameField.focus();
      return;
    }

    if (!phone) {
      show("Please enter a phone number so we can reach you.", "error");
      phoneField.focus();
      return;
    }

    button.disabled = true;
    show("Saving...");

    if (pin && !/^\d{6}$/.test(pin)) {
      show("PIN code should be 6 digits.", "error");
      pinField.focus();
      return;
    }

    // Checked here as well as in the database, so a typo is caught before the
    // save rather than surfacing as a constraint violation.
    if (gstin && !GSTIN_PATTERN.test(gstin)) {
      show("That does not look like a valid 15-character GSTIN.", "error");
      gstinField.focus();
      return;
    }

    // Address parts are only written when provided, so returning here and
    // leaving them blank does not wipe an address set at checkout.
    const updates = { full_name: fullName, phone };
    if (address) updates.address_line = address;
    if (city) updates.city = city;
    if (state) {
      updates.state_code = state;
      updates.state_name = SC.stateNameOf(state);
    }
    if (pin) updates.pin_code = pin;
    // Written even when blank, so a customer can clear a GSTIN they no longer
    // want on their invoices.
    updates.gstin = gstin || null;

    const { error } = await sb
      .from("profiles")
      .update(updates)
      .eq("id", SC.userId);

    if (error) {
      show(`Could not save your details: ${error.message}`, "error");
      button.disabled = false;
      return;
    }

    show("Saved.", "success");
    window.location.href = nextPage;
  });
})();
