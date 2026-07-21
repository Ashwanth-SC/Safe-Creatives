-- ============================================================================
-- Migration 010 — track invoice email delivery
-- ============================================================================
--
-- Run ONCE, after 009-fix-invoice-numbering.sql.
--
-- Razorpay retries webhooks, and the invoice step is idempotent (one invoice
-- per order). The email must be idempotent the same way, or a retried webhook
-- sends the customer a second copy. emailed_at records when the invoice was
-- mailed; the webhook only sends when it is null, and stamps it on success.
--
-- Null also means "not yet sent", so a failed send can be retried later
-- simply by clearing nothing and re-invoking -- the row is still eligible.
-- ============================================================================

alter table invoices add column if not exists emailed_at timestamptz;

-- Check:
-- select invoice_number, emailed_at from invoices order by created_at desc;
