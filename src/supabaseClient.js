import { createClient } from '@supabase/supabase-js';

// These values come from the environment variables you set in Vercel.
// They are safe to expose in the browser — the publishable/anon key only
// permits the actions allowed by your Row Level Security policies.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    // These three are supabase-js's defaults already -- set explicitly so
    // the "silent refresh" and "refresh token rotation" requirements from
    // the Tier 1.3 session-hardening playbook are visibly intentional
    // rather than accidental defaults someone might "clean up" later.
    // autoRefreshToken: the client refreshes the access token in the
    // background before it expires, without interrupting the user.
    // Refresh token rotation itself (each refresh invalidates the old
    // refresh token and issues a new one) is enforced server-side by
    // Supabase Auth and isn't a client-side setting.
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
});
