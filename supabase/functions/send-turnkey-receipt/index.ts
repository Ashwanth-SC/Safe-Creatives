// ============================================================================
// send-turnkey-receipt — email a turnkey payment receipt to the client
// ============================================================================
//
// Called by an admin from the Turnkey dashboard right after a receipt is
// generated (and available as a manual "Email" action per receipt). It:
//
//   1. checks the caller is a signed-in admin,
//   2. loads the receipt (by receipt_number) plus the project it belongs to —
//      the client's email lives on the project, not the snapshotted receipt,
//   3. renders the same receipt as a PDF via PDFShift,
//   4. emails it to the client via Resend, with a warm thank-you note and the
//      key details (receipt code, milestone, payment date, amount, mode).
//
// Reuses the invoice email infrastructure: PDFSHIFT_API_KEY, RESEND_API_KEY,
// INVOICE_FROM_EMAIL. If the client has no email on file the receipt is left
// untouched and { ok: false, reason: "no_email" } is returned so the dashboard
// can tell the admin without treating it as an error.
//
// Needs no migration. Deploy:
//   supabase functions deploy send-turnkey-receipt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Same origin-allowlist handling as the other browser-called functions.
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
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
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
  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const receiptNumber = String(body.receipt_number ?? "").trim();
  if (!receiptNumber) return json({ error: "Missing receipt_number." }, 400);

  // --- Load the receipt + its project (the email lives on the project) -------
  const { data: receipt, error: receiptError } = await admin
    .from("turnkey_receipts")
    .select("*, turnkey_projects ( project_number, client_email )")
    .eq("receipt_number", receiptNumber)
    .maybeSingle();
  if (receiptError) {
    console.error("Receipt lookup failed:", receiptError);
    return json({ error: "Could not load the receipt." }, 500);
  }
  if (!receipt) return json({ error: "Receipt not found." }, 404);

  const clientEmail = String(receipt.turnkey_projects?.client_email ?? "").trim();
  if (!clientEmail) return json({ ok: false, reason: "no_email" });

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; cannot email receipt.");
    return json({ ok: false, reason: "email_not_configured" });
  }

  const { data: seller } = await admin.from("seller_settings").select("*").maybeSingle();

  // --- Render the PDF (best effort) and send ---------------------------------
  let pdfBase64: string | null = null;
  try {
    pdfBase64 = await renderReceiptPdf(buildReceiptDocumentHtml(receipt, seller));
  } catch (pdfError) {
    // A PDF failure must not lose the email — send it with the details inline.
    console.error("Receipt PDF render failed; emailing without attachment:", pdfError);
  }

  const from =
    Deno.env.get("INVOICE_FROM_EMAIL") ?? "Safe Creatives <noreply@safecreatives.com>";

  const payload: Record<string, unknown> = {
    from,
    to: [clientEmail],
    subject: `Your payment receipt ${receipt.receipt_number}`,
    html: buildReceiptEmailHtml(receipt, seller),
  };
  if (seller?.email) payload.reply_to = String(seller.email);
  if (pdfBase64) {
    payload.attachments = [
      {
        filename: `Receipt-${safeFileName(receipt.receipt_number)}.pdf`,
        content: pdfBase64,
      },
    ];
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const detail = await res.text();
    console.error("Resend failed:", res.status, detail);
    return json({ error: `Email service error (${res.status}).` }, 502);
  }

  console.log("Receipt", receipt.receipt_number, "emailed to", clientEmail,
    pdfBase64 ? "with PDF" : "without PDF");
  return json({ ok: true, to: clientEmail, attached: Boolean(pdfBase64) });
});

// ---------------------------------------------------------------------------
// Formatting helpers (mirrors public/receipt.js so the PDF matches the screen)
// ---------------------------------------------------------------------------

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFileName(value: string): string {
  return value.replace(/[^\w.-]+/g, "-");
}

// Whole rupees, Indian grouping — identical to SC.money on the site.
function money(paise: unknown): string {
  return `₹${Math.round(Number(paise || 0) / 100).toLocaleString("en-IN")}`;
}

