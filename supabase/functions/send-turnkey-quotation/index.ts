// ============================================================================
// send-turnkey-quotation — email the customer their quotation as a PDF
// ============================================================================
//
// Called by an admin from the Quotation export window. The client generates the
// quotation PDF (html2pdf) and posts it here as base64; this function:
//   1. checks the caller is a signed-in admin,
//   2. loads the project (the client email lives there),
//   3. emails the PDF as an attachment via Resend.
//
// Reuses RESEND_API_KEY + INVOICE_FROM_EMAIL (like send-turnkey-document). If
// the project has no client email, returns { ok:false, reason:"no_email" } so
// the UI can say so without treating it as an error.
//
// Deploy: supabase functions deploy send-turnkey-quotation
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeadersFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get("SITE_ORIGIN") ?? "*").split(",").map((v) => v.trim()).filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  const allow = configured.includes("*") ? "*" : configured.includes(origin) ? origin : configured[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const escapeHtml = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);
  const { data: userRes, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userRes?.user) return json({ error: "Not signed in" }, 401);
  const { data: me } = await admin.from("profiles").select("is_admin").eq("id", userRes.user.id).maybeSingle();
  if (!me?.is_admin) return json({ error: "Admins only" }, 403);

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const projectId = String(body.project_id ?? "").trim();
  const pdfBase64 = String(body.pdf_base64 ?? "").trim();
  const filename = String(body.filename ?? "Quotation.pdf").trim() || "Quotation.pdf";
  if (!projectId) return json({ error: "Missing project." }, 400);
  if (!pdfBase64) return json({ error: "Missing PDF." }, 400);

  const { data: project, error: projErr } = await admin
    .from("turnkey_projects")
    .select("project_number, client_name, client_email")
    .eq("id", projectId)
    .maybeSingle();
  if (projErr) return json({ error: "Could not load the project." }, 500);
  if (!project) return json({ error: "Project not found." }, 404);

  const clientEmail = String(project.client_email ?? "").trim();
  if (!clientEmail) return json({ ok: false, reason: "no_email" });

  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json({ ok: false, reason: "email_not_configured" });

  const { data: seller } = await admin.from("seller_settings").select("legal_name, trade_name, email, phone").maybeSingle();
  const sellerName = seller?.trade_name || seller?.legal_name || "Safe Creatives";
  const from = Deno.env.get("INVOICE_FROM_EMAIL") ?? "Safe Creatives <noreply@safecreatives.com>";

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
    <p>Dear ${escapeHtml(project.client_name || "Customer")},</p>
    <p>Please find attached your quotation${project.project_number ? ` (Project #${escapeHtml(project.project_number)})` : ""} from ${escapeHtml(sellerName)}.</p>
    <p>Do reach out if you have any questions or would like any changes.</p>
    <p>Warm regards,<br/>${escapeHtml(sellerName)}${seller?.phone ? `<br/>${escapeHtml(seller.phone)}` : ""}</p>
  </div>`;

  const payload: Record<string, unknown> = {
    from,
    to: [clientEmail],
    subject: `Your quotation from ${sellerName}${project.project_number ? ` — Project #${project.project_number}` : ""}`,
    html,
    attachments: [{ filename: filename.endsWith(".pdf") ? filename : `${filename}.pdf`, content: pdfBase64 }],
  };
  if (seller?.email) payload.reply_to = String(seller.email);

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

  console.log("Quotation for project", projectId, "emailed to", clientEmail);
  return json({ ok: true, to: clientEmail });
});
