// ============================================================================
// create-installment-link — admin sends a Razorpay payment link for an
// installment (80% confirmation, or 20% dispatch balance)
// ============================================================================
//
// The amount is computed here from the order's CURRENT balance, never from the
// browser: confirmation = 80% of balance, dispatch = the remaining 20%. Razorpay
// emails the link to the customer. When it is paid, payment-webhook marks the
// installment paid and emails a receipt.
//
// Any earlier unpaid link for the same phase (e.g. created before the order was
// revised) is cancelled first, so the customer can never pay a stale amount.
//
// Deploy:
//   supabase functions deploy create-installment-link
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
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const PHASE_LABEL: Record<string, string> = {
  confirmation: "Confirmation (80%)",
  dispatch: "Balance on dispatch (20%)",
};

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

  // --- Caller must be a signed-in admin --------------------------------------
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);
  const { data: userResult, error: userError } = await admin.auth.getUser(token);
  if (userError || !userResult?.user) return json({ error: "Not signed in" }, 401);
  const { data: me } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", userResult.user.id)
    .maybeSingle();
  if (!me?.is_admin) return json({ error: "Admins only" }, 403);

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
      `id, order_number, status, user_id,
       total_paise, advance_amount_paise, balance_paise,
       confirmation_paid_at, dispatch_paid_at,
       contact_name, contact_email, contact_phone`
    )
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return json({ error: orderError.message }, 500);
  if (!order) return json({ error: "Order not found" }, 404);

  if (order.status === "pending_advance") {
    return json({ error: "The advance has not been paid yet." }, 400);
  }
  if (phase === "confirmation" && order.confirmation_paid_at) {
    return json({ error: "The confirmation installment is already paid." }, 400);
  }
  if (phase === "dispatch" && order.dispatch_paid_at) {
    return json({ error: "The dispatch installment is already paid." }, 400);
  }
  if (!order.contact_email) {
    return json({ error: "This order has no email to send the link to." }, 400);
  }

  // Confirmation = 80% of the balance; dispatch = the remaining 20%. The 80%
  // slice is floored to whole rupees so the link charges a clean figure; the
  // dispatch slice takes the exact remainder, so the two still sum to the balance.
  const balance = Number(order.balance_paise || 0);
  const confirmation = Math.floor((balance * 0.8) / 100) * 100;
  const amountPaise = phase === "confirmation" ? confirmation : balance - confirmation;
  if (amountPaise <= 0) return json({ error: "Nothing left to collect for this phase." }, 400);

  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) {
    return json({ error: "Razorpay is not configured on the server." }, 500);
  }
  const rzpAuth = `Basic ${btoa(`${keyId}:${keySecret}`)}`;

  // --- Cancel any earlier unpaid link for this phase (stale amount) ----------
  const { data: stale } = await admin
    .from("installment_links")
    .select("id, provider_link_id")
    .eq("order_id", orderId)
    .eq("phase", phase)
    .eq("status", "created");

  for (const link of stale ?? []) {
    if (link.provider_link_id) {
      try {
        await fetch(
          `https://api.razorpay.com/v1/payment_links/${link.provider_link_id}/cancel`,
          { method: "POST", headers: { Authorization: rzpAuth } }
        );
      } catch (_ignored) {
        // If Razorpay refuses (already paid/cancelled), our status update below
        // and the webhook still keep things consistent.
      }
    }
    await admin.from("installment_links").update({ status: "cancelled" }).eq("id", link.id);
  }

  // --- Create the payment link ----------------------------------------------
  const description =
    `Safe Creatives — ${PHASE_LABEL[phase]} for order ${order.order_number}`.slice(0, 2048);

  const linkResponse = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: { Authorization: rzpAuth, "Content-Type": "application/json" },
    body: JSON.stringify({
      amount: amountPaise,
      currency: "INR",
      accept_partial: false,
      description,
      customer: {
        name: order.contact_name ?? undefined,
        email: order.contact_email,
        contact: order.contact_phone ?? undefined,
      },
      notify: { email: true, sms: false },
      reminder_enable: true,
      notes: { order_id: order.id, order_number: order.order_number, phase },
    }),
  });

  const linkBody = await linkResponse.json();
  if (!linkResponse.ok) {
    return json(
      { error: linkBody?.error?.description ?? `Razorpay returned ${linkResponse.status}` },
      502
    );
  }

  const { error: insertError } = await admin.from("installment_links").insert({
    order_id: order.id,
    phase,
    provider: "razorpay",
    provider_link_id: linkBody.id,
    amount_paise: amountPaise,
    short_url: linkBody.short_url,
    status: "created",
  });
  if (insertError) return json({ error: insertError.message }, 500);

  return json({
    status: "sent",
    phase,
    amount_paise: amountPaise,
    short_url: linkBody.short_url,
    emailed_to: order.contact_email,
  });
});
