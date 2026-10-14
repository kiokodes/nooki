// Shared by the browser and build preflight. Never print key values in errors.
export function validateSupabaseConfig(url, key) {
  if (!url || !key) return 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before deploying Nooki.';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.hostname.includes('your-project') || parsed.search || parsed.hash ||
        (parsed.pathname !== '' && parsed.pathname !== '/')) {
      return 'VITE_SUPABASE_URL must be your real HTTPS Supabase project URL.';
    }
  } catch {
    return 'VITE_SUPABASE_URL is not a valid HTTPS project URL.';
  }
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return null;
  try {
    const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (key.split('.').length === 3 && payload.role === 'anon') return null;
  } catch {
    // Invalid or placeholder keys must not result in a deploy that only appears to work.
  }
  return 'VITE_SUPABASE_ANON_KEY must be a public anon or publishable key, never a secret/service-role key.';
}
