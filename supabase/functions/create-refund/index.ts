// ============================================================================
// create-refund — admin initiates a Razorpay refund against a captured payment
// ============================================================================
//
// A refund is always made against a specific captured payment (the advance, or
// an installment), full or partial. This function verifies the caller is an
// admin, checks the requested amount does not exceed the un-refunded remainder,
// calls Razorpay's refund API, and records a `refunds` row as 'pending'.
//
// payment-webhook (refund.processed / refund.failed) finalizes the status and,
// only when the whole order is fully refunded, marks the order 'refunded'.
//
// Deploy:
//   supabase functions deploy create-refund
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
  const paymentId: string | undefined = body.payment_id;
  const reason: string | null = body.reason ? String(body.reason).slice(0, 500) : null;
  if (!paymentId) return json({ error: "payment_id is required" }, 400);

  // --- Load the payment ------------------------------------------------------
  const { data: payment, error: paymentError } = await admin
    .from("payments")
    .select("id, order_id, provider, provider_payment_id, amount_paise, status")
    .eq("id", paymentId)
    .maybeSingle();
  if (paymentError) return json({ error: paymentError.message }, 500);
  if (!payment) return json({ error: "Payment not found" }, 404);

  if (payment.provider !== "razorpay" || !payment.provider_payment_id) {
    return json({ error: "This payment has no Razorpay payment to refund." }, 400);
  }
  if (payment.status !== "captured") {
    return json({ error: `Only captured payments can be refunded (this one is '${payment.status}').` }, 400);
  }

  // --- Amount (default = the full un-refunded remainder) ---------------------
  const captured = Number(payment.amount_paise);

  const { data: priorRefunds } = await admin
    .from("refunds")
    .select("amount_paise, status")
    .eq("payment_id", payment.id)
    .in("status", ["pending", "processed"]);
  const alreadyRefunded = (priorRefunds ?? []).reduce(
    (sum, r) => sum + Number(r.amount_paise || 0),
    0
  );
  const remaining = captured - alreadyRefunded;
  if (remaining <= 0) {
    return json({ error: "This payment is already fully refunded." }, 400);
  }

  const requested = body.amount_paise != null ? Number(body.amount_paise) : remaining;
  if (!Number.isFinite(requested) || requested <= 0) {
    return json({ error: "Refund amount must be a positive number of paise." }, 400);
  }
  if (requested > remaining) {
    return json(
      { error: `Refund exceeds the refundable remainder (₹${(remaining / 100).toLocaleString("en-IN")}).` },
      400
    );
  }

  // --- Call Razorpay ---------------------------------------------------------
  const keyId = Deno.env.get("RAZORPAY_KEY_ID");
  const keySecret = Deno.env.get("RAZORPAY_KEY_SECRET");
  if (!keyId || !keySecret) {
    return json({ error: "Razorpay is not configured on the server." }, 500);
  }

  let refundEntity: { id: string; status?: string };
  try {
    const rzpResponse = await fetch(
      `https://api.razorpay.com/v1/payments/${payment.provider_payment_id}/refund`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${keyId}:${keySecret}`)}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: requested,
          notes: reason ? { reason } : undefined,
        }),
      }
    );
    const rzpBody = await rzpResponse.json();
    if (!rzpResponse.ok) {
      throw new Error(
        rzpBody?.error?.description ?? `Razorpay returned ${rzpResponse.status}`
      );
    }
    refundEntity = rzpBody;
  } catch (rzpError) {
    return json({ error: `Refund failed at Razorpay: ${(rzpError as Error).message}` }, 502);
  }

  // --- Record it (pending; the webhook finalizes on refund.processed) --------
  // The refund webhook is idempotent on provider_refund_id, so if it arrives
  // before this insert commits it simply updates the same row.
  const { data: existing } = await admin
    .from("refunds")
    .select("id")
    .eq("provider_refund_id", refundEntity.id)
    .maybeSingle();

  const row = {
    payment_id: payment.id,
    provider_refund_id: refundEntity.id,
    amount_paise: requested,
    status: refundEntity.status === "processed" ? "processed" : "pending",
    reason,
  };
  if (existing) {
    await admin.from("refunds").update(row).eq("id", existing.id);
  } else {
    await admin.from("refunds").insert(row);
  }

  return json({
    status: "refund_initiated",
    provider_refund_id: refundEntity.id,
    amount_paise: requested,
    payment_id: payment.id,
  });
});
