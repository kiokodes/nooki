# Nooki · Couples App for Long-Distance Partners 🏡💕

Nooki uses React + TypeScript + Vite, Supabase Auth/PostgreSQL, and Vercel.

## Live backend only

All accounts, profiles, couples, invite codes, anniversaries and breakup requests use
Supabase. There is no local-account fallback, plaintext password storage, or automatic
creation of users/couples. Supabase manages its own authentication session storage. On startup, the app removes only
obsolete browser-fallback records (including old passwords); it never deletes live records
or Supabase session tokens.
Missing/unsafe backend settings block the production build and show a connection error
at runtime rather than offering a local signup flow.

## Required environment configuration

For local development, copy `.env.example` to `.env.local` and fill in:

- `VITE_SUPABASE_URL`: the HTTPS project URL.
- `VITE_SUPABASE_ANON_KEY`: the project's **public anon key or publishable key**.

In Vercel → Project Settings → Environment Variables, set both for **Production** and
any **Preview** environment you intend to test. Both must belong to the same Supabase
project where you apply the SQL. Values are bundled at build time: redeploy after any
change. A preview pointing to the production project uses real production data.

**Never use a service-role/secret key in a `VITE_` variable.** Environment files are
Git-ignored except the blank `.env.example`. Configuration preflight validates presence
and public-key format, not the remote key's validity or the database's health.

## Database setup

### Existing live project

1. Take a database backup/snapshot before changing the schema.
2. Run `supabase/migrations/202610150001_pairing_flow.sql` in that project's SQL Editor.
3. Run `supabase/verify.sql` in the same SQL Editor. It is read-only and checks required
   functions, authenticated/anonymous pairing permissions, table permissions, RLS and
   the anniversary-lock trigger. It must return **PASS**.
4. Redeploy the updated frontend immediately after the migration.

The migration preserves existing couples and invite codes. It makes creation/linking
atomic, serializes joins to enforce two partners, makes retries safe, allows cancellation
of an unpaired invite, and locks the anniversary after the second authenticated partner
joins. It also stops unpaired users from reading other couples' invite codes.

**Do not rerun the full schema on an existing project or drop tables to resolve an
error.** Use the migration. It changes the old frontend's direct-insert permissions;
coordinate the migration/deployment in a short maintenance window if people are using
pairing now. A frontend-only rollback does not undo database policy changes.

### Brand-new, empty Supabase project only

Run `supabase/schema.sql` once, then `supabase/verify.sql`. The schema creates the tables,
RLS policies, pairing RPCs, anniversary trigger and mutual-breakup RPCs; it does not
populate user/couple records.

## Supabase Auth configuration

In Authentication settings:

- Enable the Email provider.
- Set the **Site URL** to the deployed production origin.
- Add the exact production and intended preview callback URLs to the redirect allowlist.
- If email confirmation is enabled, confirm each account's email and then sign in before
  setting up a profile or entering an invite code. The UI explains this requirement.
- Verify email delivery/SMTP settings and rate limits if confirmation emails do not arrive.

Each partner needs their **own** account. A pairing code connects signed-in accounts; it
is not an email/password login credential.

## Home tab

The centre Home tab is the default screen once a couple is paired. It is a vertical stack
of three soft cards and needs no schema change:

The global app header keeps the couple's names (`Sam & Ana`) with the "Together since
<date>" line, and the Home card carries the live counter.

1. **Couple header** — both partners' names and a live counter from `anniversary_date`,
   shown as years, months and days ("Together for 2Y 1M 4D"). It is measured on the
   viewer's own calendar day and re-renders on a one-second tick, so it rolls over at
   midnight without a refresh. A future anniversary counts down instead, and the
   anniversary day itself reads "Happy anniversary — today is your day".
2. **Partner status** — partner 1 is the phone owner (marked "You"), partner 2 carries a
   green dot right beside their name with a small "Online" label while they are in the app.
   Online state comes from Supabase **Realtime presence** on the couple-scoped channel
   `nooki-couple-<couple_id>`, keyed by user id. When they leave, the row falls back to
   their `profiles.last_seen_at` ("Last seen 12m ago", then a date after a week).
3. **Partner's local time** — "It's 11:42 PM for Ana", computed with `Intl` from the
   partner's own timezone, with a quiet "tomorrow"/"yesterday" hint when their calendar day
   differs. The reader's own time is deliberately never shown.

