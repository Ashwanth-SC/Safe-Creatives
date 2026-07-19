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
  const button = document.querySelector("#save-profile");
  const message = document.querySelector("#register-message");
  const emailLabel = document.querySelector("#verified-email");

  emailLabel.textContent = profile?.email || session.user.email;

  // Someone who already registered but came back here directly should see
  // their existing details rather than a blank form.
  nameField.value = profile?.full_name || "";
  phoneField.value = profile?.phone || "";
  addressField.value = profile?.address || "";

  function show(text, type = "") {
    message.textContent = text;
    message.className = `form-message ${type}`;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const fullName = nameField.value.trim();
    const phone = phoneField.value.trim();
    const address = addressField.value.trim();

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

    // Address is only written when provided, so returning here and leaving it
    // blank does not wipe an address set at checkout.
    const updates = { full_name: fullName, phone };
    if (address) updates.address = address;

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
