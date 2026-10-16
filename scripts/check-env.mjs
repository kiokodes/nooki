import { loadEnv } from 'vite';
import { validateSupabaseConfig } from '../src/lib/supabaseConfig.mjs';
import { validateVapidPublicKey } from '../src/lib/pushConfig.mjs';

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

// Push notifications are the one optional feature here: without a key the app deploys and
// every other tab works, the settings switch just stays off. So this warns instead of
// blocking the build — a push key typo must never stand between a fix and production.
const vapidPublicKey = env.VITE_VAPID_PUBLIC_KEY?.trim();
const vapidError = validateVapidPublicKey(vapidPublicKey);
if (vapidError && !vapidPublicKey) {
  console.warn('Push notifications will stay switched off: VITE_VAPID_PUBLIC_KEY is not set.');
  console.warn('To turn them on, generate a keypair with `npx web-push generate-vapid-keys`, set the public half here (Production and Preview), set the private half as the VAPID_PRIVATE_KEY secret on the send-push function, and redeploy. See "Push notifications" in the README.');
} else if (vapidError) {
  console.warn(`Push notifications will stay switched off: ${vapidError}`);
} else {
  console.log('Public VAPID key is present; push still needs the send-push function, its VAPID_PRIVATE_KEY secret and the messages Database Webhook.');
}
