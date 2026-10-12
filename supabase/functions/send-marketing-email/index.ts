// ============================================================================
// send-marketing-email — email a group of registered customers one common
// message, greeted individually.
// ============================================================================
//
// Called by an admin from the Sensory Rooms dashboard (Marketing tab). The
// recipient list is computed HERE (service role), never trusted from the
// client. Two audiences:
//   * "abandoned_cart"          — profiles with an active, non-empty cart
//   * "registered_no_activity"  — profiles with no abandoned cart AND no order
// Staff accounts (is_admin) and profiles without an email are excluded.
//
// Each recipient gets the same subject + body, greeted with the part of their
// email before the "@". Sent via Resend's batch endpoint (100 per request),
// reusing RESEND_API_KEY + INVOICE_FROM_EMAIL.
//
// Modes (request body):
//   { category, dry_run: true }        -> { ok, count, sample }  (no send)
//   { category, subject, body, test_email } -> sends ONE preview to test_email
//   { category, subject, body }        -> sends to the whole audience
//
// Deploy: supabase functions deploy send-marketing-email
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

const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

Deno.serve(async (req) => {
  const cors = corsHeadersFor(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });

  // --- Caller must be a signed-in admin --------------------------------------
  const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "").trim();
  if (!token) return json({ error: "Not signed in" }, 401);
  const { data: userRes, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userRes?.user) return json({ error: "Not signed in" }, 401);
  const { data: me } = await admin.from("profiles").select("is_admin").eq("id", userRes.user.id).maybeSingle();
  if (!me?.is_admin) return json({ error: "Admins only" }, 403);

  // --- Input -----------------------------------------------------------------
  let reqBody: Record<string, unknown> = {};
  try {
    reqBody = await req.json();
  } catch {
    return json({ error: "Invalid request." }, 400);
  }
  const category = String(reqBody.category ?? "").trim();
  const subject = String(reqBody.subject ?? "").trim();
  const body = String(reqBody.body ?? "");
  const dryRun = reqBody.dry_run === true;
  const testEmail = String(reqBody.test_email ?? "").trim();
  if (category !== "abandoned_cart" && category !== "registered_no_activity") {
    return json({ error: "Unknown audience." }, 400);
  }

  // --- Compute the audience (service role) -----------------------------------
  const [cartsRes, totalsRes, ordersRes, profilesRes] = await Promise.all([
    admin.from("carts").select("id, user_id").eq("status", "active"),
    admin.from("cart_totals").select("cart_id, item_count"),
    admin.from("orders").select("user_id"),
    admin.from("profiles").select("id, email, is_admin"),
  ]);
  if (profilesRes.error) return json({ error: "Could not load registrations." }, 500);

  const itemCount = new Map((totalsRes.data ?? []).map((t) => [t.cart_id, Number(t.item_count) || 0]));
  const abandonedUserIds = new Set(
    (cartsRes.data ?? []).filter((c) => (itemCount.get(c.id) || 0) > 0).map((c) => c.user_id)
  );
  const orderUserIds = new Set((ordersRes.data ?? []).map((o) => o.user_id).filter(Boolean));

  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const p of profilesRes.data ?? []) {
    const email = String(p.email ?? "").trim();
    if (!email || p.is_admin) continue;
    const hasCart = abandonedUserIds.has(p.id);
    const hasOrder = orderUserIds.has(p.id);
    const include = category === "abandoned_cart" ? hasCart : !hasCart && !hasOrder;
    if (!include) continue;
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    recipients.push(email);
  }

  if (dryRun) {
    return json({ ok: true, count: recipients.length, sample: recipients.slice(0, 5) });
  }

  // --- Sending ---------------------------------------------------------------
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) return json({ ok: false, reason: "email_not_configured" });
  if (!subject) return json({ error: "Please add a subject." }, 400);
  if (!body.trim()) return json({ error: "Please add a message." }, 400);

  const { data: seller } = await admin.from("seller_settings").select("legal_name, trade_name, email").maybeSingle();
  const sellerName = seller?.trade_name || seller?.legal_name || "Safe Creatives";
  const from = Deno.env.get("INVOICE_FROM_EMAIL") ?? "Safe Creatives <noreply@safecreatives.com>";
  const bodyHtml = esc(body).replace(/\r?\n/g, "<br>");

  const htmlFor = (email: string) => {
    const prefix = esc(email.split("@")[0]);
    return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
      <p>Hi ${prefix},</p>
      <p>${bodyHtml}</p>
      <p>Warm regards,<br/>${esc(sellerName)}</p>
    </div>`;
  };
  const emailObj = (to: string) => {
    const o: Record<string, unknown> = { from, to: [to], subject, html: htmlFor(to) };
    if (seller?.email) o.reply_to = String(seller.email);
    return o;
  };

  // Preview: one email to the tester (uses that address's greeting).
  if (testEmail) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(emailObj(testEmail)),
    });
    if (!res.ok) {
      console.error("Resend test failed:", res.status, await res.text());
      return json({ error: `Email service error (${res.status}).` }, 502);
    }
    return json({ ok: true, test: true, sent: 1, to: testEmail });
  }

  if (!recipients.length) return json({ ok: true, sent: 0 });

  // Resend batch endpoint: up to 100 messages per request.
  let sent = 0;
  let failed = 0;
  for (const group of chunk(recipients, 100)) {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(group.map(emailObj)),
    });
    if (res.ok) {
      sent += group.length;
    } else {
      failed += group.length;
      console.error("Resend batch failed:", res.status, await res.text());
    }
  }

  console.log(`Marketing email (${category}) sent to ${sent}, failed ${failed}`);
  return json({ ok: true, sent, failed });
});
