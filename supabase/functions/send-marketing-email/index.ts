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

// One-click unsubscribe token — HMAC-SHA256(email, service role key). The
// public `unsubscribe` function recomputes it the same way to verify the link.
async function unsubToken(email: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(email.trim().toLowerCase()));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

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
  const doExport = reqBody.export === true;
  const testEmail = String(reqBody.test_email ?? "").trim();
  // When the dashboard sends a hand-picked subset it passes `recipients`. We
  // only ever INTERSECT it with the server-computed audience, so an admin can
  // narrow the list but never email an address the audience rule didn't allow.
  const picked = Array.isArray(reqBody.recipients)
    ? new Set((reqBody.recipients as unknown[]).map((e) => String(e).trim().toLowerCase()))
    : null;

  const VALID = new Set(["abandoned_cart", "registered_new", "registered_old", "registered_no_activity"]);
  if (!doExport && !VALID.has(category)) {
    return json({ error: "Unknown audience." }, 400);
  }

  // --- Load everything the audience / export needs (service role) ------------
  const [cartsRes, totalsRes, ordersRes, profilesRes, unsubRes, sendsRes] = await Promise.all([
    admin.from("carts").select("id, user_id").eq("status", "active"),
    admin.from("cart_totals").select("cart_id, item_count"),
    admin.from("orders").select("user_id"),
    admin.from("profiles").select("id, email, is_admin, full_name, phone, city, state_name, pin_code, created_at"),
    admin.from("marketing_unsubscribes").select("email"),
    admin.from("marketing_sends").select("email, first_sent_at, last_sent_at, send_count"),
  ]);
  if (profilesRes.error) return json({ error: "Could not load registrations." }, 500);

  // Opted-out addresses are excluded from both the count and the send.
  const unsubSet = new Set((unsubRes.data ?? []).map((u) => String(u.email).toLowerCase()));
  const itemCount = new Map((totalsRes.data ?? []).map((t) => [t.cart_id, Number(t.item_count) || 0]));
  const abandonedUserIds = new Set(
    (cartsRes.data ?? []).filter((c) => (itemCount.get(c.id) || 0) > 0).map((c) => c.user_id)
  );
  const orderCount = new Map<string, number>();
  for (const o of ordersRes.data ?? []) {
    if (o.user_id) orderCount.set(o.user_id, (orderCount.get(o.user_id) || 0) + 1);
  }
  // email -> prior marketing-send record (presence means "already emailed").
  const sendByEmail = new Map((sendsRes.data ?? []).map((s) => [String(s.email).toLowerCase(), s]));

  // Which segment a profile belongs to — mutually exclusive, in priority order.
  const segmentOf = (hasOrder: boolean, hasCart: boolean, emailed: boolean) =>
    hasOrder ? "Customer" : hasCart ? "Abandoned cart" : emailed ? "Old registration" : "New registration";

  // --- CSV export: every registered (non-staff) profile, classified ----------
  if (doExport) {
    const rows = (profilesRes.data ?? [])
      .filter((p) => !p.is_admin)
      .map((p) => {
        const key = String(p.email ?? "").trim().toLowerCase();
        const hasOrder = (orderCount.get(p.id) || 0) > 0;
        const hasCart = abandonedUserIds.has(p.id);
        const sent = key ? sendByEmail.get(key) : null;
        return {
          name: p.full_name ?? "",
          email: p.email ?? "",
          phone: p.phone ?? "",
          city: p.city ?? "",
          state: p.state_name ?? "",
          pin_code: p.pin_code ?? "",
          registered_at: p.created_at ?? "",
          segment: segmentOf(hasOrder, hasCart, !!sent),
          emailed: sent ? "Yes" : "No",
          last_emailed_at: sent?.last_sent_at ?? "",
          emails_sent: sent?.send_count ?? 0,
          has_abandoned_cart: hasCart ? "Yes" : "No",
          unsubscribed: key && unsubSet.has(key) ? "Yes" : "No",
          orders_placed: orderCount.get(p.id) || 0,
        };
      });
    return json({ ok: true, profiles: rows });
  }

  // --- Compute the email audience for the chosen category --------------------
  const seen = new Set<string>();
  const recipients: string[] = [];
  for (const p of profilesRes.data ?? []) {
    const email = String(p.email ?? "").trim();
    if (!email || p.is_admin) continue;
    const key = email.toLowerCase();
    if (seen.has(key) || unsubSet.has(key)) continue;

    const hasCart = abandonedUserIds.has(p.id);
    const hasOrder = (orderCount.get(p.id) || 0) > 0;
    const emailed = sendByEmail.has(key);
    const noActivity = !hasCart && !hasOrder;

    let include = false;
    if (category === "abandoned_cart") include = hasCart;
    else if (category === "registered_new") include = noActivity && !emailed;
    else if (category === "registered_old") include = noActivity && emailed;
    else include = noActivity; // "registered_no_activity" (legacy = new + old)
    if (!include) continue;

    // A real send may narrow the audience to a hand-picked subset; the count
    // (dry run) always reports the full audience so the UI can list it.
    if (!dryRun && picked && !picked.has(key)) continue;

    seen.add(key);
    recipients.push(email);
  }

  if (dryRun) {
    return json({ ok: true, count: recipients.length, emails: recipients });
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

  const functionsBase = `${Deno.env.get("SUPABASE_URL")}/functions/v1`;
  const htmlFor = (email: string, unsubUrl: string) => {
    const prefix = esc(email.split("@")[0]);
    return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222;line-height:1.6">
      <p>Hi ${prefix},</p>
      <p>${bodyHtml}</p>
      <p>Warm regards,<br/>${esc(sellerName)}</p>
      <p style="font-size:12px;color:#8a8f88;border-top:1px solid #eee;margin-top:20px;padding-top:12px">
        You're receiving this because you registered with ${esc(sellerName)}. This mailbox is not monitored — to reach us, email
        <a href="mailto:ashwanth@safecreatives.com">ashwanth@safecreatives.com</a> or call / WhatsApp +91&nbsp;97898&nbsp;90877.
        <br><br>Don't want these emails? <a href="${esc(unsubUrl)}">Unsubscribe with one click</a>.
      </p>
    </div>`;
  };
  // Sent from a no-reply address, so no reply_to — recipients are directed to
  // email / call / WhatsApp, and a one-click unsubscribe link (per recipient).
  const buildEmail = async (to: string) => {
    const unsubUrl = `${functionsBase}/unsubscribe?e=${encodeURIComponent(to)}&t=${await unsubToken(to)}`;
    return {
      from,
      to: [to],
      subject,
      html: htmlFor(to, unsubUrl),
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  };

  // Preview: one email to the tester (uses that address's greeting).
  if (testEmail) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(await buildEmail(testEmail)),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 400);
      console.error("Resend test failed:", res.status, detail);
      return json({ error: `Email service error (${res.status}).`, detail: `${res.status}: ${detail}` }, 502);
    }
    return json({ ok: true, test: true, sent: 1, to: testEmail });
  }

  if (!recipients.length) return json({ ok: true, sent: 0 });

  // The exact text of the first Resend failure, returned to the dashboard so a
  // failed run says WHY (quota, unverified domain, a bad address, …) instead of
  // just a count.
  let firstError: string | null = null;

  // Send one email via Resend's single endpoint. Used as a fallback when a
  // batch is rejected, so one bad address doesn't sink its 99 neighbours.
  const sendOne = async (obj: unknown): Promise<boolean> => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(obj),
    });
    if (res.ok) return true;
    const detail = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (!firstError) firstError = detail;
    return false;
  };

  // Resend's batch endpoint takes up to 100 messages per request but rejects
  // the WHOLE batch if any single message is invalid. So on a batch failure we
  // capture the reason and — unless it's clearly account-wide (auth, billing,
  // rate limit) — retry that chunk one message at a time to salvage the rest.
  const sentEmails: string[] = [];
  let failed = 0;
  for (const group of chunk(recipients, 100)) {
    const objs = await Promise.all(group.map(buildEmail));
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(objs),
    });
    if (res.ok) {
      sentEmails.push(...group);
      continue;
    }
    const detail = `${res.status}: ${(await res.text()).slice(0, 300)}`;
    if (!firstError) firstError = detail;
    console.error("Resend batch failed:", detail);
    // Account-wide problems won't be fixed by retrying — don't hammer the API.
    if ([401, 402, 403, 429].includes(res.status)) {
      failed += group.length;
      continue;
    }
    for (let i = 0; i < objs.length; i++) {
      if (await sendOne(objs[i])) sentEmails.push(group[i]);
      else failed++;
    }
  }

  // Record who we reached, so a "new" registration becomes "old" next time.
  // Prior values come from sendByEmail, so first_sent_at and the count survive.
  if (sentEmails.length) {
    const nowIso = new Date().toISOString();
    const rows = sentEmails.map((e) => {
      const prev = sendByEmail.get(e.toLowerCase());
      return {
        email: e.toLowerCase(),
        first_sent_at: prev?.first_sent_at ?? nowIso,
        last_sent_at: nowIso,
        send_count: (Number(prev?.send_count) || 0) + 1,
        last_category: category,
      };
    });
    const { error: logErr } = await admin.from("marketing_sends").upsert(rows, { onConflict: "email" });
    if (logErr) console.error("Could not record marketing_sends:", logErr.message);
  }

  const sent = sentEmails.length;
  console.log(`Marketing email (${category}) sent to ${sent}, failed ${failed}. First error: ${firstError ?? "none"}`);
  return json({ ok: true, sent, failed, detail: firstError });
});
