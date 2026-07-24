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

// ----------------------------------------------------------------------
// Final invoice
// ----------------------------------------------------------------------
// Raised after the final (dispatch) installment is paid. It is the tax invoice
// for the ORDER VALUE NET OF THE ADVANCE (total - advance = balance): the
// advance is a separate supply with its own HSN/SAC and its own invoice, so the
// two invoices together add up to exactly what the customer paid, with no
// double counting. The goods carry the package HSN (order_items.hsn_code).
//
// deno-lint-ignore no-explicit-any
async function createFinalInvoice(admin: any, orderId: string) {
  // One final invoice per order, ever.
  const { data: existing } = await admin
    .from("invoices")
    .select("id, invoice_number")
    .eq("order_id", orderId)
    .eq("phase_label", "Final")
    .maybeSingle();
  if (existing) return existing;

  const { data: order, error: orderError } = await admin
    .from("orders")
    .select(
      `id, order_number, user_id, gst_percent, balance_paise,
       contact_name, contact_email, contact_phone,
       delivery_address_line, delivery_city, delivery_state_name,
       delivery_state_code, delivery_pin_code,
       order_items ( package_name, hsn_code )`
    )
    .eq("id", orderId)
    .single();
  if (orderError) throw new Error(`Final invoice: order lookup failed: ${orderError.message}`);

  const totalPaise = Number(order.balance_paise);
  if (totalPaise <= 0) throw new Error("Final invoice: nothing to invoice (balance is zero).");

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
  if (sellerError) throw new Error(`Final invoice: seller settings missing: ${sellerError.message}`);

  const buyerStateCode =
    order.delivery_state_code ?? buyer?.gstin?.slice(0, 2) ?? seller.state_code;
  const isInterstate = buyerStateCode !== seller.state_code;

  const gstRate = Number(order.gst_percent ?? 18);
  const taxablePaise = Math.round((totalPaise * 100) / (100 + gstRate));
  const taxPaise = totalPaise - taxablePaise;
  const cgstPaise = isInterstate ? 0 : Math.floor(taxPaise / 2);
  const sgstPaise = isInterstate ? 0 : taxPaise - cgstPaise;
  const igstPaise = isInterstate ? taxPaise : 0;

  const { data: numbering, error: numberError } = await admin
    .rpc("next_invoice_number", { p_user_id: order.user_id })
    .single();
  if (numberError) throw new Error(`Final invoice numbering failed: ${numberError.message}`);

  const buyerAddress = [
    order.delivery_address_line,
    order.delivery_city,
    order.delivery_pin_code,
  ]
    .filter(Boolean)
    .join(", ");

  const packageNames = (order.order_items ?? [])
    .map((i: { package_name: string }) => i.package_name)
    .join(", ");
  // The goods HSN — separate from the advance's SAC. First package's code.
  const goodsHsn =
    (order.order_items ?? []).find((i: { hsn_code: string | null }) => i.hsn_code)?.hsn_code ??
    null;

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
      phase_label: "Final",

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
      notes: "Order value net of the reservation advance, which is invoiced separately.",
    })
    .select("id, invoice_number")
    .single();
  if (invoiceError) throw new Error(`Final invoice insert failed: ${invoiceError.message}`);

  await admin.from("invoice_lines").insert({
    invoice_id: invoice.id,
    line_number: 1,
    description: `Sensory room order ${order.order_number} — order value net of advance`,
    detail: packageNames || null,
    hsn_code: goodsHsn,
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

  console.log("Final invoice", invoice.invoice_number, "raised for order", order.order_number);
  return invoice;
}

// ----------------------------------------------------------------------
// Invoice email
// ----------------------------------------------------------------------
// Sent through Resend's HTTP API -- the same provider already handling auth
// email -- so no SMTP handshake from inside the function. Best-effort by
// design: the payment has captured and the invoice exists, so a mail failure
// must never fail the webhook (which would make Razorpay retry a completed
// payment). emailed_at makes it idempotent across retries.

function rupees(paise: number): string {
  return (Number(paise || 0) / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!)
  );
}

