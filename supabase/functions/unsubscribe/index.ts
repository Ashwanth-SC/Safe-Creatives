// ============================================================================
// unsubscribe — public one-click opt-out from marketing emails
// ============================================================================
//
// Linked from every marketing email (send-marketing-email). The link carries
// the recipient's email `e` and a token `t` = HMAC-SHA256(email, service role
// key), so it cannot be forged for someone else's address.
//
//   GET  /unsubscribe?e=<email>&t=<token>  -> opt out, redirect to a confirm page
//   POST /unsubscribe?e=<email>&t=<token>  -> opt out, 200 (RFC 8058 one-click)
//
// The opt-out is written to marketing_unsubscribes (migration 052) via the
// service role; send-marketing-email then skips those addresses. The GET
// redirects to a static page on the site because the Supabase gateway serves
// function bodies as text/plain (so an inline HTML page would not render).
//
// MUST be deployed public (no JWT) — it is opened straight from an inbox:
//   supabase functions deploy unsubscribe --no-verify-jwt
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SITE = "https://safecreatives.com";

async function expectedToken(email: string): Promise<string> {
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
  const isPost = req.method === "POST";
  if (req.method !== "GET" && !isPost) return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const email = (url.searchParams.get("e") ?? "").trim();
  const token = (url.searchParams.get("t") ?? "").trim();
  const redirect = (status: string) =>
    new Response(null, { status: 302, headers: { Location: `${SITE}/unsubscribed.html?status=${status}` } });

  if (!email || !token || token !== (await expectedToken(email))) {
    return isPost ? new Response("Invalid link", { status: 400 }) : redirect("invalid");
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );
    await admin.from("marketing_unsubscribes").upsert({ email: email.toLowerCase() }, { onConflict: "email" });
  } catch (e) {
    console.error("Unsubscribe write failed:", e);
    return isPost ? new Response("Error", { status: 500 }) : redirect("error");
  }

  // RFC 8058 one-click (the mail client POSTs) — just acknowledge.
  return isPost ? new Response("Unsubscribed", { status: 200 }) : redirect("done");
});
