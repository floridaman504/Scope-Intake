import { createClient } from '@supabase/supabase-js';

// These values come from the environment variables you set in Vercel.
// They are safe to expose in the browser — the publishable/anon key only
// permits the actions allowed by your Row Level Security policies.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);
