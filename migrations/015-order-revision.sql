-- ============================================================================
-- Migration 015 — order revision (change size/colour, add delivery charge)
-- ============================================================================
--
-- Run ONCE, after 014-order-tracking.sql.
--
-- After a site visit a customer may need a different size (it won't fit) or a
-- different colour, and delivery outside Chennai carries a charge. The admin
-- makes these changes through the revise-order edge function, which recomputes
-- every total server-side so the money stays authoritative — this migration
-- only adds the one new column it needs.
--
--   total = sum(line totals, goods) + delivery_charge + 18% GST on both
--   balance (generated) = total - advance   ->  the 80% / 20% installments
--   recompute off the new balance automatically.
--
-- Delivery is part of the taxable supply (goods + delivery + installation), so
-- 18% GST applies to it too.
-- ============================================================================

begin;

alter table orders
  add column if not exists delivery_charge_paise bigint not null default 0
    check (delivery_charge_paise >= 0);

comment on column orders.delivery_charge_paise is
  'Delivery/logistics charge added after a site visit. Part of the taxable
   value (18% GST applies). Recomputed into total_paise by revise-order.';

commit;