function fmtDate(ymd: unknown): string {
  if (!ymd) return "—";
  const [y, m, d] = String(ymd).split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[Number(m) - 1] || m} ${y}`;
}

// Indian numbering (crore / lakh / thousand). Whole rupees; paise appended.
function rupeesInWords(rupees: number): string {
  rupees = Math.floor(rupees);
  if (rupees === 0) return "Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
    "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
    "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
  const two = (n: number) => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : ""));
  const three = (n: number) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return (h ? ones[h] + " Hundred" + (r ? " " : "") : "") + (r ? two(r) : "");
  };
  let words = "";
  const crore = Math.floor(rupees / 10000000); rupees %= 10000000;
  const lakh = Math.floor(rupees / 100000); rupees %= 100000;
  const thousand = Math.floor(rupees / 1000); rupees %= 1000;
  if (crore) words += three(crore) + " Crore ";
  if (lakh) words += three(lakh) + " Lakh ";
  if (thousand) words += three(thousand) + " Thousand ";
  if (rupees) words += three(rupees);
  return words.trim();
}

function amountInWords(paise: unknown): string {
  const total = Number(paise);
  const rupees = Math.floor(total / 100);
  const p = total % 100;
  let text = `Rupees ${rupeesInWords(rupees)}`;
  if (p) text += ` and ${rupeesInWords(p)} Paise`;
  return text + " only";
}

// deno-lint-ignore no-explicit-any
function companyHeader(seller: any) {
  const coName = seller?.trade_name || seller?.legal_name || "Safe Creatives";
  const coAddress = seller
    ? [seller.address_line, seller.city, seller.state_name && `${seller.state_name} ${seller.pin_code || ""}`.trim()]
        .filter(Boolean)
        .join(", ")
    : "Chennai, Tamil Nadu";
  const coContact = seller
    ? [seller.phone && `Ph: ${seller.phone}`, seller.email].filter(Boolean).join("  ·  ")
    : "";
  return { coName, coAddress, coContact };
}

// ---------------------------------------------------------------------------
// The warm email body — a thank-you note plus the receipt details
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function buildReceiptEmailHtml(receipt: any, seller: any): string {
  const { coName } = companyHeader(seller);
  const projectNo = receipt.turnkey_projects?.project_number;

  const row = (label: string, value: unknown) =>
    value == null || value === ""
      ? ""
      : `<tr><td style="padding:7px 18px 7px 0;color:#777;font-size:13px;white-space:nowrap;">${label}</td>` +
        `<td style="padding:7px 0;font-size:14px;font-weight:600;">${escapeHtml(value)}</td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#171717">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px;">
    <p style="font-size:12px;letter-spacing:.14em;color:#6f222a;margin:0 0 6px;">PAYMENT RECEIVED</p>
    <h2 style="margin:0 0 14px;font-size:22px;">Thank you${receipt.client_name ? `, ${escapeHtml(receipt.client_name)}` : ""}!</h2>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;">
      Thank you for your payment. We're grateful for your trust in ${escapeHtml(coName)}.
      Please find your receipt attached below, with the details for your records.
    </p>

    <table style="border-collapse:collapse;margin:0 0 8px;">
      ${row("Receipt code", receipt.receipt_number)}
      ${row("Milestone", receipt.receipt_name)}
      ${row("Payment date", fmtDate(receipt.receipt_date))}
      ${row("Amount received", money(receipt.amount_paise))}
      ${row("Mode of payment", receipt.payment_mode)}
      ${row("Project", projectNo != null ? `#${projectNo}${receipt.project_name ? ` — ${receipt.project_name}` : ""}` : receipt.project_name)}
    </table>

    ${receipt.notes ? `<p style="margin:14px 0 0;padding:12px 14px;background:#faf7f2;border-left:3px solid #6f222a;font-size:13px;white-space:pre-line;">${escapeHtml(receipt.notes)}</p>` : ""}

    <p style="margin:22px 0 0;font-size:13px;color:#555;line-height:1.6;">
      If anything looks off, just reply to this email and we'll help.<br />
      Warm regards,<br />${escapeHtml(coName)}
    </p>
  </div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// The printable receipt document (rendered to PDF) — mirrors public/receipt.html
