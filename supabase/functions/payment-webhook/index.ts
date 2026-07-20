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

// ----------------------------------------------------------------------
// Advance invoice
// ----------------------------------------------------------------------
// Raised the moment the advance is captured -- that is when the tax point
// occurs, so it cannot be left to a human to remember.
//
// The advance is GST-INCLUSIVE, so the taxable value is backed out of the
// total rather than added on top: taxable = total / 1.18 at 18%.
//
// Intra-state (buyer state == seller state) splits into CGST + SGST;
// anything else is IGST. The buyer's state comes from the order snapshot,
// with the GSTIN prefix as fallback -- never guessed from PIN.
//
// deno-lint-ignore no-explicit-any
async function createAdvanceInvoice(admin: any, orderId: string) {
  // Idempotency: Razorpay retries webhooks, and an invoice number, once
  // allocated, cannot be un-allocated. One advance invoice per order, ever.
  const { data: existing } = await admin
    .from("invoices")
    .select("id, invoice_number")
    .eq("order_id", orderId)
    .eq("phase_label", "Advance")
    .maybeSingle();

  if (existing) return existing;

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select(
      `id, order_number, user_id, advance_amount_paise, gst_percent,
       contact_name, contact_email, contact_phone,
       delivery_address_line, delivery_city, delivery_state_name,
       delivery_state_code, delivery_pin_code,
       order_items ( package_name, hsn_code )`
    )
    .eq("id", orderId)
    .single();
  if (orderError) throw new Error(`Invoice: order lookup failed: ${orderError.message}`);

  const { data: buyer } = await admin
    .from("profiles")
    .select("gstin, customer_number")
    .eq("id", order.user_id)
    .maybeSingle();

  const { data: seller, error: sellerError } = await admin
    .from("seller_settings")
    .select("*")
    .eq("id", true)
    .single();
  if (sellerError) throw new Error(`Invoice: seller settings missing: ${sellerError.message}`);

  // Buyer state: order snapshot first, GSTIN prefix as fallback. If neither
  // exists (orders placed before migration 007), fall back to the seller's
  // state -- intra-state -- and say so in the notes.
  const buyerStateCode =
    order.delivery_state_code ?? buyer?.gstin?.slice(0, 2) ?? seller.state_code;
  const isInterstate = buyerStateCode !== seller.state_code;

  const gstRate = Number(order.gst_percent ?? 18);
  const totalPaise = Number(order.advance_amount_paise);
  const taxablePaise = Math.round((totalPaise * 100) / (100 + gstRate));
  const taxPaise = totalPaise - taxablePaise;
  // Odd paise goes to SGST rather than being lost.
  const cgstPaise = isInterstate ? 0 : Math.floor(taxPaise / 2);
  const sgstPaise = isInterstate ? 0 : taxPaise - cgstPaise;
  const igstPaise = isInterstate ? taxPaise : 0;

  const { data: numbering, error: numberError } = await admin
    .rpc("next_invoice_number", { p_user_id: order.user_id })
    .single();
  if (numberError) throw new Error(`Invoice numbering failed: ${numberError.message}`);

  const buyerAddress = [
    order.delivery_address_line,
    order.delivery_city,
    order.delivery_pin_code,
  ]
    .filter(Boolean)
    .join(", ");

  const { data: invoice, error: invoiceError } = await admin
    .from("invoices")
    .insert({
      invoice_number: numbering.invoice_number,
      order_id: order.id,
      user_id: order.user_id,
      financial_year: numbering.financial_year,
      fy_short: numbering.fy_short,
      customer_number: numbering.customer_number,
      phase_number: numbering.phase_number,
      sequence_number: numbering.sequence_number,
      phase_label: "Advance",

      seller_name: seller.legal_name,
      seller_gstin: seller.gstin,
      seller_address: [seller.address_line, seller.city, seller.pin_code]
        .filter(Boolean)
        .join(", "),
      seller_state_name: seller.state_name,
      seller_state_code: seller.state_code,

      buyer_name: order.contact_name,
      buyer_gstin: buyer?.gstin ?? null,
      buyer_address: buyerAddress,
      buyer_state_name: order.delivery_state_name,
      buyer_state_code: buyerStateCode,
      buyer_email: order.contact_email,
      buyer_phone: order.contact_phone,

      place_of_supply_state: order.delivery_state_name ?? seller.state_name,
      place_of_supply_code: buyerStateCode,
      is_interstate: isInterstate,

      taxable_value_paise: taxablePaise,
      cgst_paise: cgstPaise,
      sgst_paise: sgstPaise,
      igst_paise: igstPaise,
      total_paise: totalPaise,
      notes: order.delivery_state_code
        ? null
        : "Place of supply assumed intra-state: order predates state capture.",
    })
    .select("id, invoice_number")
    .single();
  if (invoiceError) throw new Error(`Invoice insert failed: ${invoiceError.message}`);

  const packageNames = (order.order_items ?? [])
    .map((i: { package_name: string }) => i.package_name)
    .join(", ");

  await admin.from("invoice_lines").insert({
    invoice_id: invoice.id,
    line_number: 1,
    description: `Refundable reservation advance — Order ${order.order_number}`,
    detail: packageNames || null,
    // The advance is a service, so it takes the SAC from seller_settings --
    // NOT the package's goods HSN, which classifies furniture.
    hsn_code: seller.advance_hsn_code ?? null,
    quantity: 1,
    unit: "NOS",
    unit_price_paise: taxablePaise,
    taxable_value_paise: taxablePaise,
    gst_rate: gstRate,
    cgst_paise: cgstPaise,
    sgst_paise: sgstPaise,
    igst_paise: igstPaise,
    line_total_paise: totalPaise,
  });

  console.log("Invoice", invoice.invoice_number, "raised for order", order.order_number);
  return invoice;
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

        // The tax point is the receipt of payment, so the invoice is raised
        // here and nowhere else. A failure is recorded on the event rather
        // than failing the webhook: the payment DID capture, and telling
        // Razorpay otherwise would trigger retries of a captured payment.
        try {
          await createAdvanceInvoice(admin, payment.order_id);
        } catch (invoiceError) {
          console.error("Invoice generation failed:", invoiceError);
          await markProcessed(`Captured, but invoice failed: ${invoiceError}`);
          return json({ status: "captured, invoice failed" }, 200);
        }

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
