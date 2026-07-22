-- ============================================================================
-- Migration 012 — publish Terms & Conditions v2
-- ============================================================================
--
-- Run ONCE, after 011-colours-under-sizes.sql.
--
-- Publishes a NEW terms version rather than editing v1 in place: past
-- acceptances point at terms_versions.id, so the exact text each customer
-- agreed to must stay frozen. The old version is retired (is_current=false)
-- but kept for those historical references.
--
-- terms_versions_one_current is a partial unique index on (is_current) where
-- is_current, so at most one row may be current at a time. The old current
-- row is therefore cleared BEFORE the new one is inserted, inside one
-- transaction.
--
-- The body is rendered as plain text with white-space:pre-wrap on the review
-- page, so the line breaks and bullets below appear exactly as written.
-- ============================================================================

begin;

update terms_versions set is_current = false where is_current;

insert into terms_versions (version, body, is_current)
values (
  'v2',
  $body$Terms & Conditions

1. Nature of Order
By placing an order on this website, you are initiating a reservation for the selected room package (living room / dining room). This is not an immediate confirmed sale. Upon reservation, our representative will contact you within 48 hours to conduct a site verification, including space dimensions, access points (staircase/lift/doorway clearances), and placement feasibility. Your order will be confirmed only after successful verification. Products move into manufacturing and the delivery pipeline only post this confirmation.

2. Cancellation & Refund
Customers may request cancellation of their reservation within 72 hours from the time our representative first reaches out to them for site verification. Refund requests raised within this 72-hour window will be processed as applicable. No refund will be entertained for cancellation requests raised after this 72-hour period, including cases where the customer changes their mind or reassesses their requirement after this window has lapsed.

3. Delivery & Installation
• Delivery and installation within Chennai are provided free of cost.
• Delivery and installation outside Chennai will attract additional logistics and installation charges, which will be communicated and agreed upon before the order is confirmed.
• Estimated delivery timeline is within 20 days from the commencement of the order (i.e., from the date of successful site verification), subject to product customization, location, and logistical factors. Any anticipated delay will be communicated proactively.

4. Payment Structure
Payments are collected in three phases:
1. Advance payment – at the time of reservation, to initiate the process.
2. Order confirmation payment – payable upon successful site verification and confirmation of manufacturing.
3. Pre-dispatch payment – balance payment due before the product is dispatched for delivery.

5. Additional Terms
• Warranty terms and related documentation will be provided along with the invoice at the time of delivery.
• Product images, colours, and finishes may show slight variation from the actual product due to screen display or manufacturing batch differences.
• Any customization requests post order-confirmation may affect delivery timelines and pricing.
• Ownership of goods transfers to the customer only upon full and final payment.
• The company reserves the right to reschedule delivery due to unforeseen circumstances (logistics disruptions, force majeure, etc.), with due communication to the customer.
• Customers are requested to inspect products at the time of delivery and report any damage or discrepancy within 24 hours.
• All prices displayed on the website are inclusive of applicable GST and taxes.

By proceeding with checkout, you agree to the above terms.$body$,
  true
)
on conflict (version) do update set
  body       = excluded.body,
  is_current = true;

commit;


-- Check:
-- select version, is_current, left(body, 40) from terms_versions order by published_at;
