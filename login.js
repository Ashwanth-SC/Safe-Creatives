// ======================================================
// SAFE CREATIVES LOGIN
// Supabase Email OTP Authentication
// ======================================================

const nextPage =
    new URLSearchParams(window.location.search).get("next") ||
    "index.html";

const detailsSection = document.getElementById("details-section");
const otpSection = document.getElementById("otp-section");

const detailsForm = document.getElementById("details-form");
const otpForm = document.getElementById("otp-form");

const message = document.getElementById("auth-message");

let pendingUser = {};

// ======================================================
// Already Logged In?
// ======================================================

(async () => {

    const {
        data: { session }
    } = await supabase.auth.getSession();

    if (session) {
        window.location.replace(nextPage);
    }

})();

// ======================================================
// Auth State Listener
// ======================================================

supabase.auth.onAuthStateChange((event) => {

    console.log("Auth Event:", event);

});

// ======================================================
// Helper
// ======================================================

function showMessage(text, type = "") {

    message.textContent = text;
    message.className = `form-message ${type}`;

}

// ======================================================
// SEND OTP
// ======================================================

detailsForm.addEventListener("submit", async (e) => {

    e.preventDefault();

    const fullName = document
        .getElementById("full-name")
        .value
        .trim();

    const phone = document
        .getElementById("phone")
        .value
        .trim();

    const email = document
        .getElementById("email")
        .value
        .trim()
        .toLowerCase();

    if (!fullName || !phone || !email) {

        showMessage(
            "Please fill all fields.",
            "error"
        );

        return;

    }

    pendingUser = {
        fullName,
        phone,
        email
    };

    showMessage("Sending verification code...");

    const { error } = await supabase.auth.signInWithOtp({

        email,

        options: {
            shouldCreateUser: true
        }

    });

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
        "Verification code sent to your email.",
        "success"
    );

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
            "Enter the 6 digit verification code.",
            "error"
        );

        return;

    }

    const { data, error } =
        await supabase.auth.verifyOtp({

            email: pendingUser.email,

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

    const user = data.user;

    // Check whether profile exists

    const {
        data: existingProfile,
        error: selectError
    } = await supabase
        .from("profiles")
        .select("id")
        .eq("id", user.id)
        .maybeSingle();

    if (selectError) {

        showMessage(
            selectError.message,
            "error"
        );

        return;

    }

    if (existingProfile) {

        const { error: updateError } =
            await supabase
                .from("profiles")
                .update({

                    full_name: pendingUser.fullName,
                    phone: pendingUser.phone,
                    email: pendingUser.email

                })
                .eq("id", user.id);

        if (updateError) {

            showMessage(
                updateError.message,
                "error"
            );

            return;

        }

    } else {

        const { error: insertError } =
            await supabase
                .from("profiles")
                .insert({

                    id: user.id,
                    full_name: pendingUser.fullName,
                    phone: pendingUser.phone,
                    email: pendingUser.email

                });

        if (insertError) {

            showMessage(
                insertError.message,
                "error"
            );

            return;

        }

    }

    showMessage(
        "Login successful!",
        "success"
    );

    setTimeout(() => {

        window.location.href = nextPage;

    }, 700);

});

// ======================================================
// RESEND OTP
// ======================================================

document
    .getElementById("resend-otp")
    .addEventListener("click", async () => {

        if (!pendingUser.email) {

            showMessage(
                "Please enter your details first.",
                "error"
            );

            return;

        }

        showMessage("Sending new verification code...");

        const { error } =
            await supabase.auth.signInWithOtp({

                email: pendingUser.email,

                options: {
                    shouldCreateUser: true
                }

            });

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

    await supabase.auth.signOut();

    window.location.href = "index.html";

}

window.logout = logout;