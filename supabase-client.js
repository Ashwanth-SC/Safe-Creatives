// The CDN bundle occupies the global name `window.supabase` with the LIBRARY
// (createClient, AuthClient, error classes). Naming our client `supabase` too
// meant later scripts could resolve to the library instead of the client, and
// calls like supabase.auth.getSession() failed with a confusing
// "cannot read properties of undefined".
//
// The client is therefore exposed as `sb`. Use `sb` everywhere; `supabase`
// remains the library and should not be called directly.

const SUPABASE_URL = "https://zcdcalwgyvlcawcflojl.supabase.co";

const SUPABASE_ANON_KEY =
"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjZGNhbHdneXZsY2F3Y2Zsb2psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTQzNjcsImV4cCI6MjA5OTg3MDM2N30.cYhdK7aaq8GrZ5qrxTQ6AOB2BxOzx3at-IldV-jPZ00";

window.sb = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);