// deno-lint-ignore no-explicit-any
function buildInvoiceEmailHtml(inv: any, siteUrl: string | null): string {
  const isAdvance = inv.phase_label === "Advance";
  const packages = (inv.orders?.order_items ?? [])
    .map((i: { package_name: string }) => escapeHtml(i.package_name))
    .join(", ");

  const taxRow = inv.is_interstate
    ? `<tr><td style="padding:4px 0;color:#59635d">IGST</td><td align="right">₹${rupees(inv.igst_paise)}</td></tr>`
    : `<tr><td style="padding:4px 0;color:#59635d">CGST</td><td align="right">₹${rupees(inv.cgst_paise)}</td></tr>
       <tr><td style="padding:4px 0;color:#59635d">SGST</td><td align="right">₹${rupees(inv.sgst_paise)}</td></tr>`;

  const viewLink = siteUrl
    ? `<p style="margin:22px 0 0;font-size:13px;color:#59635d">
         You can view or download your full tax invoice and order summary here:
         <a href="${siteUrl}/invoice.html?number=${encodeURIComponent(inv.invoice_number)}"
            style="color:#0c4444">View invoice ↗</a>
         (you may be asked to sign in with this email).
       </p>`
    : "";

  // Table-based, fully inline styles: email clients strip <style> blocks and
  // external CSS, so nothing here relies on either.
  return `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#171717">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f3;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e3e3de">
        <tr><td style="padding:26px 30px;border-bottom:2px solid #171717">
          <span style="font-size:15px;letter-spacing:.18em;font-weight:bold">SAFE CREATIVES</span>
          <span style="float:right;font-size:11px;color:#6f222a;letter-spacing:.08em">TAX INVOICE</span>
        </td></tr>

        <tr><td style="padding:26px 30px 6px">
          <p style="margin:0 0 14px;font-size:15px">Dear ${escapeHtml(inv.buyer_name)},</p>
          <p style="margin:0 0 6px;font-size:13.5px;line-height:1.6;color:#3a3a3a">
            ${isAdvance
              ? "Thank you for reserving your order with Safe Creatives. Your refundable advance has been received and your tax invoice is below."
              : "Thank you for your order with Safe Creatives. Your order is now fully paid, and your final tax invoice is below."}
          </p>
        </td></tr>

        <tr><td style="padding:12px 30px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
            <tr><td style="padding:4px 0;color:#59635d">Invoice number</td><td align="right"><strong>${escapeHtml(inv.invoice_number)}</strong></td></tr>
            <tr><td style="padding:4px 0;color:#59635d">Invoice date</td><td align="right">${new Date(inv.issue_date).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</td></tr>
            <tr><td style="padding:4px 0;color:#59635d">Order reference</td><td align="right">${escapeHtml(inv.orders?.order_number ?? "")}</td></tr>
            ${packages ? `<tr><td style="padding:4px 0;color:#59635d">Packages reserved</td><td align="right">${packages}</td></tr>` : ""}
          </table>
        </td></tr>

        <tr><td style="padding:10px 30px">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px;border-top:1px solid #e3e3de">
            <tr><td style="padding:10px 0 4px;color:#59635d">${isAdvance ? "Refundable reservation advance (taxable)" : "Order value, net of advance (taxable)"}</td><td align="right" style="padding-top:10px">₹${rupees(inv.taxable_value_paise)}</td></tr>
            ${taxRow}
            <tr><td style="padding:8px 0;border-top:1px solid #171717;font-weight:bold">Total paid</td><td align="right" style="padding:8px 0;border-top:1px solid #171717;font-weight:bold">₹${rupees(inv.total_paise)}</td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:6px 30px 8px">
          <p style="margin:0;font-size:12.5px;line-height:1.6;color:#59635d">
            ${isAdvance
              ? "This advance is refundable as per the accepted terms. Our team will be in touch to arrange a site visit and confirm the next steps; the balance is invoiced after the final payment."
              : "This invoice covers the balance of your order value; the reservation advance was invoiced separately. Thank you for choosing Safe Creatives."}
          </p>
          <p style="margin:12px 0 0;font-size:12.5px;line-height:1.6;color:#59635d">
            Attached to this email you'll find your tax invoice with the full order
            summary, and our warranty &amp; workflow document, both as PDFs.
          </p>
          ${viewLink}
        </td></tr>

        <tr><td style="padding:18px 30px;border-top:1px solid #e3e3de;font-size:11px;color:#8b8f88;line-height:1.6">
          ${escapeHtml(inv.seller_name)}${inv.seller_gstin ? ` · GSTIN ${escapeHtml(inv.seller_gstin)}` : ""}<br />
          ${escapeHtml(inv.seller_address)}<br />
          Place of supply: ${escapeHtml(inv.place_of_supply_state)} · ${inv.is_interstate ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}<br />
          This is a computer-generated invoice.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ----------------------------------------------------------------------
// Printable invoice document (order summary + tax invoice)
// ----------------------------------------------------------------------
// A server-side render of the exact two-page document from invoice.html /
// invoice.js, with the data inlined. This is what gets turned into the PDF
// attachment, so it must match what an admin sees in the dashboard. The CSS
// is copied verbatim from invoice.html; @media print gives the page break.

const INVOICE_CSS = `
* { box-sizing: border-box; margin: 0; }
body { background: #fff; font: 12px/1.5 "Segoe UI", Arial, sans-serif; color: #171717; }
.sheet { width: 210mm; min-height: 280mm; margin: 0 auto; padding: 14mm 12mm; background: #fff; }
.doc-head { display: flex; justify-content: space-between; align-items: baseline; border-bottom: 2px solid #171717; padding-bottom: 8px; }
.doc-head h1 { font-size: 17px; letter-spacing: .18em; }
.doc-head span { font-size: 10px; color: #555; letter-spacing: .08em; }
.parties { display: grid; grid-template-columns: 1.2fr 1fr; gap: 0; border: 1px solid #999; border-top: 0; }
.box { padding: 9px 11px; border-top: 1px solid #999; }
.box + .box { border-left: 1px solid #999; }
.box h2 { font-size: 9px; letter-spacing: .14em; color: #555; margin-bottom: 4px; text-transform: uppercase; }
.box strong.name { font-size: 13px; display: block; margin-bottom: 2px; }
.meta-grid { display: grid; grid-template-columns: 1fr 1fr; border-top: 1px solid #999; }
.meta-grid .box { border-top: 0; }
.meta-grid .box:nth-child(even) { border-left: 1px solid #999; }
.meta-grid .box:nth-child(n+3) { border-top: 1px solid #999; }
table.lines { width: 100%; border-collapse: collapse; margin-top: 12px; }
table.lines th, table.lines td { border: 1px solid #999; padding: 6px 7px; text-align: right; vertical-align: top; }
table.lines th { background: #f2f2ee; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
table.lines th:nth-child(2), table.lines td:nth-child(2) { text-align: left; }
table.lines td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
.line-detail { display: block; color: #555; font-size: 10.5px; margin-top: 2px; }
table.lines tfoot td { font-weight: 600; background: #fafaf7; }
.words { border: 1px solid #999; border-top: 0; padding: 8px 11px; font-size: 11.5px; }
.words em { font-style: normal; font-weight: 600; }
.foot { display: grid; grid-template-columns: 1.3fr 1fr; gap: 0; border: 1px solid #999; border-top: 0; min-height: 90px; }
.foot .box { border-top: 0; }
.signature { display: flex; flex-direction: column; justify-content: space-between; text-align: right; }
.signature .for { font-weight: 600; }
.signature .line { color: #555; font-size: 10px; }
.doc-note { margin-top: 10px; color: #555; font-size: 10px; text-align: center; }
.order-item { border: 1px solid #999; border-top: 0; padding: 10px 11px; }
.oi-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
.oi-head strong { font-size: 13px; }
.oi-head span { font-variant-numeric: tabular-nums; }
.oi-base { color: #555; font-size: 10.5px; margin-bottom: 7px; }
.oi-product { margin: 0 0 7px; }
.oi-product h3 { font-size: 9px; letter-spacing: .12em; color: #6f222a; text-transform: uppercase; margin-bottom: 2px; }
.oi-product ul { margin: 0; padding-left: 14px; }
.oi-product li { margin: 1px 0; }
.oi-none { color: #777; font-style: italic; }
.sum-totals { border: 1px solid #999; border-top: 0; }
.sum-totals .row { display: flex; justify-content: space-between; padding: 5px 11px; border-top: 1px solid #e3e3de; font-variant-numeric: tabular-nums; }
.sum-totals .row:first-child { border-top: 0; }
.sum-totals .row.grand { font-weight: 600; background: #fafaf7; }
.sum-totals .row.paid { color: #0c4444; }
.sheet { break-after: page; }
.sheet:last-of-type { break-after: auto; }
@page { size: A4; margin: 12mm; }
`;

// Indian-system amount in words, matching invoice.js.
function amountInWords(paise: number): string {
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven",
    "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen",
    "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty",
    "Seventy", "Eighty", "Ninety"];
  const two = (n: number): string =>
    n < 20 ? ones[n] : (tens[Math.floor(n / 10)] + " " + ones[n % 10]).trim();
  const three = (n: number): string => {
    const h = Math.floor(n / 100);
    return ((h ? ones[h] + " Hundred " : "") + two(n % 100)).trim();
  };
  const words = (n: number): string => {
    if (n === 0) return "Zero";
    const cr = Math.floor(n / 10000000);
    const lk = Math.floor((n % 10000000) / 100000);
    const th = Math.floor((n % 100000) / 1000);
    const rest = n % 1000;
    return [
      cr ? two(cr) + " Crore" : "",
      lk ? two(lk) + " Lakh" : "",
      th ? two(th) + " Thousand" : "",
      rest ? three(rest) : "",
    ].filter(Boolean).join(" ");
  };
  const whole = Math.floor(Number(paise) / 100);
  const frac = Number(paise) % 100;
  return `Rupees ${words(whole)}${frac ? ` and ${two(frac)} Paise` : ""} Only`;
}

// deno-lint-ignore no-explicit-any
function buildInvoiceDocumentHtml(inv: any, order: any): string {
  const dateOf = (v: string) =>
    new Date(v).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

  // ---- Page 1: order summary (omitted for a manual invoice with no order)
  let summary = "";
  if (order) {
    const address = [order.delivery_address_line, order.delivery_city,
      order.delivery_state_name, order.delivery_pin_code].filter(Boolean).map(escapeHtml).join(", ");

    const items = (order.order_items ?? []).map((item: any, index: number) => {
      const byProduct = new Map<string, any[]>();
      (item.order_item_options ?? []).forEach((o: any) => {
        if (!byProduct.has(o.product_name)) byProduct.set(o.product_name, []);
        byProduct.get(o.product_name)!.push(o);
      });
      const products = [...byProduct.entries()].map(([name, opts]) => {
        const rows = opts.map((o) => {
          const delta = Number(o.price_delta_paise || 0);
          const spec = [o.finish, o.material].filter(Boolean).map(escapeHtml).join(", ");
          return `<li>${escapeHtml(o.group_name)}: <strong>${escapeHtml(o.option_name)}</strong>${
            delta ? ` (+₹${rupees(delta)})` : ""}${spec ? ` — ${spec}` : ""}</li>`;
        }).join("");
        return `<div class="oi-product"><h3>${escapeHtml(name)}</h3><ul>${rows}</ul></div>`;
      }).join("");

      const addons = item.order_item_addons ?? [];
      const addonRows = addons.length
        ? addons.map((a: any) => `<li>${escapeHtml(a.addon_name)}${
            a.hsn_code ? ` (HSN ${escapeHtml(a.hsn_code)})` : ""} — ₹${rupees(a.price_paise)}</li>`).join("")
        : `<li class="oi-none">None selected</li>`;

      return `<div class="order-item">
        <div class="oi-head"><strong>${index + 1}. ${escapeHtml(item.package_name)}</strong><span>₹${rupees(item.line_total_paise)}</span></div>
        <p class="oi-base">Base price ₹${rupees(item.base_price_paise)}${item.hsn_code ? ` · HSN ${escapeHtml(item.hsn_code)}` : ""}</p>
        ${products}
        <div class="oi-product"><h3>Add-ons</h3><ul>${addonRows}</ul></div>
      </div>`;
    }).join("");

    summary = `<div class="sheet">
      <div class="doc-head"><h1>ORDER SUMMARY</h1><span>ACCOMPANIES INVOICE ${escapeHtml(inv.invoice_number)}</span></div>
      <div class="parties">
        <div class="box"><h2>Customer</h2><strong class="name">${escapeHtml(order.contact_name)}</strong>${address}<br />${escapeHtml(order.contact_email || "")}${order.contact_phone ? ` · ${escapeHtml(order.contact_phone)}` : ""}</div>
        <div class="box"><h2>Order</h2><strong class="name">${escapeHtml(order.order_number)}</strong>Placed: ${dateOf(order.placed_at)}<br />Packages: ${order.order_items.length}</div>
      </div>
      ${items}
      <div class="sum-totals">
        <div class="row"><span>Package total (ex GST)</span><span>₹${rupees(order.subtotal_paise)}</span></div>
        <div class="row"><span>GST (${Number(order.gst_percent)}%)</span><span>₹${rupees(order.gst_paise)}</span></div>
        <div class="row grand"><span>Total payable</span><span>₹${rupees(order.total_paise)}</span></div>
        <div class="row paid"><span>Reservation advance (incl. GST)</span><span>₹${rupees(order.advance_amount_paise)}</span></div>
        <div class="row"><span>Balance (order value net of advance)</span><span>₹${rupees(order.balance_paise)}</span></div>
      </div>
      <p class="doc-note">This summary describes the order as configured. ${
        inv.phase_label === "Advance"
          ? "The tax invoice on the following page covers the reservation advance only; the balance is invoiced after the final payment."
          : "The tax invoice on the following page covers the order value net of the reservation advance, which is invoiced separately."
      }</p>
    </div>`;
  }

  // ---- Page 2: tax invoice
  const inter = inv.is_interstate;
  const lines = [...(inv.invoice_lines ?? [])].sort((a, b) => a.line_number - b.line_number);
  const taxHead = inter ? `<th colspan="2">IGST</th>` : `<th colspan="2">CGST</th><th colspan="2">SGST</th>`;
  const taxSubHead = inter ? `<th>Rate</th><th>Amount</th>` : `<th>Rate</th><th>Amount</th><th>Rate</th><th>Amount</th>`;

  const lineRows = lines.map((line) => {
    const half = (Number(line.gst_rate) / 2).toFixed(1).replace(/\.0$/, "");
    const taxCells = inter
      ? `<td class="num">${line.gst_rate}%</td><td class="num">${rupees(line.igst_paise)}</td>`
      : `<td class="num">${half}%</td><td class="num">${rupees(line.cgst_paise)}</td><td class="num">${half}%</td><td class="num">${rupees(line.sgst_paise)}</td>`;
    return `<tr>
      <td class="num">${line.line_number}</td>
      <td>${escapeHtml(line.description)}${line.detail ? `<span class="line-detail">${escapeHtml(line.detail)}</span>` : ""}</td>
      <td class="num">${escapeHtml(line.hsn_code) || "—"}</td>
      <td class="num">${Number(line.quantity)}</td>
      <td class="num">${escapeHtml(line.unit)}</td>
      <td class="num">${rupees(line.unit_price_paise)}</td>
      <td class="num">${rupees(line.taxable_value_paise)}</td>
      ${taxCells}
      <td class="num">${rupees(line.line_total_paise)}</td>
    </tr>`;
  }).join("");

  const taxFoot = inter
    ? `<td></td><td class="num">${rupees(inv.igst_paise)}</td>`
    : `<td></td><td class="num">${rupees(inv.cgst_paise)}</td><td></td><td class="num">${rupees(inv.sgst_paise)}</td>`;

  const invoiceSheet = `<div class="sheet">
    <div class="doc-head"><h1>TAX INVOICE</h1><span>ORIGINAL FOR RECIPIENT</span></div>
    <div class="parties">
      <div class="box"><h2>Supplier</h2><strong class="name">${escapeHtml(inv.seller_name)}</strong>${escapeHtml(inv.seller_address)}<br />${escapeHtml(inv.seller_state_name)} — ${escapeHtml(inv.seller_state_code)}<br />${inv.seller_gstin ? `GSTIN: ${escapeHtml(inv.seller_gstin)}` : "<em>GSTIN pending registration</em>"}</div>
      <div class="box"><h2>Invoice</h2><strong class="name">${escapeHtml(inv.invoice_number)}</strong>Date: ${dateOf(inv.issue_date)}<br />Phase: ${escapeHtml(inv.phase_label || inv.phase_number)}<br />Reverse charge: ${inv.reverse_charge ? "Yes" : "No"}</div>
    </div>
    <div class="meta-grid">
      <div class="box"><h2>Billed &amp; shipped to</h2><strong class="name">${escapeHtml(inv.buyer_name)}</strong>${escapeHtml(inv.buyer_address)}<br />${inv.buyer_gstin ? `GSTIN: ${escapeHtml(inv.buyer_gstin)}` : "Unregistered (B2C)"}</div>
      <div class="box"><h2>Place of supply</h2>${escapeHtml(inv.place_of_supply_state)} — ${escapeHtml(inv.place_of_supply_code)}<br />Supply type: ${inter ? "Inter-state (IGST)" : "Intra-state (CGST + SGST)"}</div>
    </div>
    <table class="lines">
      <thead>
        <tr><th rowspan="2">#</th><th rowspan="2">Description</th><th rowspan="2">HSN/SAC</th><th rowspan="2">Qty</th><th rowspan="2">Unit</th><th rowspan="2">Rate (₹)</th><th rowspan="2">Taxable (₹)</th>${taxHead}<th rowspan="2">Total (₹)</th></tr>
        <tr>${taxSubHead}</tr>
      </thead>
      <tbody>${lineRows}</tbody>
      <tfoot><tr><td colspan="6">Total</td><td class="num">${rupees(inv.taxable_value_paise)}</td>${taxFoot}<td class="num">${rupees(inv.total_paise)}</td></tr></tfoot>
    </table>
    <div class="words">Amount in words: <em>${amountInWords(inv.total_paise)}</em></div>
    <div class="foot">
      <div class="box"><h2>Notes</h2>${escapeHtml(inv.notes) || "The reservation advance is refundable as per the accepted terms and conditions."}</div>
      <div class="box signature"><span class="for">For ${escapeHtml(inv.seller_name)}</span><span class="line">Authorised signatory</span></div>
    </div>
    <p class="doc-note">This is a computer-generated invoice.</p>
  </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>${INVOICE_CSS}</style></head><body>${summary}${invoiceSheet}</body></html>`;
}

// Chunked so String.fromCharCode is never handed a huge argument list.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Renders the document HTML to a PDF via PDFShift and returns it base64-encoded
// for the Resend attachment. Returns null if the service is not configured, so
// the caller can still send the email without the attachment.
async function renderInvoicePdf(html: string): Promise<string | null> {
  const apiKey = Deno.env.get("PDFSHIFT_API_KEY");
  if (!apiKey) {
    console.warn("PDFSHIFT_API_KEY not set; sending invoice email without PDF.");
    return null;
  }

  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      // PDFShift uses HTTP Basic with the literal username "api".
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
      "Content-Type": "application/json",
    },
    // use_print applies the @media print rules, which is what produces the
    // two separate A4 pages.
    body: JSON.stringify({ source: html, use_print: true, sandbox: false }),
  });

  if (!res.ok) {
    throw new Error(`PDFShift ${res.status}: ${await res.text()}`);
  }

  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
}

// ----------------------------------------------------------------------
// Warranty + workflow document
// ----------------------------------------------------------------------
// A fixed PDF (warranty terms + the project workflow) sent alongside every
// invoice. It lives at WARRANTY_PDF_URL -- a public Supabase Storage object --
// so it can be revised without redeploying the function. Best-effort: if the
// URL is unset or the fetch fails, the invoice email still goes out without it.
async function fetchWarrantyAttachment(): Promise<
  { filename: string; content: string } | null
> {
  const url = Deno.env.get("WARRANTY_PDF_URL");
  if (!url) {
    console.warn("WARRANTY_PDF_URL not set; invoice email will omit the warranty document.");
    return null;
  }
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return {
      filename: "Safe-Creatives-Warranty-and-Workflow.pdf",
      content: bytesToBase64(new Uint8Array(await res.arrayBuffer())),
    };
  } catch (warrantyError) {
    console.error("Could not fetch warranty document; sending without it:", warrantyError);
    return null;
  }
}

// deno-lint-ignore no-explicit-any
async function emailInvoiceIfUnsent(admin: any, invoiceId: string) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; skipping invoice email.");
    return;
  }

  // The `is emailed_at null` filter is the idempotency guard: a retried
  // webhook finds nothing to send. Everything the document needs is loaded
  // here so the PDF matches the dashboard.
  const { data: inv } = await admin
    .from("invoices")
    .select(
      `*, invoice_lines ( * ),
       orders (
         order_number, placed_at, subtotal_paise, gst_percent, gst_paise,
         total_paise, advance_amount_paise, balance_paise,
         contact_name, contact_email, contact_phone,
         delivery_address_line, delivery_city, delivery_state_name,
         delivery_pin_code,
         order_items (
           package_name, hsn_code, base_price_paise, line_total_paise,
           order_item_options ( product_name, group_name, option_name,
                                finish, material, price_delta_paise ),
           order_item_addons ( addon_name, hsn_code, price_paise )
         )
       )`
    )
    .eq("id", invoiceId)
    .is("emailed_at", null)
    .maybeSingle();

  if (!inv) return; // already emailed, or not found
  if (!inv.buyer_email) {
    console.warn("Invoice", inv.invoice_number, "has no buyer email; not sending.");
    return;
  }

  const from = Deno.env.get("INVOICE_FROM_EMAIL") ??
    "Safe Creatives <noreply@safecreatives.com>";
  const siteUrl = Deno.env.get("PUBLIC_SITE_URL")?.replace(/\/+$/, "") ?? null;

  // The document (order summary + tax invoice) as a PDF attachment. Best
  // effort: if the PDF service is unconfigured or errors, the email still
  // goes out with the summary in the body.
  let pdfBase64: string | null = null;
  try {
    pdfBase64 = await renderInvoicePdf(buildInvoiceDocumentHtml(inv, inv.orders));
  } catch (pdfError) {
    console.error("Invoice PDF generation failed; sending without attachment:", pdfError);
  }

  // Two attachments: the invoice + order-summary PDF (per order), and the
  // fixed warranty + workflow document. Each is independent and best-effort.
  const attachments: Array<{ filename: string; content: string }> = [];
  if (pdfBase64) {
    attachments.push({ filename: `Safe-Creatives-${inv.invoice_number}.pdf`, content: pdfBase64 });
  }
  const warranty = await fetchWarrantyAttachment();
  if (warranty) attachments.push(warranty);

  const payload: Record<string, unknown> = {
    from,
    to: [inv.buyer_email],
    subject: `Your Safe Creatives tax invoice ${inv.invoice_number}`,
    html: buildInvoiceEmailHtml(inv, siteUrl),
  };
  if (attachments.length) payload.attachments = attachments;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${await res.text()}`);
  }

  await admin
    .from("invoices")
    .update({ emailed_at: new Date().toISOString() })
    .eq("id", invoiceId);

  console.log(
    "Invoice", inv.invoice_number, "emailed to", inv.buyer_email,
    `with ${attachments.length} attachment(s)`,
    pdfBase64 ? "[invoice PDF]" : "[no invoice PDF]",
    warranty ? "[warranty PDF]" : "[no warranty PDF]"
  );
}

// ----------------------------------------------------------------------
// Installment receipt
// ----------------------------------------------------------------------
// The 80% and 20% installments are advances toward the goods, so on payment we
// send a payment RECEIPT (not a tax invoice) — the GST tax invoice for the
// order is raised once at delivery. Best-effort, like the invoice email.

// deno-lint-ignore no-explicit-any
function buildReceiptEmailHtml(order: any, link: any, phaseLabel: string, receiptRef: string, paidOn: Date): string {
  const dateStr = paidOn.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  return `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#171717">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f3;padding:24px 12px"><tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#fff;border:1px solid #e3e3de">
      <tr><td style="padding:26px 30px;border-bottom:2px solid #171717">
        <span style="font-size:15px;letter-spacing:.18em;font-weight:bold">SAFE CREATIVES</span>
        <span style="float:right;font-size:11px;color:#6f222a;letter-spacing:.08em">PAYMENT RECEIPT</span>
      </td></tr>
      <tr><td style="padding:26px 30px 6px">
        <p style="margin:0 0 14px;font-size:15px">Dear ${escapeHtml(order.contact_name)},</p>
        <p style="margin:0 0 6px;font-size:13.5px;line-height:1.6;color:#3a3a3a">
          We've received your ${escapeHtml(phaseLabel.toLowerCase())} for order
          <strong>${escapeHtml(order.order_number)}</strong>. Thank you.
        </p>
      </td></tr>
      <tr><td style="padding:12px 30px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:13px">
          <tr><td style="padding:4px 0;color:#59635d">Receipt</td><td align="right"><strong>${escapeHtml(receiptRef)}</strong></td></tr>
          <tr><td style="padding:4px 0;color:#59635d">Date</td><td align="right">${dateStr}</td></tr>
          <tr><td style="padding:8px 0;border-top:1px solid #171717;font-weight:bold">Amount received</td><td align="right" style="padding:8px 0;border-top:1px solid #171717;font-weight:bold">₹${rupees(link.amount_paise)}</td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:6px 30px 24px">
        <p style="margin:0;font-size:12.5px;line-height:1.6;color:#59635d">
          This is a payment receipt. Your GST tax invoice will be issued once your order is fully paid. A PDF copy is attached.
        </p>
      </td></tr>
    </table>
  </td></tr></table>
</body></html>`;
}

// deno-lint-ignore no-explicit-any
function buildReceiptDocumentHtml(order: any, seller: any, link: any, phaseLabel: string, receiptRef: string, paidOn: Date): string {
  const dateStr = paidOn.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
  const sellerName = seller?.legal_name ?? "Safe Creatives";
  const sellerAddr = [seller?.address_line, seller?.city, seller?.pin_code].filter(Boolean).join(", ");
  const buyerAddr = [order.delivery_address_line, order.delivery_city, order.delivery_state_name, order.delivery_pin_code].filter(Boolean).join(", ");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${INVOICE_CSS}</style></head><body>
    <div class="sheet">
      <div class="doc-head"><h1>PAYMENT RECEIPT</h1><span>${escapeHtml(receiptRef)}</span></div>
      <div class="parties">
        <div class="box"><h2>Received by</h2><strong class="name">${escapeHtml(sellerName)}</strong>${escapeHtml(sellerAddr)}${seller?.gstin ? `<br />GSTIN: ${escapeHtml(seller.gstin)}` : ""}</div>
        <div class="box"><h2>From</h2><strong class="name">${escapeHtml(order.contact_name)}</strong>${escapeHtml(buyerAddr)}</div>
      </div>
      <div class="meta-grid">
        <div class="box"><h2>Order</h2>${escapeHtml(order.order_number)}</div>
        <div class="box"><h2>Date</h2>${dateStr}</div>
      </div>
      <table class="lines">
        <thead><tr><th>Description</th><th>Amount (₹)</th></tr></thead>
        <tbody><tr><td>${escapeHtml(phaseLabel)} — order ${escapeHtml(order.order_number)}</td><td class="num">${rupees(link.amount_paise)}</td></tr></tbody>
        <tfoot><tr><td>Amount received</td><td class="num">${rupees(link.amount_paise)}</td></tr></tfoot>
      </table>
      <div class="words">Amount received: <em>${amountInWords(link.amount_paise)}</em></div>
      <p class="doc-note">This is a payment receipt, not a tax invoice. Your GST tax invoice will be issued once your order is fully paid. Computer-generated; no signature required.</p>
    </div></body></html>`;
}

// deno-lint-ignore no-explicit-any
async function emailInstallmentReceipt(admin: any, link: any) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; skipping receipt email.");
    return;
  }

  const { data: order } = await admin
    .from("orders")
    .select(
      `order_number, contact_name, contact_email,
       delivery_address_line, delivery_city, delivery_state_name, delivery_pin_code`
    )
    .eq("id", link.order_id)
    .maybeSingle();
  if (!order?.contact_email) {
    console.warn("Order for link", link.id, "has no email; not sending receipt.");
    return;
  }

  const { data: seller } = await admin
    .from("seller_settings")
    .select("*")
    .eq("id", true)
    .maybeSingle();

  const phaseLabel =
    link.phase === "confirmation" ? "Confirmation payment (80%)" : "Balance on dispatch (20%)";
  const receiptRef = `${order.order_number}-${link.phase === "confirmation" ? "CONF" : "DISP"}`;
  const paidOn = new Date();

  const from = Deno.env.get("INVOICE_FROM_EMAIL") ??
    "Safe Creatives <noreply@safecreatives.com>";

  const payload: Record<string, unknown> = {
    from,
    to: [order.contact_email],
    subject: `Payment received — ${receiptRef}`,
    html: buildReceiptEmailHtml(order, link, phaseLabel, receiptRef, paidOn),
  };

  try {
    const pdf = await renderInvoicePdf(
      buildReceiptDocumentHtml(order, seller, link, phaseLabel, receiptRef, paidOn)
    );
    if (pdf) {
      payload.attachments = [
        { filename: `Safe-Creatives-Receipt-${receiptRef}.pdf`, content: pdf },
      ];
    }
  } catch (pdfError) {
    console.error("Receipt PDF failed; sending without attachment:", pdfError);
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log("Receipt", receiptRef, "emailed to", order.contact_email);
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
    // Installment payment link paid
    // ----------------------------------------------------------------
    // A paid link also carries a payment entity, so this must be handled BEFORE
    // the payment block below — otherwise the payment-order lookup there would
    // find nothing and wrongly ignore it.

    if (eventType === "payment_link.paid") {
      const linkEntity = event.payload?.payment_link?.entity ?? null;
      const linkPayment = event.payload?.payment?.entity ?? null;
      if (!linkEntity?.id) {
        await markProcessed("payment_link.paid without a link id");
        return json({ status: "ignored, no link id" }, 200);
      }

      const { data: link } = await admin
        .from("installment_links")
        .select("id, order_id, phase, amount_paise, status")
        .eq("provider_link_id", linkEntity.id)
        .maybeSingle();

      if (!link) {
        await markProcessed(`No installment link for ${linkEntity.id}`);
        return json({ status: "ignored, unknown link" }, 200);
      }
      if (link.status === "paid") {
        await markProcessed();
        return json({ status: "already paid" }, 200);
      }

      await admin
        .from("installment_links")
        .update({
          status: "paid",
          paid_at: new Date().toISOString(),
          provider_payment_id: linkPayment?.id ?? null,
        })
        .eq("id", link.id);

      // Reflect on the order so it shows paid to the admin and the customer.
      const paidColumn =
        link.phase === "confirmation" ? "confirmation_paid_at" : "dispatch_paid_at";
      await admin
        .from("orders")
        .update({ [paidColumn]: new Date().toISOString() })
        .eq("id", link.order_id);

      // Best-effort receipt: the installment is paid and recorded either way.
      try {
        await emailInstallmentReceipt(admin, link);
      } catch (receiptError) {
        console.error("Receipt email failed:", receiptError);
        await markProcessed(`Installment paid, receipt email failed: ${receiptError}`);
        return json({ status: "paid, receipt failed" }, 200);
      }

      // The final (dispatch) payment triggers the real tax invoice for the
      // order value net of the advance. Best-effort, like the receipt.
      if (link.phase === "dispatch") {
        try {
          const finalInvoice = await createFinalInvoice(admin, link.order_id);
          await emailInvoiceIfUnsent(admin, finalInvoice.id);
        } catch (finalError) {
          console.error("Final invoice failed:", finalError);
          await markProcessed(`Dispatch paid, final invoice failed: ${finalError}`);
          return json({ status: "paid, final invoice failed" }, 200);
        }
      }

      await markProcessed();
      return json({ status: "installment paid" }, 200);
    }

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
        let invoice;
        try {
          invoice = await createAdvanceInvoice(admin, payment.order_id);
        } catch (invoiceError) {
          console.error("Invoice generation failed:", invoiceError);
          await markProcessed(`Captured, but invoice failed: ${invoiceError}`);
          return json({ status: "captured, invoice failed" }, 200);
        }

        // Best-effort: a mail failure is logged but does not fail the webhook.
        // The payment captured and the invoice exists either way; emailed_at
        // keeps it from double-sending, and a null emailed_at leaves it
        // eligible to re-send later.
        try {
          await emailInvoiceIfUnsent(admin, invoice.id);
        } catch (emailError) {
          console.error("Invoice email failed:", emailError);
          await markProcessed(`Captured and invoiced, but email failed: ${emailError}`);
          return json({ status: "captured, email failed" }, 200);
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