Presence runs at app level, not inside the tab, so a partner still reads as online while
this phone browses Chat, Media, Discussion or Games. The app writes its own
`last_seen_at` on mount, every minute while open, and when the tab is hidden — permitted by
the existing "update own profile" RLS policy, so **no migration is required** for the Home
tab. Two caveats worth knowing:

- Presence requires the Realtime service, which is on by default. Channels are public in
  Supabase unless Realtime Authorization is configured; the topic includes the couple's
  UUID, so only someone who already knows that id could subscribe to it. Enable Realtime
  Authorization if you want that enforced in the database.
- `last_seen_at` writes fail quietly when the device is offline; presence still covers the
  "Online" case.

### Design preview (development only)

`npm run dev` serves a sample-data preview of just this tab at
**http://localhost:5173/preview.html**. It uses static names ("Sam & Ana"), needs no
Supabase project, and lets you flip the partner between online and away and switch
anniversary examples. It is a dev-server route only: `npm run build` still publishes
`index.html` alone, and the app itself has no mock/sample mode.

While no `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` values are present, the dev server
also redirects the root URL (`/`) to `/preview.html` so local development never dead-ends
on the fail-closed connection screen. Once real values are in `.env.local`, `/` serves the
app as usual. The dev port is pinned with `strictPort` so it cannot silently drift off
5173.

## Checks before pushing

With your real project settings in `.env.local`:

```sh
npm ci
npm run check:env
npm test
npm run lint
npm run build
```

Tests run in isolated PostgreSQL (PGlite) and DOM environments. Test accounts exist only
inside those tests: no test contacts, inserts data into, or resets your live project.
Tests cover password visibility, email-confirmation handling, timezone selection,
pairing navigation/cancellation, protected profile retries, anniversary locks, RLS,
configuration failures, the read-only database verification script, and the Home tab
(YMD counter across end-of-month/leap-day edges, partner clock timezones, last-seen labels,
Realtime presence online/offline states and the `last_seen_at` heartbeat).

A successful build does **not** verify a deployed key, email delivery, an applied live
migration, or two-device connectivity. Complete the acceptance test below as well.

## Push and deploy

Work for this Arena session stays on `arena/4f0a6360-nooki`:

```sh
git status
git diff --check
git add .
git commit -m "Add the Home tab: live counter, presence and partner clock"
git push origin arena/4f0a6360-nooki
```

Open a pull request from that branch to `main`. Test the Vercel preview with its environment
settings configured, then merge the reviewed PR to your configured production branch.
Pushing this working branch alone does not necessarily update the production site.
`vercel.json` builds with `npm run build`, publishes `dist`, and provides SPA routing.
Do not publish a build produced with automated-test configuration.

## Required deployed acceptance test (two separate devices/browsers)

Use your actual accounts; there is no automatic user creation.

- [ ] Both partners can sign up/confirm email/sign in independently.
- [ ] Password show/hide works; timezone is auto-selected and changeable via dropdown.
- [ ] Partner A can create a code and edit/save the anniversary while waiting.
- [ ] A can go back, confirm cancellation and choose either create or enter a code.
- [ ] A cancelled code is rejected; a newly generated code is accepted by partner B.
- [ ] B can join using the current code, including a pasted/lowercase code.
- [ ] Both devices unlock the same couple; A's waiting screen updates automatically.
- [ ] Home opens by default: both names plus a live "Together for 2Y 1M 4D" counter.
- [ ] With both apps open, each device shows the other as Online with a green dot beside the name.
- [ ] Closing one app flips the other to "Last seen ..." within about a minute (refresh or wait for the next presence sync).
- [ ] The partner clock card matches the partner's own device time and never shows your own clock.
- [ ] After joining, anniversary edits and unilateral cancellation are rejected.
- [ ] A third account cannot join an already complete couple.
- [ ] Refreshing and signing out/in preserve the couple, anniversary and partner names.
- [ ] Check browser Network errors and Supabase Auth/Postgres logs if any step fails.

## Current feature scope

Signup, onboarding, pairing, the Home tab (live together counter, partner presence and the
partner's local time), couple details, sign-out and mutual-breakup settings are implemented.
Chat, media, discussion and games currently display **Coming Soon**; this release does not
implement those features. No sample conversations/content are loaded.

## Design system

`src/tokens/designTokens.ts` contains the warm cream, blush pink, pastel mint, lavender
and sage palette, typography, radii and shadows. The app remains locked until both
partners are paired; ending a completed couple requires both partners' agreement.
