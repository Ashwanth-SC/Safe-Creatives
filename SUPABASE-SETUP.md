# Supabase setup

Everything to configure in the Supabase dashboard, in order. Roughly 20 minutes.

Your project ref is `zcdcalwgyvlcawcflojl` (from `supabase-client.js`).

---

## 1. Run the schema

**Dashboard → SQL Editor → New query.**

Paste the whole of `database-schema.sql`, run it. Then do the same for
`seed-catalog.sql`.

The seed ends with a verification query. You should see:

| key | base_price_rupees | products | colours | addons |
| --- | --- | --- | --- | --- |
| living-room | 185000 | 3 | 9 | 3 |
| bedroom | 165000 | 3 | 9 | 3 |

If the numbers differ, something failed partway — read the error and re-run.
Both files are safe to run more than once.

> These scripts assume an **empty** database. If `profiles`, `carts`,
> `cart_packages`, or `cart_addons` already exist from the earlier draft,
> drop them first or the `create table` statements will error.

### If you ran the schema before 19 July 2026

An earlier version was missing the `grant` statements, so the site failed
with **`permission denied for table packages`** — RLS policies alone are not
enough, the roles also need table privileges. Run this once:

```sql
grant usage on schema public to anon, authenticated;

grant select on
  packages, package_products, product_colours, package_addons
  to anon, authenticated;

grant select, insert, update on profiles to authenticated;

grant select, insert, update, delete on
  carts, cart_items, cart_item_colours, cart_item_addons
  to authenticated;

grant select on
  orders, order_items, order_item_colours, order_item_addons,
  payments, refunds
  to authenticated;

grant select on cart_item_totals, cart_totals to authenticated;
```

Verify with, from the browser console on the running site:

```js
await sb.from('packages').select('key, base_price_paise')
```

You should get two rows without signing in. That single call proves the anon
key, the grants, and the public-read policy all line up.

Also run this once — an early version made `profiles.email` unique, which
could leave an account with no profile row and break "Save to cart" with a
foreign key error:

```sql
alter table profiles drop constraint if exists profiles_email_key;

delete from profiles p
where not exists (select 1 from auth.users u where u.id = p.id);

insert into public.profiles (id, email, full_name)
select u.id, u.email, coalesce(u.raw_user_meta_data ->> 'full_name', '')
from auth.users u
where not exists (select 1 from profiles p where p.id = u.id);
```

Then re-run section 9 of `database-schema.sql` to pick up the current
`handle_new_user`.

---

## 2. Email OTP — the one that will catch you out

`login.js` calls `verifyOtp()` with a **6-digit code**. Out of the box,
Supabase emails a **magic link** instead, and the login form will never work.

**Dashboard → Authentication → Emails → Magic Link template.**

Replace the template body with something that includes `{{ .Token }}`:

```html
<h2>Your Safe Creatives verification code</h2>
<p>Enter this code to continue:</p>
<p style="font-size:28px; letter-spacing:6px;"><strong>{{ .Token }}</strong></p>
<p>The code expires in one hour. If you didn't request it, ignore this email.</p>
```

The key change is `{{ .Token }}` (the 6-digit code) instead of
`{{ .ConfirmationURL }}` (the magic link).

Then under **Authentication → Providers → Email**, confirm:

- **Enable Email provider** — on
- **Confirm email** — off (OTP verification already proves they own the address)

---

## 3. Email sending limits

**Dashboard → Project Settings → Auth → SMTP Settings.**

Supabase's built-in email sender is rate limited to a handful of messages per
hour and is explicitly not for production. With OTP login that limit is your
signup capacity — a few customers in a row and the rest silently get nothing.

Set up custom SMTP before you launch. Resend, SendGrid, and Amazon SES all
work. You'll need a verified sending domain for `safecreatives.com`.

While testing, if codes stop arriving, this is almost certainly why.

---

## 4. URL configuration

**Dashboard → Authentication → URL Configuration.**

- **Site URL** — where the site is actually hosted. `http://localhost:8000`
  while developing.
- **Redirect URLs** — add every origin you'll use, one per line:
  ```
  http://localhost:8000/**
  https://your-production-domain.com/**
  ```

---

## 5. Verify RLS is actually on

This is the check that matters. **Dashboard → Authentication → Policies.**

Every table must show **RLS enabled**. Specifically confirm:

| Table | Expected |
| --- | --- |
| `profiles` | 3 policies, all scoped to `auth.uid()` |
| `orders` | 1 policy, **SELECT only** |
| `payments` | 1 policy, **SELECT only** |
| `payment_events` | RLS enabled, **zero policies** |
| `packages` and other catalog tables | 1 public SELECT policy each |

If `orders` or `payments` shows an INSERT or UPDATE policy, remove it. A
browser that can write those tables can mark its own order paid.

`payment_events` having no policies is intentional, not an oversight — no
client role should ever read raw gateway payloads.

### Prove it works

**SQL Editor**, with two test accounts signed up:

```sql
-- Should return only the rows belonging to that user.
select auth.uid();
select count(*) from profiles;   -- expect 1, not 2
```

Note the SQL Editor runs as a superuser by default and bypasses RLS. The
honest test is from the browser: sign in as user A, open devtools, and run
`await supabase.from('profiles').select('*')`. You must get exactly one row.

---

## 6. Deploy the Edge Function

This needs the Supabase CLI, which isn't installed on your machine yet.

```powershell
winget install --id Supabase.CLI
```

Then, from the project folder:

```bash
supabase login
supabase link --project-ref zcdcalwgyvlcawcflojl
supabase functions deploy create-order
```

### Function secrets

**Dashboard → Edge Functions → Manage secrets**, or via CLI:

```bash
supabase secrets set ADVANCE_PERCENT=20
supabase secrets set SITE_ORIGIN=https://your-production-domain.com
```

- `ADVANCE_PERCENT` — the refundable advance, default 20. Changing it here
  changes what customers are charged; `checkout.js` only *displays* the
  number, so update the `ADVANCE_PERCENT` constant there to match.
- `SITE_ORIGIN` — locks CORS to your domain. Defaults to `*`, which is fine
  for local development and sloppy for production.

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically —
do not set them yourself, and never put the service role key in any file
under this folder. It bypasses RLS entirely.

---

## 7. What is still not wired up

**Payments.** The `create-order` function reserves an order and computes the
advance, but charges nothing. `payment_session` comes back `null`.

Finishing it needs a provider decision, then two pieces:

1. In `create-order`, create a payment session for `advance_amount_paise`,
   insert a `payments` row, return the session to the browser.
2. A **new** `payment-webhook` function that the gateway calls
   server-to-server: verify the signature, log to `payment_events`, then
   move the payment to `captured` and the order to `advance_paid`.

The order must never be marked paid by the browser. Anything the checkout
page can call, a customer can call directly with any arguments they like.

---

## Checklist

- [ ] `database-schema.sql` run, no errors
- [ ] `seed-catalog.sql` run, verification query matches the table above
- [ ] Magic Link email template uses `{{ .Token }}`
- [ ] Custom SMTP configured
- [ ] Site URL and redirect URLs set
- [ ] RLS enabled on all 16 tables, `orders`/`payments` SELECT-only
- [ ] Cross-account read tested from the browser, returns one row
- [ ] Supabase CLI installed and project linked
- [ ] `create-order` deployed, secrets set
