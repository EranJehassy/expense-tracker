import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

// config.js holds the Supabase project URL and the PUBLIC anon/publishable key.
// Never put the service_role key in this project.
const cfg = await import('../config.js').catch(() => null);
const url = cfg && cfg.SUPABASE_URL;
const anonKey = cfg && cfg.SUPABASE_ANON_KEY;

export const configured = Boolean(url && anonKey && !url.includes('YOUR-PROJECT-REF'));
export const supabase = configured
  ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
