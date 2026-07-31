// ============================================================================
// create-installment-order — open an inline Razorpay order for an installment
// ============================================================================
//
// The customer pays the 2nd (confirmation, 80%) or 3rd (dispatch, 20%)
// installment themselves from the Track Order page, via the same inline
// Razorpay popup as the advance. This function creates a Razorpay ORDER and a
// matching `payments` row; payment-webhook (payment.captured) then marks the
// installment paid, raises the final invoice on dispatch, and emails the
// customer — exactly the finalization the admin "send payment link" path uses.
//
// The amount is computed here from the order's CURRENT balance, never from the
// browser. A customer may only pay their own order, and only once the admin has
// advanced the milestone that unlocks that installment. An admin may open one
// for any order without the milestone gate (parity with create-installment-link).
//
// Deploy:
//   supabase functions deploy create-installment-order
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeadersFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get("SITE_ORIGIN") ?? "*")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  const allow = configured.includes("*")
    ? "*"
    : configured.includes(origin)
    ? origin
    : configured[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers":
      "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

// Which fulfillment stages unlock each installment for the customer. The admin
// advances fulfillment_stage from the dashboard; ticking "Confirmed" unlocks the
// confirmation installment, "Ready to dispatch" (stage 'dispatch') unlocks the
// final one — the customer pays before we ship.
const CONFIRMATION_STAGES = ["confirmed", "production", "dispatch", "delivered", "installed"];
const DISPATCH_STAGES = ["dispatch", "delivered", "installed"];

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  // --- Identify the caller ---------------------------------------------------
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);
  const { data: userResult, error: userError } = await admin.auth.getUser(token);
  if (userError || !userResult?.user) return json({ error: "Not signed in" }, 401);
  const userId = userResult.user.id;

  const { data: me } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  const isAdmin = Boolean(me?.is_admin);

  // --- Input -----------------------------------------------------------------
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed request body" }, 400);
  }
  const orderId: string | undefined = body.order_id;
  const phase: string = body.phase;
  if (!orderId) return json({ error: "order_id is required" }, 400);
  if (phase !== "confirmation" && phase !== "dispatch") {
    return json({ error: "phase must be 'confirmation' or 'dispatch'" }, 400);
  }

  // --- Load the order --------------------------------------------------------
  const { data: order, error: orderError } = await admin
    .from("orders")
    .select(
      `id, order_number, status, user_id, fulfillment_stage,
       balance_paise, confirmation_paid_at, dispatch_paid_at,
       contact_name, contact_email, contact_phone`
    )
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return json({ error: orderError.message }, 500);
  if (!order) return json({ error: "Order not found" }, 404);

  // Ownership: a customer may only pay their own order; an admin may pay any.
  if (!isAdmin && order.user_id !== userId) {
    return json({ error: "This is not your order." }, 403);
  }

  // --- Guards (payment state) ------------------------------------------------
  if (order.status === "pending_advance") {
    return json({ error: "The advance has not been paid yet." }, 400);
  }
  if (order.status === "cancelled" || order.status === "refunded") {
    return json({ error: "This order is closed." }, 400);
  }
  if (phase === "confirmation" && order.confirmation_paid_at) {
    return json({ error: "The confirmation installment is already paid." }, 400);
  }
  if (phase === "dispatch" && order.dispatch_paid_at) {
    return json({ error: "The final installment is already paid." }, 400);
  }

  // --- Milestone gate (customers only; admins bypass) ------------------------
  if (!isAdmin) {
    if (phase === "confirmation" && !CONFIRMATION_STAGES.includes(order.fulfillment_stage)) {
      return json(
        { error: "This installment unlocks once your order is confirmed." },
        403
      );
    }
    if (phase === "dispatch") {
      if (!DISPATCH_STAGES.includes(order.fulfillment_stage)) {
        return json(
          { error: "The final installment unlocks once your order is ready to dispatch." },
          403
        );
      }
      if (!order.confirmation_paid_at) {
        return json(
          { error: "Please pay the confirmation installment first." },
          400
        );
      }
    }
  }

  // --- Amount ----------------------------------------------------------------
  // Confirmation = 80% of the balance floored to whole rupees; dispatch = the
  // exact remainder, so the two always sum to the balance.
  const balance = Number(order.balance_paise || 0);
  const confirmation = Math.floor((balance * 0.8) / 100) * 100;
  const amountPaise = phase === "confirmation" ? confirmation : balance - confirmation;
  if (amountPaise <= 0) {
    return json({ error: "Nothing left to collect for this phase." }, 400);
  }

  // --- Razorpay order --------------------------------------------------------
  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) {
    return json({ error: "Razorpay is not configured on the server." }, 500);
  }

  let razorpayOrderId: string;
  try {
    const rzpResponse = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: "INR",
        receipt: `${order.order_number}-${phase}`.slice(0, 40),
        notes: {
          order_id: order.id,
          order_number: order.order_number,
          phase,
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
  } catch (rzpError) {
    return json({ error: `Could not start payment: ${(rzpError as Error).message}` }, 502);
  }

  // Retire any earlier un-captured attempt for this phase, so the payments panel
  // does not accumulate stale 'created' rows. Captured/failed rows are untouched.
  await admin
    .from("payments")
    .update({ status: "cancelled" })
    .eq("order_id", order.id)
    .eq("purpose", phase)
    .eq("status", "created");

  const { error: paymentError } = await admin.from("payments").insert({
    order_id: order.id,
    user_id: order.user_id,
    provider: "razorpay",
    provider_order_id: razorpayOrderId,
    purpose: phase,
    amount_paise: amountPaise,
    currency: "INR",
    status: "created",
  });
  if (paymentError) return json({ error: paymentError.message }, 500);

  return json({
    status: "created",
    phase,
    amount_paise: amountPaise,
    currency: "INR",
    razorpay_key_id: keyId,
    razorpay_order_id: razorpayOrderId,
    order_number: order.order_number,
    contact_name: order.contact_name,
    contact_email: order.contact_email,
    contact_phone: order.contact_phone,
  });
});
