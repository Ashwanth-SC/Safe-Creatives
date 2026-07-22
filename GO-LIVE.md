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
- [ ] Confirm **all migrations 001–010 are applied**, seed data loaded, and both
  admins set (`is_admin = true` for ashwanth@ and sashwanth@safecreatives.com).

## 4. Edge Function secrets

Set these for the live domain (`supabase secrets set ...`), then redeploy both
functions:

- [ ] `SITE_ORIGIN=https://safecreatives.com` (locks CORS; add `,http://localhost:8000` only if still testing).
- [ ] `PUBLIC_SITE_URL=https://safecreatives.com` (so invoice emails link correctly).
- [ ] `ADVANCE_PAISE` — **unset it** so the real ₹8,999 default applies (the ₹5 test override).
- [ ] Confirm live values are set: `RAZORPAY_KEY_ID`/`_SECRET` (rzp_live_…),
  `RAZORPAY_WEBHOOK_SECRET`, `RESEND_API_KEY`, `PDFSHIFT_API_KEY`,
  `INVOICE_FROM_EMAIL` (on the Resend-verified domain).
- [ ] `supabase functions deploy create-order` and `... payment-webhook`.

## 5. Payments & email

- [ ] Razorpay in **Live mode**, KYC complete, webhook pointing at
  `https://zcdcalwgyvlcawcflojl.supabase.co/functions/v1/payment-webhook` with
  events `payment.captured`, `payment.failed`, `refund.processed`, `refund.failed`.
- [ ] Resend: `safecreatives.com` domain **Verified** (SPF/DKIM), sender on that domain.
- [ ] Decide the refund-fee policy wording (Razorpay keeps its ~2% + GST on refunds).

## 6. Real business content (before the first real customer)

- [ ] **`seller_settings`:** real legal name, **GSTIN**, PAN, address, bank details.
      Until the GSTIN is set, invoices print "GSTIN pending registration".
- [ ] **HSN/SAC codes** on every package, product, add-on, and the advance —
      confirm classifications with your CA.
- [ ] **Terms & conditions:** replace the placeholder `v1` text (publish a new
      version, don't edit v1).
- [ ] **Product & cover images** hosted in Supabase Storage (not Unsplash/Drive).
- [ ] Web3Forms access key set on the turnkey form (done).

## 7. Launch test (on the live domain)

- [ ] Sign up with a real email → OTP arrives → register.
- [ ] Configure a package → save → review → **pay the real ₹8,999** with a live method.
- [ ] Confirm: order `advance_paid`, invoice appears in the dashboard, invoice
      email with PDF lands in the inbox (not spam).
- [ ] Refund that test payment from Razorpay to confirm the refund path + webhook.

## 8. After launch

- [ ] **Google Search Console:** add `safecreatives.com`, submit `sitemap.xml`.
- [ ] Add a proper 1200×630 social share image and point `og:image` at it.
- [ ] Consider making the catalog pages public (browse before login) for SEO —
      currently login-gated, so they will not rank.
- [ ] Reconcile `database-schema.sql` with migrations 001–010 (only matters for a
      fresh DB, but it is currently out of date).
