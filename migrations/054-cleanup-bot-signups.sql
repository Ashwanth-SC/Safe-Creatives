-- ============================================================================
-- 054 — remove bot sign-ups (one-off cleanup, safe to re-run)
-- ============================================================================
--
-- From mid-Aug 2026 a bot signed strangers' email addresses up in bulk (an
-- "email bombing" flood): ~25/day of junk accounts, mostly Gmail dot-variations
-- (m.r.kn.otu@gmail.com, j.b.a.u.gh.cli@gmail.com, …). Of 796 accounts only 5
-- are real registrations (plus 2 staff).
--
-- NOTE (checked against live data 2026-10-25): these accounts DID verify their
-- email and DID sign in — so they can't be found by "never verified / never
-- signed in". What marks them is that they never completed registration (no
-- name, phone or PIN on the profile) and have zero activity. That is the signal
-- used here. Mandatory registration means a real, engaged user always has at
-- least a name, so this does not catch genuine customers.
--
-- A row is removed only when ALL of these hold:
--   * not staff, and no name / phone / PIN on the profile
--   * created more than a day ago (don't catch someone mid-sign-up)
--   * no orders, invoices, or cart items
-- Deleting the auth.users row cascades to profiles (and their empty carts).
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor):
--   1. Run STEP 1 alone and check the count + sample (expect ~787, all junk).
--   2. Then run STEP 2. It is permanent — there is no undo.
-- Do this AFTER CAPTCHA protection is on, or new bot rows will keep arriving.
-- ============================================================================

create or replace view bot_signup_candidates as
select u.id, u.email, u.created_at
from auth.users u
left join profiles p on p.id = u.id
where coalesce(p.is_admin, false) = false
  and coalesce(trim(p.full_name), '') = ''
  and coalesce(trim(p.phone), '')     = ''
  and coalesce(trim(p.pin_code), '')  = ''
  and u.created_at < now() - interval '1 day'
  and not exists (select 1 from orders   o where o.user_id = u.id)
  and not exists (select 1 from invoices i where i.user_id = u.id)
  and not exists (
    select 1 from carts c join cart_items ci on ci.cart_id = c.id
    where c.user_id = u.id
  );

-- ---------------------------------------------------------------------------
-- STEP 1 — preview (changes nothing)
-- ---------------------------------------------------------------------------
select count(*) as will_delete from bot_signup_candidates;
select email, created_at from bot_signup_candidates order by created_at limit 50;

-- ---------------------------------------------------------------------------
-- STEP 2 — delete (uncomment and run after checking STEP 1)
-- ---------------------------------------------------------------------------
-- begin;
-- delete from auth.users where id in (select id from bot_signup_candidates);
-- drop view bot_signup_candidates;
-- commit;
