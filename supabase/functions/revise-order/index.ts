// ============================================================================
// revise-order — admin-only order changes after a site visit
// ============================================================================
//
// Lets an admin swap a product's chosen size/colour (to another option in the
// SAME package) and set a delivery charge, then recomputes every total on the
// server so the money stays authoritative — a browser never sets a rupee here.
//
//   line total (goods) = base price + option deltas + add-ons
//   subtotal           = sum of line totals
//   total              = subtotal + delivery_charge + 18% GST on both
//   balance (generated) = total - advance  ->  the 80% / 20% installments
//                         recompute off the new balance automatically.
//
// The advance is already paid, so it is left untouched.
//
// Deploy:
//   supabase functions deploy revise-order
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

function corsHeadersFor(req: Request): Record<string, string> {
  const configured = (Deno.env.get("SITE_ORIGIN") ?? "*")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const origin = req.headers.get("Origin") ?? "";
  const allow = configured.includes("*")
    ? "*"
    : configured.includes(origin)
    ? origin
    : configured[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allow,
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
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "Malformed request body" }, 400);
  }

  const orderId: string | undefined = body.order_id;
  const optionChanges: Array<{ id: string; new_option_id: string }> =
    Array.isArray(body.option_changes) ? body.option_changes : [];
  const deliveryChargePaise = Math.max(0, Math.round(Number(body.delivery_charge_paise ?? 0)));

  if (!orderId) return json({ error: "order_id is required" }, 400);

  // --- Load the order --------------------------------------------------------
  const { data: order, error: orderError } = await admin
    .from("orders")
    .select("id, gst_percent, advance_amount_paise, order_items ( id, package_key )")
    .eq("id", orderId)
    .maybeSingle();
  if (orderError) return json({ error: orderError.message }, 500);
  if (!order) return json({ error: "Order not found" }, 404);

  const packageKeyByItem = new Map<string, string>(
    (order.order_items ?? []).map((i: { id: string; package_key: string }) => [i.id, i.package_key])
  );

  // --- Apply the option swaps ------------------------------------------------
  if (optionChanges.length) {
    const rowIds = optionChanges.map((c) => c.id);
    const newIds = optionChanges.map((c) => c.new_option_id);

    // The snapshot rows being replaced (to know their item + which group).
    const { data: rows, error: rowsError } = await admin
      .from("order_item_options")
      .select("id, order_item_id, group_name")
      .in("id", rowIds);
    if (rowsError) return json({ error: rowsError.message }, 500);
    const rowById = new Map((rows ?? []).map((r) => [r.id, r]));

    // The catalog options being applied, with their group + package, so we can
    // validate the swap stays inside the same package and the same group.
    const { data: opts, error: optsError } = await admin
      .from("product_options")
      .select(
        `id, name, finish, material, price_delta_paise,
         product_option_groups ( name, package_products ( packages ( key ) ) )`
      )
      .in("id", newIds);
    if (optsError) return json({ error: optsError.message }, 500);
    const optById = new Map((opts ?? []).map((o) => [o.id, o]));

    for (const change of optionChanges) {
      const row = rowById.get(change.id);
      // deno-lint-ignore no-explicit-any
      const opt: any = optById.get(change.new_option_id);
      if (!row || !opt) return json({ error: "Unknown option or row in changes" }, 400);

      const optPackageKey = opt.product_option_groups?.package_products?.packages?.key;
      const optGroupName = opt.product_option_groups?.name;
      const itemPackageKey = packageKeyByItem.get(row.order_item_id);

      if (optPackageKey !== itemPackageKey) {
        return json({ error: "A chosen option belongs to a different package" }, 400);
      }
      if (optGroupName !== row.group_name) {
        return json(
          { error: `A ${row.group_name} can only be swapped for another ${row.group_name}` },
          400
        );
      }

      const { error: updateError } = await admin
        .from("order_item_options")
        .update({
          option_name: opt.name,
          finish: opt.finish ?? null,
          material: opt.material ?? null,
          price_delta_paise: Number(opt.price_delta_paise ?? 0),
        })
        .eq("id", change.id);
      if (updateError) return json({ error: updateError.message }, 500);
    }
  }

  // --- Recompute every line total and the order totals from scratch ----------
  const { data: items, error: itemsError } = await admin
    .from("order_items")
    .select(
      `id, base_price_paise,
       order_item_options ( price_delta_paise ),
       order_item_addons ( price_paise )`
    )
    .eq("order_id", orderId);
  if (itemsError) return json({ error: itemsError.message }, 500);

  let subtotalPaise = 0;
  for (const item of items ?? []) {
    const optionDelta = (item.order_item_options ?? []).reduce(
      (s: number, o: { price_delta_paise: number }) => s + Number(o.price_delta_paise ?? 0),
      0
    );
    const addonTotal = (item.order_item_addons ?? []).reduce(
      (s: number, a: { price_paise: number }) => s + Number(a.price_paise ?? 0),
      0
    );
    const lineTotal = Number(item.base_price_paise) + optionDelta + addonTotal;
    subtotalPaise += lineTotal;

    const { error: lineError } = await admin
      .from("order_items")
      .update({ line_total_paise: lineTotal })
      .eq("id", item.id);
    if (lineError) return json({ error: lineError.message }, 500);
  }

  const gstPercent = Number(order.gst_percent ?? 18);
  const taxablePaise = subtotalPaise + deliveryChargePaise;
  const gstPaise = Math.round((taxablePaise * gstPercent) / 100);
  const totalPaise = taxablePaise + gstPaise;

  const { data: updated, error: updateError } = await admin
    .from("orders")
    .update({
      subtotal_paise: subtotalPaise,
      delivery_charge_paise: deliveryChargePaise,
      gst_paise: gstPaise,
      total_paise: totalPaise,
    })
    .eq("id", orderId)
    .select("subtotal_paise, delivery_charge_paise, gst_paise, total_paise, advance_amount_paise, balance_paise")
    .single();
  if (updateError) return json({ error: updateError.message }, 500);

  return json({ status: "revised", ...updated });
});
