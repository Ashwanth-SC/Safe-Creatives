-- ============================================================================
-- 054 — remove bot sign-ups (one-off cleanup, safe to re-run)
-- ============================================================================
--
-- From mid-Aug 2026 bots called Supabase's email-code endpoint directly with
-- the public anon key, signing up ~790 strangers' addresses (email bombing).
-- None of them ever entered the emailed code, so their auth.users row has no
-- email_confirmed_at and they never signed in.
--
-- A row is removed only when ALL of these hold:
--   * email never verified and never signed in
--   * created more than a day ago (don't catch someone mid-sign-up)
--   * not staff, and no name / phone / PIN on the profile
--   * no orders, payments, invoices or cart items
-- Deleting the auth.users row cascades to profiles (and empty carts).
--
-- HOW TO RUN (Supabase dashboard -> SQL Editor):
--   1. Run STEP 1 alone and check the count + sample (expect ~789, all junk).
--   2. Then run STEP 2. It is permanent — there is no undo.
-- Do this AFTER CAPTCHA protection is on, or new bot rows will keep arriving.
-- ============================================================================

create or replace view bot_signup_candidates as
select u.id, u.email, u.created_at
from auth.users u
left join profiles p on p.id = u.id
where u.email_confirmed_at is null
  and u.last_sign_in_at is null
  and u.created_at < now() - interval '1 day'
  and coalesce(p.is_admin, false) = false
  and coalesce(trim(p.full_name), '') = ''
  and coalesce(trim(p.phone), '') = ''
  and coalesce(trim(p.pin_code), '') = ''
  and not exists (select 1 from orders o   where o.user_id = u.id)
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
