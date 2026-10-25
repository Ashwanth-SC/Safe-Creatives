// ============================================================================
// SAFE CREATIVES LOGIN
// Email OTP — email only, details collected after verification
// ============================================================================
//
// Whether an email already has an account is NOT knowable before the code is
// verified, and deliberately so: an endpoint that answered "is this address
// registered?" would let anyone enumerate your customer list.
//
// So the code goes out either way, and the branch happens after:
//
//   verified + profile has a name  ->  straight on to `next`
//   verified + profile incomplete  ->  register.html to collect details
//
// A profile row always exists by this point — the on_auth_user_created
// trigger creates it at signup with an empty full_name — so "incomplete"
// means an empty name rather than a missing row.
// ============================================================================

const nextPage =
    new URLSearchParams(window.location.search).get("next") ||
    "index.html";

const detailsSection = document.getElementById("details-section");
const otpSection = document.getElementById("otp-section");

const detailsForm = document.getElementById("details-form");
const otpForm = document.getElementById("otp-form");

const message = document.getElementById("auth-message");

let pendingEmail = "";

// ======================================================
// Already Logged In?
// ======================================================

(async () => {

    const {
        data: { session }
    } = await sb.auth.getSession();

    if (session) {
        window.location.replace(await destinationFor(session.user.id));
    }

})();

// ======================================================
// Helper
// ======================================================

function showMessage(text, type = "") {

    message.textContent = text;
    message.className = `form-message ${type}`;

}

// Where a verified user should land. Registration carries `next` through so
// the customer resumes whatever they were trying to reach.
async function destinationFor(userId) {

    const { data: profile } = await sb
        .from("profiles")
        .select("full_name")
        .eq("id", userId)
        .maybeSingle();

    let registered = Boolean(profile?.full_name?.trim());

    // Turnkey customers already gave their name + phone on the enquiry form, so
    // pull those into the profile and skip the registration form.
    if (!registered) {
        try {
            const { data: claimed } = await sb.rpc("turnkey_claim_lead_profile");
            if (claimed === true) registered = true;
        } catch (_ignored) {
            // Fall through to registration.
        }
    }

    return registered
        ? nextPage
        : `register.html?next=${encodeURIComponent(nextPage)}`;

}

// ======================================================
// CAPTCHA (Cloudflare Turnstile)
// ======================================================
//
// Bots were calling Supabase's email-code endpoint directly with the public
// anon key — no page involved — creating hundreds of junk accounts and
// mailing a code to each (stolen) address. A check in this page can't stop
// that; Supabase Auth's own CAPTCHA protection can, because it rejects any
// code request that doesn't carry a valid Turnstile token.
//
// Paste the Turnstile SITE key below. Leave it empty until CAPTCHA protection
// is switched on in Supabase (Auth -> Attack Protection), or every login
// would be rejected for a missing token. The SECRET key goes only in Supabase.

const TURNSTILE_SITE_KEY = "";

let captchaToken = "";

window.onTurnstileLoad = () => {

    window.turnstile.render("#captcha", {
        sitekey: TURNSTILE_SITE_KEY,
        appearance: "interaction-only",
        callback: (token) => { captchaToken = token; },
        "expired-callback": () => { captchaToken = ""; },
        "error-callback": () => { captchaToken = ""; }
    });

};

if (TURNSTILE_SITE_KEY) {

    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit";
    script.async = true;
    document.head.appendChild(script);

}

async function sendCode(email) {

    if (TURNSTILE_SITE_KEY && !captchaToken) {

        return {
            error: {
                message: "Just a moment — we're checking your browser. Please try again in a few seconds."
            }
        };

    }

    const result = await sb.auth.signInWithOtp({

        email,

        options: {
            shouldCreateUser: true,
            captchaToken: captchaToken || undefined
        }

    });

    // A token is single-use, so get a fresh one ready for "Resend Code".
    if (TURNSTILE_SITE_KEY && window.turnstile) {
        captchaToken = "";
        window.turnstile.reset("#captcha");
    }

    return result;

}

// ======================================================
// SEND OTP
// ======================================================

detailsForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    const email = document
        .getElementById("email")
        .value
        .trim()
        .toLowerCase();

    if (!email) {

        showMessage(
            "Please enter your email address.",
            "error"
        );

        return;

    }

    pendingEmail = email;

    showMessage("Sending verification code...");

    const { error } = await sendCode(email);

    if (error) {

        showMessage(
            error.message,
            "error"
        );

        return;

    }

    detailsSection.hidden = true;
    otpSection.hidden = false;

    showMessage(
        `Verification code sent to ${email}.`,
        "success"
    );

    document.getElementById("otp").focus();

});

// ======================================================
// VERIFY OTP
// ======================================================

otpForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    const token = document
        .getElementById("otp")
        .value
        .trim();

    if (token.length !== 6) {

        showMessage(
            "Enter the 6-digit verification code.",
            "error"
        );

        return;

    }

    const { data, error } =
        await sb.auth.verifyOtp({

            email: pendingEmail,

            token,

            type: "email"

        });

    if (error) {

        showMessage(
            error.message,
            "error"
        );

        return;

    }

    showMessage(
        "Verified.",
        "success"
    );

    window.location.href = await destinationFor(data.user.id);

});

// ======================================================
// RESEND OTP
// ======================================================

document
    .getElementById("resend-otp")
    .addEventListener("click", async () => {

        if (!pendingEmail) {

            showMessage(
                "Please enter your email first.",
                "error"
            );

            return;

        }

        showMessage("Sending new verification code...");

        const { error } = await sendCode(pendingEmail);

        if (error) {

            showMessage(
                error.message,
                "error"
            );

            return;

        }

        showMessage(
            "A new verification code has been sent.",
            "success"
        );

    });

// ======================================================
// LOGOUT
// ======================================================

async function logout() {

    await sb.auth.signOut();

    window.location.href = "index.html";

}

window.logout = logout;
