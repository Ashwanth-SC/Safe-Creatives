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

// Refundable advance taken to reserve an order. Keep in sync with
// ADVANCE_PERCENT in checkout.js, which only displays it.
const ADVANCE_PERCENT = Number(Deno.env.get("ADVANCE_PERCENT") ?? "20");

const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("SITE_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
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

  const { data: cart } = await admin
    .from("carts")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (!cart) return json({ error: "Your cart is empty" }, 400);

  const { data: items, error: itemsError } = await admin
    .from("cart_items")
    .select(
      `id,
       packages ( key, name, base_price_paise ),
       cart_item_colours ( package_products ( name ),
                           product_colours ( name, finish, material, price_delta_paise ) ),
       cart_item_addons ( package_addons ( key, name, price_paise ) )`
    )
    .eq("cart_id", cart.id)
    .order("created_at");

  if (itemsError) return json({ error: itemsError.message }, 500);
  if (!items?.length) return json({ error: "Your cart is empty" }, 400);

  // ----------------------------------------------------------------
  // 3. Load the profile for the contact/delivery snapshot
  // ----------------------------------------------------------------

  const { data: profile } = await admin
    .from("profiles")
    .select("full_name, email, phone, address")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.address) {
    return json(
      { error: "Please add a delivery address to your profile before reserving." },
      400
    );
  }

  // ----------------------------------------------------------------
  // 4. Compute the total from catalog prices
  // ----------------------------------------------------------------

  let subtotalPaise = 0;
  const lines = items.map((item) => {
    const pkg = item.packages;
    const colourDelta = (item.cart_item_colours ?? []).reduce(
      (sum, c) => sum + Number(c.product_colours?.price_delta_paise ?? 0),
      0
    );
    const addonTotal = (item.cart_item_addons ?? []).reduce(
      (sum, a) => sum + Number(a.package_addons?.price_paise ?? 0),
      0
    );
    const lineTotal = Number(pkg.base_price_paise) + colourDelta + addonTotal;
    subtotalPaise += lineTotal;

    return { item, pkg, lineTotal };
  });

  const advanceAmountPaise = Math.round(
    (subtotalPaise * ADVANCE_PERCENT) / 100
  );

  // ----------------------------------------------------------------
  // 5. Write the order, snapshotting every name and price
  // ----------------------------------------------------------------

  const { data: order, error: orderError } = await admin
    .from("orders")
    .insert({
      user_id: userId,
      subtotal_paise: subtotalPaise,
      advance_percent: ADVANCE_PERCENT,
      advance_amount_paise: advanceAmountPaise,
      contact_name: profile.full_name,
      contact_email: profile.email,
      contact_phone: profile.phone,
      delivery_address: profile.address,
    })
    .select("id, order_number, subtotal_paise, advance_amount_paise, status")
    .single();

  if (orderError) return json({ error: orderError.message }, 500);

  for (const { item, pkg, lineTotal } of lines) {
    const { data: orderItem, error: lineError } = await admin
      .from("order_items")
      .insert({
        order_id: order.id,
        package_key: pkg.key,
        package_name: pkg.name,
        base_price_paise: pkg.base_price_paise,
        line_total_paise: lineTotal,
      })
      .select("id")
      .single();

    if (lineError) return json({ error: lineError.message }, 500);

    const colourRows = (item.cart_item_colours ?? []).map((c) => ({
      order_item_id: orderItem.id,
      product_name: c.package_products?.name ?? "",
      colour_name: c.product_colours?.name ?? "",
      finish: c.product_colours?.finish ?? null,
      material: c.product_colours?.material ?? null,
      price_delta_paise: Number(c.product_colours?.price_delta_paise ?? 0),
    }));
    if (colourRows.length) {
      await admin.from("order_item_colours").insert(colourRows);
    }

    const addonRows = (item.cart_item_addons ?? []).map((a) => ({
      order_item_id: orderItem.id,
      addon_key: a.package_addons?.key ?? "",
      addon_name: a.package_addons?.name ?? "",
      price_paise: Number(a.package_addons?.price_paise ?? 0),
    }));
    if (addonRows.length) {
      await admin.from("order_item_addons").insert(addonRows);
    }
  }

  // ----------------------------------------------------------------
  // 6. Open a payment session with Razorpay
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
  // 7. Retire the cart
  // ----------------------------------------------------------------
  // Only once the order and its payment session exist. Doing this earlier
  // would empty the cart on a failed reservation.
  //
  // Marking it 'ordered' frees the one-active-cart-per-user index, so the
  // customer's next visit starts a fresh cart rather than editing an order.

  await admin.from("carts").update({ status: "ordered" }).eq("id", cart.id);

  // ----------------------------------------------------------------
  // 8. Hand the session back
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
    advance_amount_paise: order.advance_amount_paise,
    currency: "INR",
    razorpay_key_id: razorpayOrderId ? razorpayKeyId : null,
    razorpay_order_id: razorpayOrderId,
  });
});
