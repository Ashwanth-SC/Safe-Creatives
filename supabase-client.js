const SUPABASE_URL = "https://zcdcalwgyvlcawcflojl.supabase.co";

const SUPABASE_ANON_KEY =
"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpjZGNhbHdneXZsY2F3Y2Zsb2psIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQyOTQzNjcsImV4cCI6MjA5OTg3MDM2N30.cYhdK7aaq8GrZ5qrxTQ6AOB2BxOzx3at-IldV-jPZ00";

const supabase = window.supabase.createClient(
    SUPABASE_URL,
    SUPABASE_ANON_KEY
);