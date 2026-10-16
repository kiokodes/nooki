import { loadEnv } from 'vite';
import { validateSupabaseConfig } from '../src/lib/supabaseConfig.mjs';

const env = loadEnv('production', process.cwd(), 'VITE_');
const error = validateSupabaseConfig(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
if (error) {
  console.error(`Build blocked: ${error}`);
  const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter((name) => !env[name]?.trim());
  if (missing.length) console.error(`Missing build variables: ${missing.join(', ')}.`);
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    console.error(`Vercel environment: ${process.env.VERCEL_ENV || 'this deployment'}. Set both variables in Project Settings → Environment Variables for this environment.`);
    if (process.env.VERCEL_ENV === 'preview') {
      console.error('Production-only variables do not reach Preview builds. Include this Git branch (or all Preview branches), save, then redeploy.');
    } else {
      console.error('Save the environment variables, then redeploy: Vite embeds them during the build.');
    }
  } else {
    console.error('For a local build, copy .env.example to .env.local and fill in both values. For Vercel, configure both Production and Preview scopes, then redeploy.');
  }
  console.error('Use the public anon/publishable key from the same Supabase project as the URL. Never use a service-role or secret key.');
  process.exitCode = 1;
} else {
  console.log('Supabase public configuration is present. This does not verify the live database or key validity.');
}