// ---------------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
function buildReceiptDocumentHtml(receipt: any, seller: any): string {
  const { coName, coAddress, coContact } = companyHeader(seller);
  const line = (label: string, value: unknown) =>
    value ? `<div class="r-line"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>` : "";

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; }
    body { background: #fff; font: 13px/1.55 "Segoe UI", Arial, sans-serif; color: #171717; }
    .sheet { width: 100%; padding: 4mm; }
    .r-head { display: flex; justify-content: space-between; gap: 24px; padding-bottom: 16px; border-bottom: 2px solid #0c4444; }
    .r-co-name { font-size: 21px; font-weight: 700; letter-spacing: .01em; color: #0c4444; }
    .r-co-sub { margin-top: 3px; color: #444; font-size: 12px; }
    .r-title { text-align: right; white-space: nowrap; }
    .r-title-word { font-size: 22px; font-weight: 700; letter-spacing: .18em; color: #6f222a; }
    .r-num { margin-top: 6px; font-size: 13px; font-weight: 600; }
    .r-date { color: #555; font-size: 12px; }
    .r-body { margin-top: 22px; }
    .r-line { display: flex; gap: 10px; margin-bottom: 9px; font-size: 13px; }
    .r-line > span { flex: 0 0 170px; color: #777; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding-top: 2px; }
    .r-line > strong { font-weight: 600; }
    .r-amount { display: flex; justify-content: space-between; align-items: center; gap: 20px; margin: 22px 0; padding: 16px 18px; background: #f4f6f3; border: 1px solid rgba(12,68,68,.2); }
    .r-amount-words { font-size: 13px; }
    .r-amount-words b { text-transform: uppercase; letter-spacing: .04em; }
    .r-amount-fig { font-size: 24px; font-weight: 700; color: #0c4444; white-space: nowrap; }
    .r-meta { display: flex; flex-wrap: wrap; gap: 10px 40px; margin-top: 18px; }
    .r-meta div { font-size: 13px; }
    .r-meta span { display: block; color: #777; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
    .r-note-block { margin-top: 18px; padding: 12px 14px; background: #faf7f2; border-left: 3px solid #6f222a; font-size: 12.5px; white-space: pre-line; }
    .r-note-block span { display: block; color: #777; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 3px; }
    .r-foot { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; margin-top: 48px; }
    .r-note { color: #888; font-size: 11px; font-style: italic; max-width: 60%; }
    .r-sign { text-align: center; font-size: 12px; }
    .r-sign-line { width: 170px; margin: 0 0 6px auto; border-top: 1px solid #333; }
    @page { size: A4; margin: 14mm; }
  </style></head><body>
    <div class="sheet">
      <div class="r-head">
        <div>
          <div class="r-co-name">${escapeHtml(coName)}</div>
          <div class="r-co-sub">${escapeHtml(coAddress)}</div>
          ${coContact ? `<div class="r-co-sub">${escapeHtml(coContact)}</div>` : ""}
          ${seller?.gstin ? `<div class="r-co-sub">GSTIN: ${escapeHtml(seller.gstin)}</div>` : ""}
        </div>
        <div class="r-title">
          <div class="r-title-word">RECEIPT</div>
          <div class="r-num">${escapeHtml(receipt.receipt_number)}</div>
          <div class="r-date">${fmtDate(receipt.receipt_date)}</div>
        </div>
      </div>

      <div class="r-body">
        ${line("Received with thanks from", receipt.client_name)}
        ${line("Phone", receipt.client_phone)}
        ${line("Project", receipt.project_name)}
        ${line("Site address", receipt.site_address)}

        <div class="r-amount">
          <div class="r-amount-words"><b>${escapeHtml(amountInWords(receipt.amount_paise))}</b></div>
          <div class="r-amount-fig">${money(receipt.amount_paise)}</div>
        </div>

        <div class="r-meta">
          <div><span>Towards</span>${escapeHtml(receipt.receipt_name)}</div>
          <div><span>Mode of payment</span>${escapeHtml(receipt.payment_mode)}</div>
          <div><span>Date</span>${fmtDate(receipt.receipt_date)}</div>
        </div>

        ${receipt.notes ? `<div class="r-note-block"><span>Note</span>${escapeHtml(receipt.notes)}</div>` : ""}
      </div>

      <div class="r-foot">
        <div class="r-note">This is a computer-generated receipt and does not require a physical signature.</div>
        <div class="r-sign">
          <div class="r-sign-line"></div>
          For ${escapeHtml(coName)}<br />Authorised signatory
        </div>
      </div>
    </div>
  </body></html>`;
}

// Renders the document HTML to a PDF via PDFShift, base64-encoded for Resend.
// Returns null if the service is not configured, so the email can still go out.
async function renderReceiptPdf(html: string): Promise<string | null> {
  const apiKey = Deno.env.get("PDFSHIFT_API_KEY");
  if (!apiKey) {
    console.warn("PDFSHIFT_API_KEY not set; sending receipt email without PDF.");
    return null;
  }
  const res = await fetch("https://api.pdfshift.io/v3/convert/pdf", {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`api:${apiKey}`)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ source: html, use_print: true, sandbox: false }),
  });
  if (!res.ok) throw new Error(`PDFShift ${res.status}: ${await res.text()}`);
  return bytesToBase64(new Uint8Array(await res.arrayBuffer()));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
