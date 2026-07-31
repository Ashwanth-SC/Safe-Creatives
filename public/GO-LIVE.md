# Going live — safecreatives.com

Work top to bottom. Grouped by area; each item says who does it.

---

## 1. Host the static site

The site is plain HTML/CSS/JS — any static host works, all with free tiers,
custom domains and automatic HTTPS. **Recommended: Netlify or Cloudflare Pages.**

- [ ] Create an account and a new site.
- [ ] Deploy this folder. Two ways:
  - **Drag-and-drop:** zip the web files and drop them in. Simplest.
  - **Git-connected (better):** push the repo to GitHub, connect it, auto-deploy on every push.
- [ ] **Do not publish the non-web files.** `migrations/`, `supabase/`,
  `database-schema.sql`, `seed-catalog.sql`, `dev-server.py`, `SUPABASE-SETUP.md`,
  `GO-LIVE.md`, `.claude/` are not meant to be public. Netlify: set a publish
  ignore, or move the web files into a `public/` subfolder and point the host at it.
  (These contain no secrets, but there is no reason to serve them.)

## 2. Point the domain

- [ ] At your domain registrar for `safecreatives.com`, add the DNS records the
  host gives you (usually a CNAME for `www` and an A/ALIAS for the apex).
- [ ] Decide apex vs www. The site is built for the **apex `safecreatives.com`**
  (canonical, sitemap). Set the host to redirect `www.safecreatives.com` →
  `safecreatives.com` so both work and only one is canonical.
- [ ] Confirm HTTPS is issued (the host does this automatically; can take a few
  minutes to an hour). The whole site must be `https://` — Razorpay requires it.

## 3. Supabase — production configuration

- [ ] **Upgrade to Pro (~$25/mo).** Free-tier projects pause when idle; a live
  site with a paused backend is a dead site. This is not optional for production.
- [ ] **Auth → URL Configuration:** Site URL = `https://safecreatives.com`.
  Redirect URLs: add `https://safecreatives.com/**` (keep `http://localhost:8000/**`
  only while you still test locally).
- [ ] **Custom SMTP still on** (Resend) and the **auth email rate limit raised** —
  built-in email will throttle real signups.
- [ ] Confirm **all migrations 001–017 are applied**, seed data loaded, and both
  admins set (`is_admin = true` for ashwanth@ and sashwanth@safecreatives.com).
  - ⚠️ **Migration 017 reset every colour price to ₹0** (pricing moved onto each
    size × colour). The catalog will show ₹0 until you re-enter prices in the
    admin — see section 6. 017 also added `seller_settings.advance_amount_paise`,
    which is now where the advance lives (no longer an env var).

## 4. Edge Function secrets

Set these for the live domain (`supabase secrets set ...`), then redeploy the
functions:

- [ ] `SITE_ORIGIN=https://safecreatives.com` (locks CORS; add `,http://localhost:8000` only if still testing).
- [ ] `PUBLIC_SITE_URL=https://safecreatives.com` (so invoice emails link correctly).
- [ ] **Advance is no longer an env var.** It lives in `seller_settings.advance_amount_paise`
  and is set in the catalog admin (section 6). `ADVANCE_PAISE` is only a fallback
  if that row can't be read — you can leave it unset.
- [ ] Confirm live values are set: `RAZORPAY_KEY_ID`/`_SECRET` (rzp_live_…),
  `RAZORPAY_WEBHOOK_SECRET`, `RESEND_API_KEY`, `PDFSHIFT_API_KEY`,
  `INVOICE_FROM_EMAIL` (on the Resend-verified domain), `WARRANTY_PDF_URL`
  (warranty PDF in public Storage, linked from invoice emails).
- [ ] Deploy **all four** functions:
  ```
  supabase functions deploy create-order
  supabase functions deploy revise-order
  supabase functions deploy create-installment-link
  supabase functions deploy payment-webhook --no-verify-jwt
  ```

## 5. Payments & email

- [ ] Razorpay in **Live mode**, KYC complete, **Payment Links enabled** (used for
  the 80% / 20% installments), webhook pointing at
  `https://zcdcalwgyvlcawcflojl.supabase.co/functions/v1/payment-webhook` with
  events `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`,
  and **`payment_link.paid`** (confirms installment payments).
- [ ] Resend: `safecreatives.com` domain **Verified** (SPF/DKIM), sender on that domain.
- [ ] Decide the refund-fee policy wording (Razorpay keeps its ~2% + GST on refunds).

## 6. Real business content (before the first real customer)

- [ ] **Prices & HSN on every colour.** Migration 017 reset all colour prices to
      ₹0, so in the catalog admin set the **Price + HSN/SAC on each size × colour**
      for every product. The package total is the sum of the selected colours, so
      nothing is priced until this is done.
- [ ] **Advance amount + advance HSN/SAC** in the admin → *Invoice & advance
      settings* (e.g. ₹8,999). This is the single figure charged to reserve any
      order; the checkout reads it live.
- [ ] **`seller_settings`:** real legal name, **GSTIN**, PAN, address, bank details.
      Until the GSTIN is set, invoices print "GSTIN pending registration".
- [ ] **HSN/SAC codes** — confirm all classifications (per-colour goods HSN and the
      advance SAC) with your CA.
- [ ] **Terms & conditions:** replace the placeholder `v1` text (publish a new
      version, don't edit v1).
- [ ] **Product & cover images** hosted in Supabase Storage (not Unsplash/Drive).
- [ ] Web3Forms access key set on the turnkey form (done).

## 7. Launch test (on the live domain)

- [ ] Sign up with a real email → OTP arrives → register.
- [ ] Configure a package → save → review → **pay the real advance** with a live method.
- [ ] Confirm: order `advance_paid`, the total equals the colour prices you entered,
      invoice appears in the dashboard, invoice email with PDF lands (not spam).
- [ ] Refund that test payment from Razorpay to confirm the refund path + webhook.

## 8. After launch

- [ ] **Google Search Console:** add `safecreatives.com`, submit `sitemap.xml`.
- [ ] Add a proper 1200×630 social share image and point `og:image` at it.
- [ ] Catalog pages are already public (browse before login), so they can rank —
      just confirm they are indexed in Search Console.
- [ ] Reconcile `database-schema.sql` / `seed-catalog.sql` with migrations 001–017
      (only matters for a fresh DB, but they are currently out of date).
