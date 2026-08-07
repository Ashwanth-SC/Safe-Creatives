// ============================================================================
// send-turnkey-document — email a signed project document to the client
// ============================================================================
//
// Called by an admin from the Turnkey document view page (and the dashboard
// list). It:
//
//   1. checks the caller is a signed-in admin,
//   2. loads the document row + its project (the client's email lives on the
//      project),
//   3. downloads the uploaded file from the private 'turnkey-documents' bucket
//      using the service role,
//   4. emails it to the client via Resend with a warm greeting and the details
//      (document name, annexure, document number, signing date, project).
//
// Reuses RESEND_API_KEY + INVOICE_FROM_EMAIL. If the client has no email on
// file the document is left untouched and { ok: false, reason: "no_email" } is
// returned so the dashboard can say so without treating it as an error.
//
// Needs migration 020-turnkey-documents.sql. Deploy:
//   supabase functions deploy send-turnkey-document
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
  const id = String(body.id ?? "").trim();
  if (!id) return json({ error: "Missing document id." }, 400);

  // --- Load the document + its project (the email lives on the project) ------
  const { data: doc, error: docError } = await admin
    .from("turnkey_documents")
    .select("*, turnkey_projects ( project_number, client_email )")
    .eq("id", id)
    .maybeSingle();
  if (docError) {
    console.error("Document lookup failed:", docError);
    return json({ error: "Could not load the document." }, 500);
  }
  if (!doc) return json({ error: "Document not found." }, 404);

  const clientEmail =
    String(doc.turnkey_projects?.client_email ?? doc.client_email ?? "").trim();
  if (!clientEmail) return json({ ok: false, reason: "no_email" });

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; cannot email document.");
    return json({ ok: false, reason: "email_not_configured" });
  }

  // --- Download the file from storage (best effort) --------------------------
  let attachment: { filename: string; content: string } | null = null;
  try {
    const { data: blob, error: dlError } = await admin.storage
      .from("turnkey-documents")
      .download(doc.storage_path);
    if (dlError) throw dlError;
    if (blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      attachment = {
        filename: doc.file_name || `${safeFileName(doc.document_type || "document")}.pdf`,
        content: bytesToBase64(bytes),
      };
    }
  } catch (dlError) {
    // Without the file we cannot deliver the document, so this is a hard failure
    // (unlike the receipt PDF, which is only a convenience copy).
    console.error("Document download failed:", dlError);
    return json({ error: "Could not read the document file." }, 500);
  }

  const { data: seller } = await admin.from("seller_settings").select("*").maybeSingle();

  const from =
    Deno.env.get("INVOICE_FROM_EMAIL") ?? "Safe Creatives <noreply@safecreatives.com>";
  const docLabel = doc.annexure_name
    ? `${doc.document_type} — ${doc.annexure_name}`
    : doc.document_type;

  const payload: Record<string, unknown> = {
    from,
    to: [clientEmail],
    subject: `${docLabel}${doc.document_number ? ` (${doc.document_number})` : ""}`,
    html: buildDocumentEmailHtml(doc, seller, docLabel),
  };
  if (seller?.email) payload.reply_to = String(seller.email);
  if (attachment) payload.attachments = [attachment];

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

  // Record that it went out (best effort — the email already succeeded).
  await admin.from("turnkey_documents").update({ emailed_at: new Date().toISOString() }).eq("id", id);

  console.log("Document", id, "emailed to", clientEmail);
  return json({ ok: true, to: clientEmail });
});

// ---------------------------------------------------------------------------
// Helpers
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

function fmtDate(ymd: unknown): string {
  if (!ymd) return "—";
  const [y, m, d] = String(ymd).split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d} ${months[Number(m) - 1] || m} ${y}`;
}

// deno-lint-ignore no-explicit-any
function buildDocumentEmailHtml(doc: any, seller: any, docLabel: string): string {
  const coName = seller?.trade_name || seller?.legal_name || "Safe Creatives";
  const projectNo = doc.turnkey_projects?.project_number;

  const row = (label: string, value: unknown) =>
    value == null || value === ""
      ? ""
      : `<tr><td style="padding:7px 18px 7px 0;color:#777;font-size:13px;white-space:nowrap;">${label}</td>` +
        `<td style="padding:7px 0;font-size:14px;font-weight:600;">${escapeHtml(value)}</td></tr>`;

  return `<!doctype html>
<html><body style="margin:0;background:#f5f5f3;font-family:Arial,Helvetica,sans-serif;color:#171717">
  <div style="max-width:560px;margin:0 auto;padding:28px 22px;">
    <p style="font-size:12px;letter-spacing:.14em;color:#6f222a;margin:0 0 6px;">PROJECT DOCUMENT</p>
    <h2 style="margin:0 0 14px;font-size:22px;">Hello${doc.client_name ? `, ${escapeHtml(doc.client_name)}` : ""},</h2>
    <p style="margin:0 0 18px;font-size:14px;line-height:1.6;">
      Thank you for your continued trust in ${escapeHtml(coName)}. Please find your
      <strong>${escapeHtml(docLabel)}</strong> attached below, with the details for your records.
    </p>

    <table style="border-collapse:collapse;margin:0 0 8px;">
      ${row("Document", doc.document_type)}
      ${row("Reference", doc.annexure_name)}
      ${row("Document number", doc.document_number)}
      ${row("Date of signing", doc.signed_date ? fmtDate(doc.signed_date) : "")}
      ${row("Project", projectNo != null ? `#${projectNo}${doc.project_name ? ` — ${doc.project_name}` : ""}` : doc.project_name)}
    </table>

    ${doc.notes ? `<p style="margin:14px 0 0;padding:12px 14px;background:#faf7f2;border-left:3px solid #6f222a;font-size:13px;white-space:pre-line;">${escapeHtml(doc.notes)}</p>` : ""}

    <p style="margin:22px 0 0;font-size:13px;color:#555;line-height:1.6;">
      Warm regards,<br />${escapeHtml(coName)}
    </p>
  </div>
</body></html>`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
