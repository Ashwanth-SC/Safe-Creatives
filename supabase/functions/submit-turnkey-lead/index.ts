// ============================================================================
// submit-turnkey-lead — record a turnkey enquiry and notify staff
// ============================================================================
//
// Replaces the old web3forms submission. The public enquiry form on
// turnkey-solutions.html posts here (as an anonymous visitor). The function:
//
//   1. drops obvious bots via the honeypot,
//   2. inserts the lead into turnkey_projects using the service role, which
//      assigns the next running number (from 29) and the timestamp, and
//   3. emails every admin the full details via Resend, so anyone can follow up.
//
// It runs with the service role key (bypasses RLS) but writes ONLY a lead row
// with server-fixed fields (platform 'website', source 'website', status
// 'Lead'); nothing the browser sends can set a number, a status, or a budget.
//
// Needs migration 019-turnkey-crm.sql applied (turnkey_projects).
//
// Deploy:
//   supabase functions deploy submit-turnkey-lead
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

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }

  // Honeypot: a real person leaves botcheck empty. A bot that fills every field
  // trips it — return success so it learns nothing, but save nothing.
  if (body.botcheck) return json({ ok: true });

  const clientName = String(body.full_name ?? "").trim();
  const clientPhone = String(body.phone ?? "").trim();
  if (!clientName || !clientPhone) {
    return json({ error: "Please provide your name and phone number." }, 400);
  }

  const clientEmail = body.email ? String(body.email).trim() : null;
  const pinCode = body.pin_code ? String(body.pin_code).trim() : null;
  const areaValue = body.area_sqft;
  const areaSqft =
    areaValue != null && String(areaValue).trim() !== "" && Number.isFinite(Number(areaValue))
      ? Number(areaValue)
      : null;
  const category = body.project_category ? String(body.project_category).trim() : null;
  const requirement = body.requirement ? String(body.requirement).trim() : null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ----------------------------------------------------------------
  // 1. Save the lead — number + timestamp are assigned by the database
  // ----------------------------------------------------------------
  const { data: lead, error: insertError } = await admin
    .from("turnkey_projects")
    .insert({
      client_name: clientName,
      client_phone: clientPhone,
      client_email: clientEmail,
      platform: "website",
      source: "website",
      status: "Lead",
      pin_code: pinCode,
      area_sqft: areaSqft,
      project_category: category,
      requirement,
    })
    .select("project_number, created_at")
    .single();

  if (insertError) {
    console.error("Turnkey lead insert failed:", insertError);
    return json({ error: "Could not save your enquiry. Please try again." }, 500);
  }

  // ----------------------------------------------------------------
  // 2. Notify staff — best effort. The lead is already saved, so an email
  //    failure must not fail the customer's submission.
  // ----------------------------------------------------------------
  try {
    await notifyAdmins(admin, lead.project_number, {
      clientName,
      clientPhone,
      clientEmail,
      pinCode,
      areaSqft,
      category,
      requirement,
    });
  } catch (mailError) {
    console.error("Admin notification failed (lead still saved):", mailError);
  }

  return json({ ok: true, project_number: lead.project_number });
});

// deno-lint-ignore no-explicit-any
async function notifyAdmins(admin: any, projectNumber: number, d: Record<string, unknown>) {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    console.warn("RESEND_API_KEY not set; skipping admin notification.");
    return;
  }

  const { data: admins, error } = await admin
    .from("profiles")
    .select("email")
    .eq("is_admin", true);
  if (error) throw new Error(error.message);

  const to = (admins ?? []).map((a: { email: string }) => a.email).filter(Boolean);
  if (!to.length) {
    console.warn("No admin emails found; skipping notification.");
    return;
  }

  const from =
    Deno.env.get("LEAD_FROM_EMAIL") ??
    Deno.env.get("INVOICE_FROM_EMAIL") ??
    "Safe Creatives <noreply@safecreatives.com>";
  const siteUrl = Deno.env.get("PUBLIC_SITE_URL")?.replace(/\/+$/, "") ?? null;
  const dashUrl = siteUrl ? `${siteUrl}/turnkey-dashboard.html` : "turnkey-dashboard.html";

  const esc = (v: unknown) =>
    String(v ?? "—").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const row = (label: string, value: unknown) =>
    `<tr><td style="padding:6px 16px 6px 0;color:#777;font-size:13px;white-space:nowrap;">${label}</td>` +
    `<td style="padding:6px 0;font-size:14px;font-weight:600;">${esc(value)}</td></tr>`;

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;color:#171717;max-width:560px;">
      <p style="font-size:12px;letter-spacing:.14em;color:#6f222a;margin:0 0 6px;">NEW TURNKEY ENQUIRY</p>
      <h2 style="margin:0 0 16px;font-size:22px;">Lead #${projectNumber}</h2>
      <table style="border-collapse:collapse;">
        ${row("Name", d.clientName)}
        ${row("Phone", d.clientPhone)}
        ${row("Email", d.clientEmail)}
        ${row("PIN code", d.pinCode)}
        ${row("Area (sq ft)", d.areaSqft)}
        ${row("Category", d.category)}
        ${row("Requirement", d.requirement)}
      </table>
      <p style="margin:20px 0 0;">
        <a href="${dashUrl}" style="background:#6f222a;color:#fff;padding:11px 18px;text-decoration:none;font-size:13px;border-radius:6px;">Open the Turnkey dashboard →</a>
      </p>
      <p style="margin:16px 0 0;color:#888;font-size:12px;">
        Saved automatically as lead #${projectNumber} in your Turnkey Solutions dashboard.
      </p>
    </div>`;

  const payload: Record<string, unknown> = {
    from,
    to,
    subject: `New turnkey enquiry — #${projectNumber} ${d.clientName}`,
    html,
  };
  // So hitting "reply" in the inbox reaches the client directly.
  if (d.clientEmail) payload.reply_to = String(d.clientEmail);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) throw new Error(`Resend ${res.status}: ${await res.text()}`);
  console.log("Turnkey lead", projectNumber, "emailed to", to.length, "admin(s).");
}
