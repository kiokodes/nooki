import { loadEnv } from 'vite';
import { validateSupabaseConfig } from '../src/lib/supabaseConfig.mjs';

const env = loadEnv('production', process.cwd(), 'VITE_');
const error = validateSupabaseConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
if (error) {
  console.error(`Build blocked: ${error}`);
  process.exitCode = 1;
} else {
  console.log('Supabase public configuration is present. This does not verify the live database or key validity.');
}
