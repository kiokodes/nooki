#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Nooki — turn on Web Push (one-time setup runbook)
#
# WHAT THIS DOES
#   - Checks the generated keys in .env.local (git-ignored, already written for you)
#   - (--apply) Deploys the send-push Edge Function and sets its secrets
#   - Prints every remaining step, including the two dashboard steps you must do
#     by hand (the SQL migration and the Database Webhook, plus the Vercel env var)
#
# WHAT IT DOES NOT DO
#   - It cannot click buttons in Vercel/Supabase for you. The Vercel env var and the
#     Database Webhook are manual dashboard steps, called out below.
#
# USAGE
#   1. Install the Supabase CLI:  npm i -g supabase
#   2. Log in:                    supabase login
#   3. Link your project:         supabase link --project-ref <YOUR_REF>
#   4. Run this (prints steps):   ./scripts/setup-push.sh
#   5. Run this (does the deploy):./scripts/setup-push.sh --apply
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Resolve repo root (this script lives in <root>/scripts).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "✗ .env.local not found at $ENV_FILE" >&2
  echo "  Generate keys first (npm i -g web-push && web-push generate-vapid-keys)" >&2
  exit 1
fi

# Load the keys (VITE_* for the build; VAPID_*/PUSH_WEBHOOK_SECRET for the function).
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

: "${VITE_VAPID_PUBLIC_KEY:?VITE_VAPID_PUBLIC_KEY missing in .env.local}"
: "${VAPID_PUBLIC_KEY:?VAPID_PUBLIC_KEY missing in .env.local}"
: "${VAPID_PRIVATE_KEY:?VAPID_PRIVATE_KEY missing in .env.local}"
: "${VAPID_SUBJECT:?VAPID_SUBJECT missing in .env.local}"
: "${PUSH_WEBHOOK_SECRET:?PUSH_WEBHOOK_SECRET missing in .env.local}"

MIGRATION="$ROOT/supabase/migrations/202610150015_web_push.sql"
VERIFY="$ROOT/supabase/verify.sql"

echo "════════════════════════════════════════════════════════════════════════"
echo " Nooki push setup"
echo "════════════════════════════════════════════════════════════════════════"
echo
echo "Public VAPID key (what you'll paste into Vercel):"
echo "  $VITE_VAPID_PUBLIC_KEY"
echo

echo "── STEP 1 · Apply the push migration ────────────────────────────────────"
echo "  Open Supabase → SQL Editor, paste and run:"
echo "      $MIGRATION"
echo "  Then run to confirm it applied cleanly (must print PASS):"
echo "      $VERIFY"
echo

echo "── STEP 2 · Set the frontend key in Vercel (must redeploy) ──────────────"
echo "  Vercel → Settings → Environment Variables, add for BOTH Production and"
echo "  Preview:"
echo "      VITE_VAPID_PUBLIC_KEY = $VITE_VAPID_PUBLIC_KEY"
echo "  Then redeploy (the value is inlined at build time)."
echo "  → This alone clears the \"Not switched on for this Nooki yet\" message."
echo

if [[ "${1:-}" == "--apply" ]]; then
  echo "── STEP 3 · Deploy the send-push function + set its secrets ─────────────"
  if ! command -v supabase >/dev/null 2>&1; then
    echo "✗ supabase CLI not found. Install: npm i -g supabase" >&2
    exit 1
  fi
  echo "  $ supabase functions deploy send-push --no-verify-jwt"
  supabase functions deploy send-push --no-verify-jwt
  echo
  echo "  $ supabase secrets set \\"
  echo "      VAPID_PUBLIC_KEY=$VAPID_PUBLIC_KEY \\"
  echo "      VAPID_PRIVATE_KEY=$VAPID_PRIVATE_KEY \\"
  echo "      VAPID_SUBJECT=$VAPID_SUBJECT \\"
  echo "      PUSH_WEBHOOK_SECRET=$PUSH_WEBHOOK_SECRET"
  supabase secrets set \
    VAPID_PUBLIC_KEY="$VAPID_PUBLIC_KEY" \
    VAPID_PRIVATE_KEY="$VAPID_PRIVATE_KEY" \
    VAPID_SUBJECT="$VAPID_SUBJECT" \
    PUSH_WEBHOOK_SECRET="$PUSH_WEBHOOK_SECRET"
  echo
else
  echo "── STEP 3 · Deploy the send-push function + set its secrets ─────────────"
  echo "  (run this script with --apply once supabase login + link are done)"
  echo "  Command it will run:"
  echo "      supabase functions deploy send-push --no-verify-jwt"
  echo "      supabase secrets set VAPID_PUBLIC_KEY=… VAPID_PRIVATE_KEY=… \\"
  echo "          VAPID_SUBJECT=$VAPID_SUBJECT PUSH_WEBHOOK_SECRET=…"
  echo
fi

echo "── STEP 4 · Add the Database Webhooks (manual, dashboard) ──────────────"
echo "  Supabase → Database → Webhooks → Create ONE webhook per row below."
echo "  All of them: Type: Supabase Edge Function · Function: send-push · Method: POST"
echo "                HTTP header:  Authorization: Bearer $PUSH_WEBHOOK_SECRET"
echo
echo "   #1  Table: messages        Event: Insert"
echo "        → partner gets a chat notification for each new message"
echo "   #2  Table: answers         Event: Insert"
echo "        → the OTHER partner is told it is their turn to answer (Discuss)"
echo "        (fires only while the question session is still open, i.e. not yet both answered)"
echo "   #3  Table: game_matches     Event: Update   (watch column: turn_id)"
echo "        → the player whose turn just arrived is told to make their move (Games)"
echo "        (fires only on a real turn change while the game is still live)"
echo
echo "  Each webhook is a separate entry pointing at the same send-push function."
echo

echo "── STEP 5 · Verify ──────────────────────────────────────────────────────"
echo "  Couple Settings → Notifications → switch on (per device). Send a message"
echo "  from a second phone; the first should get a lock-screen alert even if the"
echo "  app is closed. Edge Functions → send-push → Logs shows every call."
echo
echo "════════════════════════════════════════════════════════════════════════"
echo " Done. Keep .env.local secret — it holds the VAPID private key."
echo "════════════════════════════════════════════════════════════════════════"
