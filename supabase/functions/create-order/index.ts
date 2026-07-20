// ============================================================================
// create-order — reserve an order from the caller's active cart
// ============================================================================
//
// This function is the only thing in the system allowed to decide what a
// customer owes. It ignores any amount the browser might send, reads the
// cart's package/colour/addon IDs, looks up current catalog prices, and
// computes the total itself.
//
// It runs with the service role key, which bypasses RLS — so it must verify
// the caller's JWT first and scope every query to that user. A mistake here
// is a mistake that lets one customer read or order against another's cart.
//
// Deploy:
//   supabase functions deploy create-order
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Flat refundable reservation fee, GST inclusive. Not a percentage: the same
// ₹8,999 secures a ₹1.6L order and a ₹6L one, because it covers the site
// verification visit rather than a share of the job.
const ADVANCE_PAISE = Number(Deno.env.get("ADVANCE_PAISE") ?? "899900");

// GST on package prices, which are quoted exclusive. Stored on each order
// alongside the amount it produced, so a rate change never rewrites history.
const GST_PERCENT = Number(Deno.env.get("GST_PERCENT") ?? "18");

// SITE_ORIGIN takes a COMMA-SEPARATED allowlist, so one deployment can serve
// local development and production without swapping secrets:
//
//   supabase secrets set SITE_ORIGIN=http://localhost:8000,https://safecreatives.com
//
// Access-Control-Allow-Origin may name exactly one origin -- returning the
// whole list is rejected by every browser -- so the caller's origin is echoed
// back when it appears on the list. Vary: Origin stops a cache from serving
// one origin's response to another.
//
// Unset means "*", which is right for local work and too loose for
// production.
function corsHeadersFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get("SITE_ORIGIN") ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const requestOrigin = req.headers.get("Origin") ?? "";

  const allowOrigin = configured.includes("*")
    ? "*"
    : configured.includes(requestOrigin)
    ? requestOrigin
    : configured[0] ?? "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    // supabase-js sends apikey and x-client-info alongside authorization.
    // Omitting them fails preflight before the request is ever made.
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // ----------------------------------------------------------------
  // 1. Identify the caller
  // ----------------------------------------------------------------

  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const { data: userResult, error: userError } = await admin.auth.getUser(token);
  if (userError || !userResult?.user) {
    return json({ error: "Not signed in" }, 401);
  }
  const userId = userResult.user.id;

  // ----------------------------------------------------------------
  // 2. Load the caller's active cart
  // ----------------------------------------------------------------
  // Every query below is filtered by userId. The service role would happily
  // return someone else's rows otherwise.

  // Check the error, not just the data. A failed query also returns null
  // data, so skipping this reports every backend failure as "empty cart" and
  // sends you looking in entirely the wrong place.
  const { data: cart, error: cartError } = await admin
    .from("carts")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (cartError) {
    console.error("Cart lookup failed for user", userId, cartError);
    return json(
      { error: `Could not read your cart: ${cartError.message}` },
      500
    );
  }

  if (!cart) {
    return json(
      { error: "You have no active cart. Add a package and try again." },
      400
    );
  }

  console.log("Reserving from cart", cart.id, "for user", userId);

  const { data: items, error: itemsError } = await admin
    .from("cart_items")
    .select(
      `id,
       packages ( key, name, base_price_paise, hsn_code ),
       cart_item_options (
         product_option_groups ( name, package_products ( name ) ),
         product_options ( name, finish, material, price_delta_paise )
       ),
       cart_item_addons ( package_addons ( key, name, price_paise, hsn_code ) )`
    )
    .eq("cart_id", cart.id)
    .order("created_at");

  if (itemsError) {
    console.error("Cart item lookup failed for cart", cart.id, itemsError);
    return json(
      { error: `Could not read your cart contents: ${itemsError.message}` },
      500
    );
  }

  if (!items?.length) {
    return json(
      { error: "Your cart has no packages in it. Add one and try again." },
      400
    );
  }

  console.log("Cart", cart.id, "has", items.length, "item(s)");

  // ----------------------------------------------------------------
  // 3. Load the profile for the contact/delivery snapshot
  // ----------------------------------------------------------------

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select(
      "full_name, email, phone, address_line, city, state_name, state_code, pin_code, gstin"
    )
    .eq("id", userId)
    .maybeSingle();

  if (profileError) {
    console.error("Profile lookup failed for user", userId, profileError);
    return json(
      { error: `Could not read your profile: ${profileError.message}` },
      500
    );
  }

  if (!profile) {
    return json(
      { error: "Your profile could not be found. Please sign out and back in." },
      400
    );
  }

  // State included: it decides the CGST/SGST vs IGST split on the invoice,
  // so an order without it cannot be invoiced correctly.
  if (
    !profile.address_line ||
    !profile.city ||
    !profile.state_code ||
    !profile.pin_code
  ) {
    return json(
      {
        error:
          "Please add your full delivery address, city, state and PIN code before reserving.",
      },
      400
    );
  }

  // ----------------------------------------------------------------
  // 4. Compute the total from catalog prices
  // ----------------------------------------------------------------

  let subtotalPaise = 0;
  const lines = items.map((item) => {
    const pkg = item.packages;
    const optionDelta = (item.cart_item_options ?? []).reduce(
      (sum, c) => sum + Number(c.product_options?.price_delta_paise ?? 0),
      0
    );
    const addonTotal = (item.cart_item_addons ?? []).reduce(
      (sum, a) => sum + Number(a.package_addons?.price_paise ?? 0),
      0
    );
    const lineTotal = Number(pkg.base_price_paise) + optionDelta + addonTotal;
    subtotalPaise += lineTotal;

    return { item, pkg, lineTotal };
  });

  const gstPaise = Math.round((subtotalPaise * GST_PERCENT) / 100);
  const totalPaise = subtotalPaise + gstPaise;

  // Flat, and capped at the order total so a cheap order can never be asked
  // for more up front than the whole thing costs.
  const advanceAmountPaise = Math.min(ADVANCE_PAISE, totalPaise);

  // ----------------------------------------------------------------
  // 5. Terms acceptance
  // ----------------------------------------------------------------
  // The browser tells us WHICH version it displayed; we check that against
  // the current one. Accepting stale terms means the customer read something
  // other than what is in force, so it is refused rather than recorded.

  let requestBody: Record<string, unknown> = {};
  try {
    requestBody = await req.json();
  } catch {
    // No body is fine for other callers; the check below still applies.
  }

  const acceptedTermsId = requestBody.terms_version_id as string | undefined;

  const { data: currentTerms } = await admin
    .from("terms_versions")
    .select("id, version")
    .eq("is_current", true)
    .maybeSingle();

  if (!currentTerms) {
    return json(
      { error: "No terms and conditions are published. Please contact us." },
      500
    );
  }

  if (!acceptedTermsId || acceptedTermsId !== currentTerms.id) {
    return json(
      {
        error:
          "Please read and accept the current terms and conditions before reserving.",
        terms_version_id: currentTerms.id,
      },
      400
    );
  }

  // ----------------------------------------------------------------
  // 6. Write the order, snapshotting every name and price
  // ----------------------------------------------------------------

  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      user_id: userId,
      subtotal_paise: subtotalPaise,
      gst_percent: GST_PERCENT,
      gst_paise: gstPaise,
      total_paise: totalPaise,
      advance_amount_paise: advanceAmountPaise,
      contact_name: profile.full_name,
      contact_email: profile.email,
      contact_phone: profile.phone,
      delivery_address_line: profile.address_line,
      delivery_city: profile.city,
      delivery_state_name: profile.state_name,
      delivery_state_code: profile.state_code,
      delivery_pin_code: profile.pin_code,
    })
    .select(
      "id, order_number, subtotal_paise, gst_paise, total_paise, advance_amount_paise, status"
    )
    .single();

  if (orderError) return json({ error: orderError.message }, 500);

  // Recorded against the order so there is a permanent link between what was
  // agreed and what was bought.
  await admin.from("terms_acceptances").insert({
    user_id: userId,
    terms_version_id: currentTerms.id,
    order_id: order.id,
  });

  for (const { item, pkg, lineTotal } of lines) {
    const { data: orderItem, error: lineError } = await admin
      .from("order_items")
      .insert({
        order_id: order.id,
        package_key: pkg.key,
        package_name: pkg.name,
        // Snapshot, like everything else on an order: the invoice must carry
        // the HSN that applied at order time, not whatever admin says later.
        hsn_code: pkg.hsn_code ?? null,
        base_price_paise: pkg.base_price_paise,
        line_total_paise: lineTotal,
      })
      .select("id")
      .single();

    if (lineError) return json({ error: lineError.message }, 500);

    const optionRows = (item.cart_item_options ?? []).map((c) => ({
      order_item_id: orderItem.id,
      product_name: c.product_option_groups?.package_products?.name ?? "",
      group_name: c.product_option_groups?.name ?? "",
      option_name: c.product_options?.name ?? "",
      finish: c.product_options?.finish ?? null,
      material: c.product_options?.material ?? null,
      price_delta_paise: Number(c.product_options?.price_delta_paise ?? 0),
    }));
    if (optionRows.length) {
      await admin.from("order_item_options").insert(optionRows);
    }

    const addonRows = (item.cart_item_addons ?? []).map((a) => ({
      order_item_id: orderItem.id,
      addon_key: a.package_addons?.key ?? "",
      addon_name: a.package_addons?.name ?? "",
      hsn_code: a.package_addons?.hsn_code ?? null,
      price_paise: Number(a.package_addons?.price_paise ?? 0),
    }));
    if (addonRows.length) {
      await admin.from("order_item_addons").insert(addonRows);
    }
  }

  // ----------------------------------------------------------------
  // 7. Open a payment session with Razorpay
  // ----------------------------------------------------------------
  // The amount sent here is the one computed above from catalog prices.
  // Nothing the browser submitted influences it.

  const razorpayKeyId = Deno.env.get("RAZORPAY_KEY_ID");
  const razorpayKeySecret = Deno.env.get("RAZORPAY_KEY_SECRET");

  let razorpayOrderId: string | null = null;

  if (razorpayKeyId && razorpayKeySecret) {
    try {
      const rzpResponse = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${razorpayKeyId}:${razorpayKeySecret}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: advanceAmountPaise,
          currency: "INR",
          // Razorpay caps receipt at 40 characters.
          receipt: order.order_number.slice(0, 40),
          notes: {
            order_id: order.id,
            order_number: order.order_number,
            user_id: userId,
          },
        }),
      });

      const rzpBody = await rzpResponse.json();

      if (!rzpResponse.ok) {
        throw new Error(
          rzpBody?.error?.description ?? `Razorpay returned ${rzpResponse.status}`
        );
      }

      razorpayOrderId = rzpBody.id;

      const { error: paymentError } = await admin.from("payments").insert({
        order_id: order.id,
        user_id: userId,
        provider: "razorpay",
        provider_order_id: razorpayOrderId,
        purpose: "advance",
        amount_paise: advanceAmountPaise,
        currency: "INR",
        status: "created",
      });

      if (paymentError) throw new Error(paymentError.message);
    } catch (paymentSetupError) {
      // Roll the order back rather than leaving a reservation the customer
      // has no way to pay for. order_items and their children cascade.
      await admin.from("orders").delete().eq("id", order.id);
      return json(
        {
          error:
            `Could not start payment: ${paymentSetupError.message}. ` +
            `Nothing has been charged and your cart is unchanged.`,
        },
        502
      );
    }
  }

  // ----------------------------------------------------------------
  // 8. Retire the cart
  // ----------------------------------------------------------------
  // Only once the order and its payment session exist. Doing this earlier
  // would empty the cart on a failed reservation.
  //
  // Marking it 'ordered' frees the one-active-cart-per-user index, so the
  // customer's next visit starts a fresh cart rather than editing an order.

  await admin.from("carts").update({ status: "ordered" }).eq("id", cart.id);

  // ----------------------------------------------------------------
  // 9. Hand the session back
  // ----------------------------------------------------------------
  // razorpay_key_id is the PUBLIC key and is safe in the browser, exactly
  // like the Supabase anon key. The secret never leaves this function.
  //
  // The order stays 'pending_advance' until payment-webhook verifies a
  // signed callback from Razorpay. It is never marked paid from the browser:
  // anything the checkout page can call, a customer can call directly.

  return json({
    order_number: order.order_number,
    status: order.status,
    subtotal_paise: order.subtotal_paise,
    gst_paise: order.gst_paise,
    total_paise: order.total_paise,
    advance_amount_paise: order.advance_amount_paise,
    currency: "INR",
    razorpay_key_id: razorpayOrderId ? razorpayKeyId : null,
    razorpay_order_id: razorpayOrderId,
  });
});
