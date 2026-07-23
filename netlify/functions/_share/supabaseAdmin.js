// Server-side Supabase client using the SERVICE ROLE key.
// This key bypasses Row Level Security entirely — it must NEVER be sent to
// the browser or committed anywhere public. Set it in Netlify's dashboard:
// Site settings → Environment variables → SUPABASE_SERVICE_ROLE_KEY
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

module.exports = { supabaseAdmin };
