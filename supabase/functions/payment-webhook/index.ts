// ============================================================================
// payment-webhook — the only thing that may mark an order paid
// ============================================================================
//
// Razorpay calls this server-to-server after a payment settles. It is the
// sole authority on payment status: the browser's success callback is a
// navigation hint and nothing more, because a customer can invoke anything
// the checkout page can invoke.
//
// Three rules this file exists to enforce:
//
//   1. Verify the HMAC signature against the RAW request body before
//      trusting a single field. Parsing first and verifying later is the
//      classic way to get this wrong -- re-serialised JSON will not match
//      the signature Razorpay computed.
//
//   2. Log every event to payment_events BEFORE acting on it. The unique
//      constraint on (provider, provider_event_id) makes replays harmless,
//      and a crash mid-processing leaves the payload on disk to retry.
//
//   3. Never trust the amount in the payload as the amount owed. It is
//      checked against the payments row this system created.
//
// IMPORTANT -- deploy with JWT verification OFF. Razorpay does not send a
// Supabase JWT, so the default gateway auth would reject every callback:
//
//   supabase functions deploy payment-webhook --no-verify-jwt
//
// The signature check below is what secures this endpoint instead.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Constant-time comparison. A plain === leaks how much of the signature
// matched via timing, which is enough to forge one given enough attempts.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function isSignatureValid(
  rawBody: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(rawBody)
  );
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqual(expected, signature);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const webhookSecret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");
  if (!webhookSecret) {
    console.error("RAZORPAY_WEBHOOK_SECRET is not set; rejecting.");
    return json({ error: "Webhook not configured" }, 500);
  }

  // Read the body as text exactly once. Anything else breaks the signature.
  const rawBody = await req.text();
  const signature = req.headers.get("x-razorpay-signature") ?? "";
  const eventId = req.headers.get("x-razorpay-event-id") ?? "";

  if (!(await isSignatureValid(rawBody, signature, webhookSecret))) {
    console.warn("Rejected webhook with bad signature.");
    return json({ error: "Invalid signature" }, 401);
  }

  let event: Record<string, any>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return json({ error: "Malformed JSON" }, 400);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } }
  );

  const eventType: string = event.event ?? "unknown";
  const paymentEntity = event.payload?.payment?.entity ?? null;
  const refundEntity = event.payload?.refund?.entity ?? null;

  // ------------------------------------------------------------------
  // Record first, act second
  // ------------------------------------------------------------------
  // Razorpay retries on non-2xx and can deliver the same event more than
  // once. A duplicate hits the unique constraint, which we treat as success
  // rather than an error -- the work was already done.

  const { data: logged, error: logError } = await admin
    .from("payment_events")
    .insert({
      provider: "razorpay",
      provider_event_id: eventId || `${eventType}:${paymentEntity?.id ?? refundEntity?.id ?? crypto.randomUUID()}`,
      event_type: eventType,
      payload: event,
    })
    .select("id")
    .maybeSingle();

  if (logError) {
    if (logError.code === "23505") {
      return json({ status: "already processed" }, 200);
    }
    console.error("Could not log payment event:", logError.message);
    return json({ error: "Could not record event" }, 500);
  }

  async function markProcessed(errorText: string | null = null) {
    if (!logged?.id) return;
    await admin
      .from("payment_events")
      .update({ processed_at: new Date().toISOString(), process_error: errorText })
      .eq("id", logged.id);
  }

  try {
    // ----------------------------------------------------------------
    // Payment events
    // ----------------------------------------------------------------

    if (paymentEntity) {
      const providerOrderId: string | null = paymentEntity.order_id ?? null;
      const providerPaymentId: string | null = paymentEntity.id ?? null;

      // Locate the payment row WE created. If there isn't one, this callback
      // refers to something this system did not initiate -- record it and
      // stop rather than inventing a payment.
      const { data: payment } = await admin
        .from("payments")
        .select("id, order_id, amount_paise, status")
        .eq("provider", "razorpay")
        .eq("provider_order_id", providerOrderId)
        .maybeSingle();

      if (!payment) {
        await markProcessed(`No matching payment for order ${providerOrderId}`);
        return json({ status: "ignored, unknown order" }, 200);
      }

      if (eventType === "payment.captured") {
        const paidPaise = Number(paymentEntity.amount ?? 0);

        // The payload says what was paid; our row says what was owed. If they
        // disagree, do NOT advance the order -- flag it for a human.
        if (paidPaise !== Number(payment.amount_paise)) {
          await admin
            .from("payments")
            .update({
              provider_payment_id: providerPaymentId,
              status: "captured",
              method: paymentEntity.method ?? null,
              failure_reason: `Amount mismatch: expected ${payment.amount_paise}, received ${paidPaise}`,
            })
            .eq("id", payment.id);

          await markProcessed(
            `Amount mismatch on ${providerPaymentId}: expected ${payment.amount_paise}, got ${paidPaise}`
          );
          return json({ status: "amount mismatch recorded" }, 200);
        }

        await admin
          .from("payments")
          .update({
            provider_payment_id: providerPaymentId,
            status: "captured",
            method: paymentEntity.method ?? null,
          })
          .eq("id", payment.id);

        // Only now does the order count as paid.
        await admin
          .from("orders")
          .update({ status: "advance_paid" })
          .eq("id", payment.order_id)
          .eq("status", "pending_advance");

        await markProcessed();
        return json({ status: "captured" }, 200);
      }

      if (eventType === "payment.failed") {
        await admin
          .from("payments")
          .update({
            provider_payment_id: providerPaymentId,
            status: "failed",
            method: paymentEntity.method ?? null,
            failure_reason:
              paymentEntity.error_description ?? paymentEntity.error_reason ?? null,
          })
          .eq("id", payment.id);

        // The order stays 'pending_advance' -- the customer can retry.
        await markProcessed();
        return json({ status: "failed recorded" }, 200);
      }
    }

    // ----------------------------------------------------------------
    // Refund events
    // ----------------------------------------------------------------

    if (refundEntity && eventType.startsWith("refund.")) {
      const { data: payment } = await admin
        .from("payments")
        .select("id, order_id")
        .eq("provider", "razorpay")
        .eq("provider_payment_id", refundEntity.payment_id)
        .maybeSingle();

      if (!payment) {
        await markProcessed(`No payment for refund ${refundEntity.id}`);
        return json({ status: "ignored, unknown payment" }, 200);
      }

      const refundStatus =
        eventType === "refund.processed"
          ? "processed"
          : eventType === "refund.failed"
          ? "failed"
          : "pending";

      // Deliberately not an upsert: refunds_provider_refund_unique is a
      // PARTIAL index (WHERE provider_refund_id is not null), and Postgres
      // will not infer a partial index for ON CONFLICT without repeating its
      // predicate -- which PostgREST cannot express. Check, then write.
      const { data: existingRefund } = await admin
        .from("refunds")
        .select("id")
        .eq("provider_refund_id", refundEntity.id)
        .maybeSingle();

      const refundRow = {
        payment_id: payment.id,
        provider_refund_id: refundEntity.id,
        amount_paise: Number(refundEntity.amount ?? 0),
        status: refundStatus,
        reason: refundEntity.notes?.reason ?? null,
      };

      if (existingRefund) {
        await admin.from("refunds").update(refundRow).eq("id", existingRefund.id);
      } else {
        await admin.from("refunds").insert(refundRow);
      }

      if (refundStatus === "processed") {
        await admin
          .from("orders")
          .update({ status: "refunded" })
          .eq("id", payment.order_id);
      }

      await markProcessed();
      return json({ status: `refund ${refundStatus}` }, 200);
    }

    // Anything else is acknowledged so Razorpay stops retrying, but recorded.
    await markProcessed();
    return json({ status: "acknowledged", event: eventType }, 200);
  } catch (handlerError) {
    console.error("Webhook handler failed:", handlerError);
    await markProcessed(String(handlerError));
    // 500 tells Razorpay to retry; the event row is already on disk.
    return json({ error: "Handler failed" }, 500);
  }
});
