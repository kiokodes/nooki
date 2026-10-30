# Nooki · Cosy App for Long-Distance Couples 🏡💕

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
- `VITE_VAPID_PUBLIC_KEY`: optional. The **public** half of the VAPID keypair used to sign
  web push notifications. Without it the app deploys exactly as before and the settings
  switch stays off; every other tab is unaffected. See **Push notifications** below.

In Vercel → Project Settings → Environment Variables, set these for **Production** and
any **Preview** environment you intend to test. They must belong to the same Supabase
project where you apply the SQL. Values are bundled at build time: redeploy after any
change. A preview pointing to the production project uses real production data.

**Never use a service-role/secret key in a `VITE_` variable.** Environment files are
Git-ignored except the blank `.env.example`. Configuration preflight validates presence
and public-key format, not the remote key's validity or the database's health.

### If Vercel reports `Build blocked: Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY`

This is the environment preflight stopping the build, not a TypeScript/Vite failure.
The npm `cache-dir` and install-script warnings are not the cause of this exit.

1. In the **same Vercel project** that produced the log, open **Settings → Environment
   Variables** and add the two exact names above. Get the project URL and public
   anon/publishable key from your Supabase project's API settings/Connect dialog.
2. Enable **Production** for production deployments and **Preview** for branch/PR
   deployments. Production-only values do not reach Preview builds. If a Preview value
   has a Git-branch restriction, include the branch being deployed (or select all Preview
   branches). A Git-ignored local `.env.local` is not uploaded by a Git deployment.
3. Save, then **redeploy the latest commit**. Editing environment variables does not repair
   an already-failed deployment. A failed build cannot publish its Duel/Sudoku changes;
   the previous successful deployment may still be what the browser is showing.

Do not remove `check:env`, commit filled-in environment files, or substitute a secret key
just to make the build green. A successful preflight only checks configuration format;
apply and verify the database migrations separately.

## Database setup

### Existing live project

1. Take a database backup/snapshot before changing the schema.
2. Run `supabase/migrations/202610150001_pairing_flow.sql` in that project's SQL Editor.
   Then run, the same way: `202610150002_couple_events.sql`,
   `202610150003_messages.sql`, `202610150004_discuss_questions.sql`,
   `202610150005_discuss_comments_chat_links.sql`, `202610150006_chat_replies_edits.sql`,
   `202610150007_games.sql` (Games), `202610150010_snake_duel.sql` (the Snake Duel in
   Games), `202610150011_chess.sql` (Chess in Games),
   `202610150012_tetris_duel.sql` (the Tetris Duel in Games),
   `202610150008_shared_books.sql` and
   `202610150009_two_book_shelf_limit.sql`
   (shared books), then `202610150015_web_push.sql` (notifications; optional, and the only
   migration that is — every other table works without it), then
   `202610150016_miss_you.sql` (the "I miss you" button), then
   `202610170001_partner_locations.sql` (the country/state/city on each profile, and the
   marketplace key generated from them), then `202610170002_daily_decisions.sql` (the
   owner-uploaded daily three-choice decision), then
   `202610180001_daily_decision_pool.sql` (which turns that dated prompt table into an
   undated question pool each couple draws a random unseen question from daily), then
   `202610180003_couple_photo.sql` (the couple picture frame standing in the Home nook),
   then `202610180002_remove_daily_games_and_tic_tac_toe.sql` (removes the retired daily
   Games feature, Tic Tac Toe and their match history), then
   `202610180006_connect_four.sql` (adds Connect Four with database-refereed turns), then
   `202610180007_together_visits_and_someday_list.sql` (the Together tab's planned visits
   and shared someday list), then
   `202610180008_someday_details_order_and_visit_link.sql` (the list's notes, its manual
   drag order, and the "Add to our next visit" link), then
   `202610180009_dash_duel.sql` (Dash Duel's shared course, verified runs and live-ready
   handshake), then `202610190001_word_wheel.sql` (the shared Word Wheel puzzle and
   server-counted results), then `202610190002_dash_duel_dodge_speed.sql` (top-to-bottom
   obstacles, dodge-only controls and referee-checked acceleration), then
   `202610190003_word_wheel_async_practice.sql` (solo practice and independent multiplayer
   clocks), then `202610190004_together_tab_restructure.sql` (visit wishes, day-by-day plans,
   idea matching, scheduled activities and visit memories), then
   `202610190005_together_time_agreement.sql`, then
   `202610190006_remove_shared_books.sql` (removes Read together), then
   `202610190007_someday_notebook_and_remove_together_time.sql` (removes Together time,
   private Someday visibility and votes; the list becomes a shared, ordered notebook), and
   finally `202610200001_epistles.sql` (the couple's long sealed letters — the mailbox in
   the nook). Finally run
   `supabase/seed/word_puzzles.sql` once to install the pregenerated puzzle bank.
   For Truth or Dare, also apply `supabase/migrations/202610220001_truth_or_dare.sql`, then
   `202610250001_lock_truth_or_dare_spicy.sql`, then run `npm run seed:truth-or-dare` with
   `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY`. This adds only new tables
   and functions; it does not alter existing tables. The 720 seeded prompts remain
   `active = false` until the owner reviews and activates them in Supabase. The lock
   migration closes any open Spicy round and sets every Spicy prompt back to
   `active = false`, so do not review or activate Spicy prompts yet.
   Apply pending migrations in this order; apart from the intentionally retired Games
   history, they preserve existing records.
   (`202610150013_lock_down_game_internals.sql` and
   `202610150014_restore_chess_tetris_game_check.sql` are repairs, not part of a fresh
   install: run them only if `verify-games.sql` names them — see **Troubleshooting the
   Duel button**.)
   Do not rerun older Games migrations over saved Chess matches (see **Troubleshooting
   the Duel button**). The second adds the shared
   calendar, the third adds the chat log, the fourth adds the Discuss question engine,
   the fifth rewrites reactions into comments and links chat messages to questions, the
   sixth adds chat replies and edits (plus their Realtime publication membership), the
   seventh adds Games, the tenth adds the Snake Duel's verified runs to Games, the
   eleventh adds Chess's database referee to Games, the twelfth adds the Tetris Duel's
   verified runs to Games, the last two add the shared-books shelf, the miss-you one
   adds the tap table behind the "I miss you" button (`202610150016`, the only one the
   frontend never writes directly), and the location one adds columns to `profiles` —
   no new table, no new policy, and every existing row keeps working with no place saved.
   See **Locations, and the marketplace they are scaffolding for**. `202610180004` lets a
   retried run report skip taps the referee has already logged: a finish that repeated
   them used to be refused as "out of order" forever, so a duel both partners had played
   never settled and stood in their Ongoing games until the grace window erased it.
3. Run `supabase/verify.sql` in the same SQL Editor. It is read-only and checks required
   functions, authenticated/anonymous pairing permissions, table permissions, RLS, the
   anniversary-lock trigger, the `couple_events` calendar, the realtime `messages` chat,
   the Discuss tables, reveal policy and question RPCs, the web-push device table, the
   miss-you tap table, the Daily Decisions tables and privacy-safe response RPCs, and the
   profile location columns (including that `city_key` is still
   generated by the database and still spells `ng/ri/port-harcourt` the way the frontend
   does). It must return **PASS**; if it complains about `couple_events`,
   `messages`, `questions`, `miss_you_taps`, `daily_decision_questions` or `profiles.city_key`, that migration step was
   skipped.
4. Redeploy the updated frontend immediately after the migration.

The migration preserves existing couples and invite codes. It makes creation/linking
atomic, serializes joins to enforce two partners, makes retries safe, allows cancellation
of an unpaired invite, and locks the anniversary after the second authenticated partner
joins. It also stops unpaired users from reading other couples' invite codes.

The chat migration is **required before deploying the Chat tab**: a project without
`messages` shows an owner-facing "the database needs an update" message instead of a
broken chat, and the preflight fails loudly.

The Discuss migration is **required before deploying the Discuss tab**: a project without
`questions` shows the same owner-facing "the database needs an update" card instead of a
tab that looks broken, and the preflight fails loudly. It adds tables, functions, triggers
and policies only — never any questions — so the tab says "The question library is empty"
until you import your CSV (see **Importing the question library** below).

**Do not rerun the full schema on an existing project or drop tables to resolve an
error.** Use the migration. It changes the old frontend's direct-insert permissions;
coordinate the migration/deployment in a short maintenance window if people are using
pairing now. A frontend-only rollback does not undo database policy changes.

### Brand-new, empty Supabase project only

Run `supabase/schema.sql` once, then `supabase/verify.sql`. The schema creates the tables
(including `couple_events`, `messages`, the Discuss tables, visit wishes,
checklists, visit memories, the shared Someday notebook, `push_subscriptions`,
`miss_you_taps` and `epistles`), location columns and generated marketplace key, RLS policies, RPCs,
triggers, Realtime publication membership and the private `visit-memories` storage bucket.
Read together and Together time are not part of the end state.

**Data API grants are explicit, per table.** Supabase stopped granting Data API access
to new `public` tables automatically on **2026-10-30** (existing tables keep their
grants; new projects, preview branches and `supabase db reset` are affected). This
schema therefore grants every role by name: each table's own section grants `anon`
(always nothing) and `authenticated` what the app needs, and the closing block grants
`service_role` on every table — the server key `send-push` reads with. The same rule
applies to any future migration that creates a table: grant each role that reaches it
in the same migration, including `service_role` when the edge function reads it (see
`202610200001_epistles.sql` for the pattern). It does not populate
user/couple records, and it contains no Discuss or Daily Decisions questions — upload
those separately. Push delivery still needs the `send-push` Edge Function and VAPID
secrets; chat notifications need the `messages` Database Webhook.

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

## Locations, and the marketplace they are scaffolding for

Signup asks where each person is — country, state, city — and Couple Settings has
**Update location** for when that changes. One reason is visible today and one is the
point of the exercise:

- **The clock is derived instead of guessed.** Onboarding used to offer a 400-option
  timezone list, because a browser's own zone is not always the one a person means and
  nothing else was known about them. A country is not enough to guess from either: 31 of
  the 250 countries in the place data span more than one zone, and the United States
  spans 29. So the place settles it — Nigeria is `Africa/Lagos` and no question is asked,
  Idaho is `America/Boise`, and Gary, Indiana is `America/Chicago` even though the centre
  of its state is not. `Change` is still on the form, because a derived zone is a good
  guess and a person knows better; a zone picked by hand stays put until the place it was
  picked for changes.
- **A gift needs a city, not a timezone.** Long distance is the whole reason Nooki
  exists, and the hard part of a surprise is that you do not know anywhere near the person
  you are surprising. The marketplace that is coming therefore opens on the *partner's*
  city by default, with the other cities a couple has saved as a switcher — for the week
  one of them is away, or for the city they grew up in. This release lays the ground for
  that and stops there: see **What the marketplace scaffolding is** below.

People move, and moving is often the story: going abroad for school is what made a couple
long-distance, and coming home to the same country is not a reason to stop using Nooki —
they are still in two cities, or still two hours apart, or still sending each other
things. So the place is a setting, not a signup detail. Each partner edits their own from
**Couple Settings → Where you both are**, and the other's header clock changes with it.
An account made before this feature has no place saved: nothing breaks, the clock runs on
`timezone` exactly as before, and the city can be added whenever.

### What is stored

All of it on `profiles`, all of it optional, and all of it saved together or not at all
(`202610170001_partner_locations.sql`):

| Column | Example | Why |
| --- | --- | --- |
| `country_code` | `NG` | The stable half of a city's identity. ISO 3166-1 alpha-2. |
| `country_name` | `Nigeria` | What is shown, kept even if a future dataset re-spells it. |
| `state_code` | `RI` | The dataset's subdivision code; null for the 53 countries it has none for. |
| `state_name` | `Rivers` | What is shown. |
| `city_name` | `Port Harcourt` | What is shown, and what the city list offered. |
| `city_key` | `ng/ri/port-harcourt` | **Generated by the database.** The marketplace's join key. |
| `location_updated_at` | `2026-10-17T…` | When they last said where they are. |
| `timezone` | `Africa/Lagos` | Unchanged column, now written from the place. |

`city_key` is generated, so it can never disagree with the place it came from: nobody
writes it, Postgres refuses an attempt to, and a partner who moves from Port Harcourt to
Lagos gets `ng/la/lagos` in the same update. The rule lives once in SQL
(`public.profile_city_key`, built from the codes rather than the display names) and once
in TypeScript (`buildCityKey` in `src/lib/geo/location.ts`, used only for rows read from a
project that predates the column), and `tests/location-database.test.mjs` asserts the two
agree — including that no place means no key, rather than a key with holes in it.

Half a location is refused by a check constraint, not only by the form: a city with no
country cannot be matched to anything, and a missing country code would make every such
key start `-` and collide with all the others.

Privacy is unchanged and worth saying out loud: a partner can read your place through the
existing profile policy (that is exactly what lets the marketplace open on their city),
and nobody outside the couple can read it at all. No new table, grant or policy was
needed, and none was added.

### The place dataset

The pickers read generated files, not a bundled blob:

```sh
npm run build:geo     # ~2.5s; predev and prebuild run it for you
```

`scripts/build-geo-data.mjs` reshapes `country-state-city` (250 countries, 4,963 states,
148,038 cities — both devDependencies, so nothing is added to the browser bundle) into
one index plus one file per country, and resolves every timezone at build time with
`tz-lookup`, whose boundary polygons never ship to a phone:

```
public/geo/countries.json        28KB  every country, its flag, its zones, its one zone if it has one
public/geo/country/{CC}.json     2KB median, 286KB for the United States
```

That is 2.4MB across 251 files, fetched only when somebody opens that country's picker —
Nigeria costs 10KB, and the United States costs 286KB once. `public/geo/` is
**git-ignored and regenerated**: it is generated data, and a build that has not run
`build:geo` produces the same app with the fallbacks below.

Cities are stored as names grouped by state, and a city only carries a timezone of its own
when it differs from its state's (`cityZones`), which is why single-zone countries write no
exceptions at all. Everything stored was validated through `Intl.DateTimeFormat` at build
time, so a zone in the data is always one a browser can read a clock in.

Three ways this degrades, none of which is a dead end:

| What failed | What the form does |
| --- | --- |
| One country's file | That country's state and city become typed fields. The country code is still known, so the place still gets a key (`ng/-/port-harcourt`). |
| The country index | The fields go away and the timezone picker Nooki always had comes back. Signup saves a zone and **no location** — never half of one. |
| Nothing (normal) | Country → state → city, with the timezone derived and shown with its offset and its reason ("From your city"). |

If `country-state-city` or `tz-lookup` is not installed, `build:geo` prints a warning and
succeeds rather than blocking a deploy over a dataset; the app then runs the second and
third rows of that table. If the frontend is deployed to a project without the location
migration, a save answers with the same owner-facing "the database needs an update"
message every other unmigrated surface uses.

### What the marketplace scaffolding is (and is not)

**Is:** the location model above, and one pure function —
`resolveMarketCities(profile, partner)` in `src/lib/geo/marketplace.ts`. It returns the
city the marketplace opens on (the partner's, because the gift is going to them), the
other cities on offer (yours, when it is somewhere else), and the sentence to show when
the partner has not added theirs yet. It is tested on its own. Couple Settings keeps
quiet about it: the card says where each of you is, and nothing more.

**Is not:** there are no vendor tables, no listings, no Market tab, nothing for sale and
nothing to query. When that work starts it takes `defaultCity.key` as the scope of its
first query and `cities` as its switcher, adds its own tables and its own migration, and
nothing in the location model has to change.

### What updates when

Saving a place is one row and one write. This phone re-reads the header's clock at once
(`onLocationSaved` hands the saved profile back to `App`). The other phone picks it up the
next time presence syncs — either partner opening or closing the app — which is the same
moment the partner's `last_seen_at` is refreshed; a move is rare enough that it does not
need a channel of its own, and no new Realtime subscription or publication entry was
added. Nothing polls, and nothing about pairing, anniversary locking, push devices or the
miss-you counter is touched.

## Global header and Home tab

The global header sits above every tab and carries the couple's live status:

- **Initials** — `S & A`. Only the first letters are shown so no name length can crowd the
  layout; the full names sit in the element's accessible label and tooltip, and are used
  for personalisation elsewhere (e.g. the calendar's "Ana sees these dates too").
- **Presence ticker** — a small dot right beside the partner's name, green with a faint
  pulse while they are in the app and grey once they leave. Its tooltip/accessible label
  falls back to `Last seen 12m ago`, then a date after a week.
- **Partner's local time** — `5:14 PM Tue` in the partner's own timezone, with their
  weekday (so a different day is obvious). The reader's own clock is never shown. The zone
  is the one their place implies, updated the moment they use **Update location** — see
  **Locations, and the marketplace they are scaffolding for**.
- **Together counter** — a quiet `Together for 2Y 1M 4D` line under the names, from
  `anniversary_date`, measured on the viewer's own calendar day. The anniversary day
  itself reads `Happy anniversary — today is your day`, and a future date counts down.

The header owns its own one-second tick, so only the header re-renders as time passes.

Below every tab, the bottom navigation runs **Chat · Together · Home · Discuss · Games**,
left to right, with Home as the raised centre button. `TABS` in `src/App.tsx` and
`PUSH_DEEP_LINK_TABS` in `src/lib/pushService.ts` list that same order, so a tapped
notification and the bar on screen always agree about where a tab sits.

## Launch, the splash and the first paint

Opening the installed app is the one part of Nooki a couple does every session, so it is
deliberately the cheapest:

- **The boot splash paints before any JavaScript.** `index.html` carries a plain HTML/CSS
  copy of the splash (the Nooki couple — the app's cover artwork — plus the wordmark and the
  pink and green race) inside `#root`, so a phone shows
  Nooki from the first frame instead of a blank page while the bundle downloads and parses.
  React replaces it on mount; a test keeps the two copies in step.
- **The race is played once, not twice.** The boot splash starts the race — on a slow phone
  it covers the whole download — and records when it began on `window.__nookiBootRace`
  (`src/lib/bootRace.ts`). `App` reads that once before the first render, hands it to
  `SplashScreen` as `elapsedMs`, and the splash continues the same run from that point (a
  negative `animation-delay`) instead of restarting it; the fallback dismissal timer waits
  out only what is left. Before this, every phone launch showed the race twice and the app
  arrived up to a full race late.
- **The race runs on the compositor.** Each dot rides a full-width runner moved with
  *percentage transforms*: a percentage of the runner is a percentage of the track, so the
  distance needs no container-query units and no measured pixels. `cqw` (and animating
  `left` before it) is resolved on the main thread, which is parsing the bundle and mounting
  the app while the race is on screen — the dots could sit through the whole run unmoved, and
  a browser without container queries could not resolve the distance at all. A percentage
  transform is resolved once, off the main thread, everywhere.
- **The first paint waits on nothing third-party.** The Google Fonts stylesheet is loaded
  off the critical path (`media="print"` + `onload`, with a `<noscript>` copy), so the gap
  between the Home Screen icon and the splash is not a round trip to another host. Fonts
  swap in when they arrive; every surface names system fallbacks.
- **Restoring a session is two hops, not three.** `fetchCouple` takes the caller's own id
  when it is already known and fetches the couple and the partner row together, in parallel,
  instead of looking the id up again between them — the last thing between the splash and the
  couple's tab, and the thing the pairing screen repeats every couple of seconds.
- **A slow load says so.** If the session load outlasts the race, a quiet "Waking up your
  nook…" fades in under the track rather than leaving a frozen wordmark on screen.

Reduced motion (an OS "reduce motion" setting — common on phones, rare on a dev desktop) is
honoured: the splash still appears, with both dots parked visibly under the wordmark and no
race, and the fallback timer dismisses it as usual.

## Today card, daily decision and the full calendar

The Home tab shows:

- A compact **Today card**:
  - Today's date ("Thursday, 15 October") and anything happening today.
  - The couple's automatic dates: the **anniversary** each year and the **monthsary** on the
    same day-of-month, both derived from `anniversary_date` — nothing is stored for them, so
    they can never drift out of sync. A 31st anniversary borrows the last day of shorter
    months (so 31 Jan reads as 28/29 Feb) instead of skipping the month.
  - **Upcoming**: whatever is coming within the next `UPCOMING_WINDOW_DAYS` days (1 by
    default, set in `src/components/home/TodayCard.tsx`). It is separated from today by a
    hairline and a small "Tomorrow" label, so today always reads first.
  - A **calendar icon** in the corner that opens the full calendar.
- One compact **Today’s decision** card (`src/components/home/DailyDecisionCard.tsx`) opens the
  couple's private choice. It mirrors the **Our day** card beside it — the two ticks, the same
  small title, and one status line ("Make a decision", "Waiting for …'s decision", "Talk it
  out", or "Decided") — and it glows until the couple agrees: pulsing with a little alert badge
  while a choice is this phone's to make, glowing steadily while it waits for the partner's.
- The **cozy nook** at the bottom of the screen — the shared room where the couple's own
  picture stands in a gift-wrapped frame (see **The framed couple picture** below), with the
  "I miss you" button in its top-left corner and the caption pinned top-right. The cartoon
  Nooki pair stays the app's branding — its icon, its favicon and its splash — just not the
  thing standing in the nook.

The full calendar is a **modal over the current tab** — never a page of its own, so the
Home tab stays exactly as it was behind it:

- A month grid (Monday first, neighbouring days shown faintly) with dot markers on dates
  that have something on: green for events, pink for the anniversary and monthsaries.
- **‹ › for months**, a **"Choose month and year"** picker (12-month grid plus year steps),
  a **Back to today** shortcut, and **swipe left/right** to change month.
- Tapping a day shows what is on it. User events can be added, edited and deleted from
  there (`window.confirm` guards the delete); automatic dates are labelled `automatically`
  and are not editable, because they come from the anniversary.
- The **repeat control cycles on tap**: `Once → Every week → Every month → Every year →
  Once`. Weekly repeats return every 7 days, monthly repeats on the same day-of-month
  (short months borrow their last day, so a 31st event falls on 28/29/30), and a repeat
  never appears before the date it was set for.
- Close with the **X**, **Escape** (which first closes the picker or the form), or by
  tapping the dimmed backdrop.

Events live in `couple_events` (`title`, `event_date`, `repeat_frequency`
`'none' | 'weekly' | 'monthly' | 'yearly'`, plus `couple_id` and `created_by`). Both
partners read and write the same rows. Rows are cascaded away when the couple ends, and
the RLS policies scope every read and write to `public.get_user_couple_id(auth.uid())`, so
an unpaired or third account sees nothing.

**Already ran the calendar migration before the repeat control?** Rerun
`supabase/migrations/202610150002_couple_events.sql`. It is idempotent and upgrades a
project in place: it adds `repeat_frequency`, converts existing `repeats_yearly = true`
rows to `'yearly'`, drops the old column, and then `verify.sql` should report **PASS**
(it fails loudly if the old column is still there).

### Daily decisions

The **Today’s decision** card sits under Today and opens the couple's private choice sheet.
Decisions are shared only when both people pick the same option:

- Each partner privately chooses one of the three options. The database hides each choice
  from the other partner until both have replied; the sheet can show that a reply is waiting
  without showing its contents.
- Once both have replied, both choices appear together. If they differ, either partner may
  change their choice and the sheet offers **Take to chat**, which posts **one short line**
  into their shared chat — the question and a nudge, never the three options. That message
  carries an **Open today's decision** link, so either partner can tap it and land straight
  back on the card to answer, without scrolling the chat for the question. Posting twice
  reuses the same message. The decision becomes final and locked only when the two choices
  match.
- The day rolls over at **midnight UTC**. The questions work the way
  Discuss questions do: they live in an undated pool the owner uploads to Supabase, and each
  day the database randomly picks one question **this couple has never been given before**
  and saves that pick (`daily_decision_assignments`), so both partners see the same question
  all day and no couple is ever handed the same question twice. The app never downloads the
  pool — it only ever receives the one question for today, so the pool can grow to thousands
  of questions. When a couple has been through every question in the pool, the sheet says so
  ("You've been through every decision we have for now") instead of repeating one; uploading
  more questions is all it takes for the next day to continue.

Apply `supabase/migrations/202610170002_daily_decisions.sql` and then
`supabase/migrations/202610180001_daily_decision_pool.sql` to existing projects (fresh
projects get the same tables from `supabase/schema.sql`), then run `supabase/verify.sql`.
Neither migration inserts **any questions**, and the pool upgrade keeps an existing dated
install's questions and answers: uploaded questions join the pool, and each answered day
becomes that couple's assignment for the question they answered. In Supabase Table Editor
(or the SQL Editor), upload rows into `daily_decision_questions` with these columns — no
date, nothing to schedule:

| Column | Meaning |
| --- | --- |
| `question` | The daily decision prompt. |
| `option_a` | First answer choice. |
| `option_b` | Second answer choice. |
| `option_c` | Third answer choice. |

(`id` is generated by the database; leave it out of the CSV.) All three options are required
and must be distinct. With an empty pool the sheet says no decisions have been added yet.
App roles cannot read the pool directly or write prompt, assignment or response rows; their
one question arrives through `daily_decision_state`, their choices go through
`submit_daily_decision_choice`, and the response RLS policy is the privacy boundary — the
UI never decides whether an answer is safe to reveal.

### The "I miss you" button

The one thing in the nook that can be tapped, and the only feature meant for the half of the
couple who is in the app alone. It is offered only while the partner is away — when presence
says they are in the app, the corner of the nook is empty — and every tap is counted, so
the gesture survives the wait.

- **Tapping.** Each tap writes one tap under the tapper's own calendar day (`tap_date`, never
  a UTC guess, so an 11pm tap is tonight's). A day of tapping is one row with a count, not a
  pile of rows: `record_miss_you_tap` upserts it and returns how many of them the partner has
  not opened yet — the little number on the button. It is instant on screen, because the tap
  already happened in the person's hands.
- **Receiving.** The next time the partner opens Nooki, their phone peeks the waiting taps
  and calls `receive_miss_you_taps`, which hands the batch back **and** marks it received in
  the same step — that is the reset. The heart is then drawn over the load screen
  (`MissYouReveal`), expands, and fades away on its own; tapping it, Escape, or the timer
  closes it sooner. Nothing behind it is blocked while it is up, and reduced-motion readers
  get the same words with no growth.
- **The words** (`src/lib/missYou.ts`, pure and testable): one waiting tap is a soft hello —
  `Hi, Jayo missed you`; several from the same day are counted — `Jayo missed you 4 times
  today`; a second batch later the same day says `4 more times today`, because the count
  resets the moment the partner receives it; and taps left over from earlier days drop the
  "today" claim rather than lie about it — `Jayo missed you 5 times`.
- **Only what is waiting is ever counted.** The day's total is kept (`tap_count`), and
  `delivered_count` records how much of it has been opened, so a tap that greets someone
  once never greets them twice. The batch a phone opens is remembered for the session, so
  switching tabs does not replay the heart.
- **When the count is read.** Both halves peek on unlock and again whenever the app comes
  back to the front — the moment a partner is most likely to have left something behind. So
  the tapper's number drops back to nothing once their taps have been received, without a
  reload, and a tap left for someone who is mid-session still opens the next time they look
  at their phone.
- **Privacy.** `miss_you_taps` can be read by the two partners and written by nobody: both
  writes are `SECURITY DEFINER` functions, the couple comes from the caller's own profile
  rather than the phone, and a third account that names someone else's id gets nothing. A
  couple that ends takes its taps with it (`ON DELETE CASCADE`), and `verify.sql` fails
  loudly on a project that has not run `supabase/migrations/202610150016_miss_you.sql`.

**The migration is required before deploying this button.** A project without it has no
table and no function to count with, so the button says "The database needs an update.
Please ask the app owner to apply supabase/migrations/202610150016_miss_you.sql" rather than
appearing to work. The migration is additive and rerunnable: it never resets a count.

### The framed couple picture

The centre of the nook is the couple's own picture, standing in a gift-wrapped frame
(`src/components/home/NookPhotoFrame.tsx` — honey wood, stitched mat, corner hearts and a
pink-and-green ribbon bow, the same duo as the racing splash dots). A real photo of the two
of you is the highest form of personalisation the app can offer: opening it shows the picture
from when you were last physically together, or simply your favourite one. Before anything
is framed, the window carries a soft **"Upload your couple picture"** invite instead.

- **One picture per couple.** `couple_photo` is keyed by the couple id itself, so a couple
  frames at most one picture, ever; replacing it moves the same row. Either partner may
  frame or replace — the frame belongs to the couple — and the row's couple can never move
  (a database trigger refuses, past the app and its policies).
- **The phone does the heavy lifting.** A chosen picture is resized to a 1600px JPEG in the
  browser before a single byte leaves the device, so weak mobile data never carries a
  12 MB camera-roll original; a 25 MB original is refused outright.
- **"Fit it to the frame" comes first.** A chosen picture is never uploaded as-is: it opens
  in a crop step (`src/components/home/PhotoCropDialog.tsx`) locked to the mat window's
  exact aspect (67:47, kept in step with the frame's SVG), where the couple drags to
  position and slides to zoom before **Frame picture** uploads exactly what they chose —
  not a quiet `object-fit` crop centred on nobody's decision. Escape, Cancel or a backdrop
  tap steps out without uploading a byte. Where a browser cannot preview or crop (very old
  devices), the original travels on as-is rather than blocking the picture.
- **The replace order is deliberate.** New bytes upload first, then the row moves, then the
  old file is deleted — the frame never points at a file that is not there yet, and a failed
  replace leaves the old picture standing. Tapping a framed picture asks
  "Replace the picture in the frame?" first, because replacing is a couple decision, not an
  accident waiting for a pocket tap.
- **Privacy.** The file lives in the private `couple-photos` bucket under
  `photos/{couple_id}/{photo_id}.jpg` — the folder name is the couple id, which is what the
  storage policies check — and is opened only through short-lived signed URLs. There is
  deliberately no public link: a picture is never readable outside the couple.
- **Live on both phones.** The table sits on the `supabase_realtime` publication, so the
  moment one partner frames a new picture, the other partner's nook updates without a
  refresh (`useCouplePhoto` keeps the signed URL fresh with the row).
- **The rest of the nook is untouched.** The "I miss you" button stays in its top-left
  corner and the "Our little nook" caption stays pinned top-right.

**The migration is required before the frame can hold anything.**
`supabase/migrations/202610180003_couple_photo.sql` adds the table, its policies, the
realtime publication entry and the private bucket. Without it the frame still renders and
invites the upload, but the upload is refused with a readable sentence instead of appearing
to work.

## Epistles — the long letters in the nook

The mailbox standing in the nook's corner is the way into the couple's **epistles**: long,
sealed letters written to each other, deliberately kept apart from the chat. Where a chat
bubble is a sentence, a letter is a page — the interface is paper and wax, not bubbles, and
nothing about it is instant except the arrival.

- **The life of a letter.** An author writes on the writing desk (serif type, a dateline
  naming their own town, an optional title, a word counter) and the draft autosaves as
  they write — a letter is too heavy to lose to a closed app. The letter is never signed
  for them: the last line is theirs to write — *love, Ana*, *always, your Angel*, whatever
  nickname the two of them use — so `LetterPaper` prints the dateline, the optional title
  and their words, and nothing after them. Sealing is a ceremony, not a
  button: read it once more exactly as the partner will see it, choose *when it may be
  opened* (as soon as they like, or a chosen day — an anniversary letter waits sealed with
  a countdown), then press the wax, which carries the writer's initial the way a signet
  does. Recalled, resealed, rewritten: all of it is possible only while the letter is
  still unopened.
- **The reading.** An openable letter glows on its shelf — *tap to break the seal*. The
  wax cracks, the flap lifts, the paper rises out of the envelope, and the ink arrives
  paragraph by paragraph. The database performs the one real write
  (`open_epistle(p_epistle_id)`): it decides whether the day has come, marks `opened_at`
  once, and is the only write the reading partner ever makes. After it, the letter is
  final for both of them, and it stays on the keepsake shelf forever — sealed letters
  cannot be deleted.
- **The shelves.** The mailbox sorts itself: *Waiting for you* (the partner's openable
  letters — the number on the nook's flag), *Sealed until their day* (visible, but the wax
  refuses until the day — decided by the server's clock, not the phone's), *On their way*
  (my own standing letters, each with Read and Take back), keepsakes, and drafts. Realtime
  keeps every shelf honest: a letter sealed on the other side of the world appears without
  a refresh.
- **Storage and rules** (`epistles`, `202610200001_epistles.sql`, additive and rerunnable).
  Body up to 20,000 characters, title up to 80 — counted in code points, the way the
  database's `char_length` counts them, so an emoji is one character and not two. A letter
  is **never silently cut to size**: past the limit the desk keeps every word on the paper,
  shows the count, refuses to save or seal, and says how far past it runs. The same limit
  is enforced by the table's CHECK, and a save that still reaches it is refused with that
  sentence rather than a constraint name. RLS: the couple reads sealed and opened
  letters; a draft is its author's alone; an author reworks their own letter only while it
  is unopened; drafts alone may be deleted. The table is in the Realtime publication, and
  a Database Webhook on seal tells the partner's phone (see **Push notifications**); a
  project without the migration names it in the error the mailbox shows, the way
  miss-you does. Replies need `202610210001_epistle_replies.sql` (the `reply_to_id` column
  and its trigger); without it the desk answers "the database needs an update".

## The Chat tab


A plain, WhatsApp-shaped conversation between the two partners — the second tab from the
left, live, with no refresh anywhere. It is built from:

| Piece | File |
| --- | --- |
| The screen (conversation bar, transcript, composer, toast) | `src/components/chat/ChatView.tsx` |
| State: load, realtime, optimistic sends, receipts, typing, unread | `src/hooks/useChat.ts` |
| Transport: queries, the Realtime channel, validation | `src/lib/chatService.ts` |
| Day separators and bubble times (pure functions) | `src/lib/chatTime.ts` |
| The table, its RLS and its Realtime membership | `supabase/migrations/202610150003_messages.sql` |
| Replies and the author's edit | `supabase/migrations/202610150006_chat_replies_edits.sql` |

- **Bubbles** — your messages sit on the right in Nooki's blush pink, the partner's on the
  left in white, each with its timestamp inside the bubble. The transcript is split into
  days: `Today`, `Yesterday`, then `Mon 12 October` (with the year once it is a different
  one). Paragraph breaks are preserved exactly as typed.
- **Sending** — the composer is a growing multi-line box. **Enter sends the message**
  the way it does in every messenger on a laptop; **Shift+Enter starts a new paragraph**,
  and the send button sends too. A sent message appears instantly, then its real row
  replaces it.
- **Replies** — swipe a message toward the centre of the chat (left on yours, right on
  theirs) or long-press (right-click) it and tap **Reply**: the composer shows
  *"Replying to Bob"* with their words until it is sent or dismissed. The bubble then
  quotes the original above its own text — tap the quote to jump back to the original,
  which lights up so you can see what you landed on.
- **Edits** — the same long-press menu offers **Edit** on your own delivered messages:
  the composer refills with the original words and the send button becomes a save. An
  edited bubble is marked *edited* next to its time. Only the author can edit, only the
  words can change, and the edit stamp is set by the database, not the phone. There is
  deliberately **no delete and no reactions**: the log is permanent, in two voices.
- **Receipts** — a small clock while it is on its way, one check once the database has it
  (single check = sent), and two pink checks once the partner's phone has actually read it
  (double check = read). A send that fails stays on screen as a bubble with
  *"Not sent — tap to retry"*.
- **Typing** — the partner's three-dot bubble appears while they compose, and the
  conversation bar says `typing…`. It is a Realtime broadcast only: never stored, sent at
  most once every 2 seconds, and expired after 4 seconds, so a lost ping can never leave a
  stale "typing…" behind.
- **Read receipts** — `read_at` is stamped only while the Chat tab is on screen **and** the
  app is in the foreground, because you have to be looking at a message to have read it.
  Opening the tab stamps everything the partner sent.
- **Unread badge** — the partner's unseen messages are counted on the Chat tab icon in the
  bottom nav (capped at `99+`), updated live even while this phone sits on Home, Together or
  Games, and cleared the moment the chat opens. Screen readers hear
  *"Chat, 2 unread messages"* instead of the raw number.
- **Conversation bar** — the partner's name and live status (`Online`, `typing…`, or
  `Last seen 12m ago`), plus **phone** and **video** buttons. Those two are deliberately
  inert for now: they show a *"coming soon"* toast until calling ships.
- **Message types** — `type` is `text`, `question`, `answer` or `system` from day one, so
  a future feature can reuse this exact table for prompts, answers and automatic notes.
  `system` rows render as a quiet centred pill, and `sender_id` may be `NULL` only for
  them. The Chat tab itself writes `text`; the Discuss tab keeps its own tables and does
  not post into the transcript.
- **Realtime** — one channel per couple (`nooki-chat-<coupleId>`) carries Postgres Changes
  for `INSERT` and `UPDATE` filtered by `couple_id`, plus the typing broadcast. RLS applies
  to the stream as well, so the other couple never receives these rows.
- **What the database enforces** — messages are a permanent log in two voices: a read
  receipt may only be stamped once and only by the recipient, the words may only change
  at the author's hand (the trigger then stamps `edited_at` itself), and the id, couple,
  author, type, question link and quoted reply are frozen. There is no delete policy,
  and rows cascade away with the couple. A reply (`reply_to_id`) may only quote a message
  inside the same couple, refused row by row by the same policy that scopes "Say more".
  Only the couple's two accounts can read or write them, and the last 200 messages are
  loaded (`MESSAGE_PAGE_SIZE`).

Presence runs at app level, so a partner still reads as online while this phone browses
Chat, Together, Discussion or Games. The app writes its own `last_seen_at` on mount, every
minute while open, and when the tab is hidden — permitted by the existing "update own
profile" RLS policy, so **no migration is required** for any of this. Two caveats:

- Presence and chat both require the Realtime service, which is on by default. Channels
  are public in Supabase unless Realtime Authorization is configured; the topic includes
  the couple's UUID, so only someone who already knows that id could subscribe to it.
  Message rows still go through RLS, so a stranger on the topic receives none of them.
  Enable Realtime Authorization if you want channel access enforced in the database too.
- `last_seen_at` writes fail quietly when the device is offline; presence still covers the
  "Online" case.

### Design preview (development only)

`npm run dev` serves a sample-data preview of the header, Home surface, Chat tab and both
duels at **http://localhost:5173/preview.html**. It uses static names ("Sam & Ana"),
needs no Supabase project, and lets you flip the partner between online and away, switch
anniversary examples, and open the real calendar modal with sample events where
add/edit/delete work in memory. The Chat tab is the real component over an in-memory
transcript, so you can send a message, watch one check turn into two, make Ana type, make
her reply, and see the unread badge. Couple Settings opens here too — the real sheet,
over sample state — which is where its scrolling gets looked at, since it is the longest
surface in the app. The Games tab is the same carousel the app uses — Snake, Chess,
Tetris and Word Wheel in a rail — and each chip is a settings panel first: pick the mode,
difficulty and clock, then press its button to open the real board. Nothing ticks or
starts while you are only reading the tab: the Snake gate waits for **Start my run**, the
Tetris gate for **Start my 5 minutes**, Chess for its duel picker, and Word Wheel for
**Set the wheel** followed by both sides readying up. From there you can steer the snake
with the arrow keys, the WASD keys, a swipe or the D-pad, watch the leave-and-forfeit
question and see the reveal against a sample partner score; play five minutes of Tetris
with the on-screen pad; play both sides of a Chess duel; or swipe a Word Wheel round and
watch its blanks fill. It reuses the real header, chat and board components
so it cannot drift from the
app — but the preview's duel is played out on the page, since the ranked one depends on the
database dealing the food and replaying the run. It is a dev-server route only: `npm run build` still publishes
`index.html` alone, and the app itself has no mock/sample mode.

While no `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` values are present, the dev server
also redirects the root URL (`/`) to `/preview.html` so local development never dead-ends
on the fail-closed connection screen. Once real values are in `.env.local`, `/` serves the
app as usual. The dev port is pinned with `strictPort` so it cannot silently drift off
5173.

## The Discuss tab

A question engine for the couple: pick a corner of your life, pick how deep to go, and the
app hands you a question from the shared library. Ask it, both partners answer privately,
and the two answers appear together the moment the second one lands — then each partner
can say something about them in one comment. When one comment is not enough, **Say more**
carries the question into the chat, where the conversation goes on with the question (and
a link back to those answers) attached. It is built from:

| Piece | File |
| --- | --- |
| The screen: browse, question card, session, history | `src/components/discuss/DiscussView.tsx` |
| Categories, depth chips and the locked 18+ shelf | `src/components/discuss/CategoryPicker.tsx` |
| The question card and "Ask my partner" | `src/components/discuss/QuestionCard.tsx` |
| Composer, sealed state, reveal, comment box and "Say more" | `src/components/discuss/SessionPanel.tsx` |
| The four answer inputs: text, choice, multi-choice, ranking, slider | `src/components/discuss/AnswerInput.tsx` |
| Past questions and their state | `src/components/discuss/HistoryList.tsx` |
| State: load, live re-reads, the pending count, the 18+ gate | `src/hooks/useDiscuss.ts` |
| Transport: queries, the question RPCs, the Realtime channel | `src/lib/discussService.ts` |
| The question vocabulary, shared with the database normalisers | `src/lib/questionFormat.ts` |
| The 18+ switch | `src/components/common/DangerSettingsModal.tsx` |
| Tables, RLS, triggers, RPCs and Realtime membership | `supabase/migrations/202610150004_discuss_questions.sql` |

- **Browse** — the categories come from the library itself, through `question_categories()`:
  each tile shows how many questions are left in it, and the depth chips (1 Light … 5 Deep)
  show how many are left at that level and are disabled when there are none. **Surprise me**
  picks a random question this couple has not asked yet.
- **Answering** — the input follows the question's `input_type`: free typing with a
  character counter, single choice, multi-choice ("2 selected"), ranking (drag on a
  pointer device, up/down buttons everywhere else) or a 1–10 slider. **Send my answer**
  stays disabled until the answer is complete, and the database validates its shape again
  on the way in — a ranking must order every option exactly once, a choice must be one of
  the given options, a slider must be a number from 1 to 10.
- **The seal** — until both partners have answered, each phone sees only its own answer
  (*"Waiting for Bob … No peeking before then"*). This is not a frontend rule: the
  `answers` SELECT policy returns a partner's row only once the session is complete, so no
  edit to the client can force a reveal. The second answer fires
  `answers_sync_session_progress`, which stamps `completed_at` — that stamp *is* the
  reveal, and it locks both answers for good.
- **Reveal, one comment and "Say more"** — the two answers appear side by side with a
  short fade-and-rise animation (`nooki-reveal-card`, suppressed for
  `prefers-reduced-motion`), then each partner can say something about them in one
  comment of up to 1000 characters. A second thought is not typed there: **Say more in
  chat** opens the Chat tab with that question attached, the sent message quotes the
  question on its bubble (`messages.session_id`), and tapping the quote walks both
  partners back to the revealed answers for context.
- **History** — every question this couple has asked, newest first, each marked
  *Revealed*, *Waiting* or *Your turn*. Opening one shows the same sealed or revealed
  view; a sealed one never shows the partner's answer, because it was never sent.
- **History filter** — the *Filter* button beside *Categories* opens a menu of the
  library's categories (the ones this couple may see, each with how many past questions
  it holds) and narrows the history to the one chosen. *All categories* puts the whole
  history back; a category nothing has been asked in yet says so instead of showing an
  empty list.
- **Unanswered badge** — sessions without your answer badge the Discuss tab in the bottom
  nav and repeat the count in the tab header, live, even while this phone sits on Home,
  Together or Games. Screen readers hear *"Discuss, 1 question waiting"*.
- **18+ (Intimacy)** — hidden from the library by default. It opens only when **both**
  partners turn it on under Settings → *Intimacy questions (18+)*; either one turning it
  off closes it again, for both phones. The gate lives in the database: the `questions`
  SELECT policy withholds adult rows until `couple_settings` says both agreed, and the
  session trigger refuses to ask one that is not in the couple's visible library.
- **One shared library, private sessions** — `questions` is global and read-only for the
  app (`SELECT` only; `verify.sql` fails if that ever changes), while `question_sessions`,
  `answers`, `answer_comments` and `couple_settings` are per couple. A couple can ask a
  given question only once (`UNIQUE (couple_id, question_id)`); asking again returns the
  same session rather than a second one.
- **Realtime** — one channel per couple (`nooki-discuss-<coupleId>`) carries Postgres
  Changes for sessions, settings, answers and comments. Every event is treated only as
  "something changed": the app re-reads through RLS instead of trusting the payload, so
  what lands on screen is always exactly what this phone is allowed to see.
- **Breakup** — sessions, answers and comments cascade away with the couple; the shared
  library is untouched and the next couple starts with a clean history.

### Importing the question library

The app ships **no** questions of its own: it reads the `questions` table and nothing else,
so the tab shows "The question library is empty" until you import your CSV. Run this in
the SQL Editor any time after the migration — the app can never write to `questions`
itself, by design:

```sql
INSERT INTO public.questions (id, text, category, seriousness, input_type, options, is_adult) VALUES
  ('fun-001', 'Beach holiday or city break?', 'fun', 1, 'choice', '["Beach","City"]', false),
  ('deep-001', 'What are you quietly afraid of?', 'deep', 5, 'text', NULL, false);
```

| Column | Notes |
| --- | --- |
| `id` | Optional text. Any string is accepted, so keep your CSV's own ids; a UUID is generated when the value is missing or blank. |
| `text` | Required, up to 4000 characters after trimming. A row without one is refused. |
| `category` | Free text, canonicalised to `Fun`, `Deep`, `Family`, `Future`, `Money`, `Home Life`, `Intimacy` or `Silly`. `home`/`homelife` → `Home Life`, `intimate`/`sex` → `Intimacy`, capitalisation and stray spaces are cleaned, and a blank becomes `Uncategorised`. Anything else is kept as written and grouped into its own tile. |
| `seriousness` | 1–5. Out-of-range numbers are clamped, and something non-numeric falls back to 3. |
| `input_type` | `text`, `choice`, `multi_choice`, `ranking` or `slider`. `multiplechoice` → `choice`; `multiselect`, `multi`, `multiple` or `checkbox` → `multi_choice`; `scale` → `slider`; anything unknown → `text`. Single-pick questions are `choice`: use `multi_choice` in the CSV when several options may be ticked. |
| `options` | Required for `choice`, `multi_choice` and `ranking`; ignored (set to `NULL`) for `text` and `slider`. A JSON array of strings, a JSON array of objects carrying a `label`/`text`/`value`/`title`/`name` key, a double-encoded JSON string, or a delimited list (`A|B|C`, `A;B;C`, `A,B,C`) are all understood. |
| `is_adult` | Optional; forced to `true` for anything in the `Intimacy` category. |

A row that cannot be interpreted is refused with a plain-English error naming the question
(*"… needs its options"*, *"… needs its text"*), so a malformed CSV line cannot slip in
half-formed. The same normalisers exist in the app (`src/lib/questionFormat.ts`) and in the
database, and the test suite feeds every accepted spelling through both to keep them in
step — edit one, edit the other.

## Push notifications

A quiet alert on your partner's phone when a message arrives — including while Nooki is
closed and the phone is locked. It is standard **Web Push**, with no notification service,
SDK or account anywhere in the path: Nooki generates its own VAPID keypair, an Edge
Function in your own Supabase project encrypts and signs each payload, and the browser's
own push service (FCM for Chrome/Edge, Mozilla for Firefox, Apple for Safari and iOS)
relays it. That relay is how every notification system reaches a sleeping phone — native
apps included — and it needs no credentials, keys or billing from you.

| Piece | File |
| --- | --- |
| The table, RLS and the three device RPCs | `supabase/migrations/202610150015_web_push.sql` |
| The send-time "server": who to notify, and the VAPID signing | `supabase/functions/send-push/index.ts` |
| Its gateway setting (the webhook is not a signed-in user) | `supabase/config.toml` |
| Browser transport: subscribe, release, badge, deep link | `src/lib/pushService.ts`, `src/lib/pushConfig.mjs` |
| This device's state | `src/hooks/usePushNotifications.ts` |
| The switch, and one explanation per platform | `src/components/common/PushNotificationsCard.tsx` |
| The notifications themselves, and the tap | `public/nooki-sw.js` |
| Installed-app identity (required on iOS) | `public/manifest.webmanifest`, `index.html`, `public/icons/` |

### What each platform requires

| Where | Push arrives with the app closed? | What the user must do |
| --- | --- | --- |
| Android — Chrome, Firefox, Edge, Samsung Internet | Yes | Nothing beyond the switch in Couple Settings |
| Desktop Chrome / Edge / Firefox | Yes, while the browser is running | Nothing beyond the switch |
| Desktop Safari (16.1+), macOS Sonoma+ | Yes, while the browser is running | Nothing; **Add to Dock** also earns an icon badge |
| **iPhone / iPad (16.4+, including iOS 26)** | Yes | **Share → Add to Home Screen**, then open Nooki from the new icon and switch notifications on |

On iOS the Push API only exists for a web app added to the Home Screen: a Safari tab cannot
subscribe at any API level, and a permission prompt that did not come from a tap is
ignored. The settings card detects that and shows the two steps instead of a switch that
could not work (`support = 'needs-install'`). Nothing asks for permission on load, on any
platform.

### Turning it on (one-time, ~10 minutes)

1. **Apply the migration.** Run `supabase/migrations/202610150015_web_push.sql` in the SQL
   Editor (or, on a brand-new project, use `schema.sql`, which already contains it). Add it
   to the list in **Deploying this release** if you keep your own runbook.
2. **Generate a keypair, once, anywhere:**
   ```sh
   npx web-push generate-vapid-keys
   ```
3. **Set the public half for the frontend** as `VITE_VAPID_PUBLIC_KEY` (Vercel → Settings →
   Environment Variables, Production *and* Preview), then redeploy — the value is inlined
   at build time. A missing or malformed key is a warning, not a failed build: push stays
   off and everything else works.
4. **Deploy the sender and give it its secrets:**
   ```sh
   supabase functions deploy send-push --no-verify-jwt
   supabase secrets set VAPID_PUBLIC_KEY=<the public half> \
     VAPID_PRIVATE_KEY=<the private half> \
     VAPID_SUBJECT=mailto:you@example.com \
     PUSH_WEBHOOK_SECRET=<a long random string>
   ```
   `--no-verify-jwt` is required: a Database Webhook presents a service key rather than a
   signed-in user's token, and `send-push` does its own authorisation check instead (the
   `PUSH_WEBHOOK_SECRET` you set below, or at minimum the Authorization header every
   Supabase webhook sends). The private half must never appear in a `VITE_` variable, in
   the repository, or in the app bundle.
5. **Add the webhooks** (Dashboard → Database → Webhooks → Create). Each one is type
   **Supabase Edge Function** → `send-push`, method `POST`, with the header
   `Authorization: Bearer <the same PUSH_WEBHOOK_SECRET>`:

   | Table | Events | What it tells the partner |
   | --- | --- | --- |
   | `messages` | Insert | a message arrived |
   | `answers` | Insert | it is their turn to answer |
   | `game_matches` | Update | it is their move |
   | `miss_you_taps` | Insert, Update | they are missed — only the first tap of a batch |
   | `epistles` | — | the letters' knock, which no dashboard webhook can express |

   `supabase/migrations/202610250002_fix_push_webhooks.sql` finishes the job. Run it once
   the dashboard webhooks above exist: it copies the endpoint and the `Authorization`
   header off a webhook that already works, and uses them to add the three triggers a
   dashboard form cannot create —

   - `epistles_sealed` (Update): fires only when `sealed_at` goes from NULL to set, so a
     draft autosave never knocks and a recalled letter keeps its one knock;
   - `epistles_sealed_on_insert` (Insert, `WHEN sealed_at IS NOT NULL`): a letter that is
     created already sealed still knocks;
   - `miss_you_taps_insert` / `miss_you_taps_update`: the first tap of a waiting batch. The
     function compares `old_record` with `record` and stays silent for taps piling onto an
     unopened heart, so tapping freely is not tapping your partner's phone to death.

   Keeping the secret out of the file is the point of reading it back off a live webhook —
   it is written once, in the dashboard, and never in the repository. `supabase_functions.http_request`
   builds the body the function expects (`type`, `table`, `schema`, `record`, `old_record`),
   and an empty body is silently skipped.

   > The same migration unschedules a `pg_cron` sweep left behind by the removed
   > Together-time tab, which had been POSTing `together_time_sessions` — a table `send-push`
   > does not watch — once a minute, around the clock.

   **Redeploy the function too.** Webhooks that exist on a function that predates the event
   are worse than no webhook: they answer 200 and drop the notification on the floor. After
   deploying, one row in each table's recent `net._http_response` history should read a
   handler answer (`{"sent":…}` or a `skipped` that names that table), never
   `not a watched table`.
6. **Verify**, then switch it on per device: Couple Settings → **Notifications**. The
   switch is per browser, not per account — a phone and a laptop are two independent
   devices, and turning one off never touches the other.

`supabase/verify.sql` checks the table, its RLS policies, the "no direct update" rule and
the three RPCs, so a half-applied push migration is caught by the same preflight as
everything else. The function's own TypeScript is checked by `npm run check:functions`
(against the real `web-push` types, with `supabase/functions/deno.d.ts` standing in for the
Deno globals); it cannot be *executed* locally, so deploy it and send yourself a message
before telling anyone it is finished. Signing out releases every device of the account server-side (the browser
keeps its subscription, so signing back in is one tap rather than a fresh prompt), and a
device that the push service reports as gone (404/410 — app deleted, permission withdrawn)
is deleted from the table rather than retried forever.

### What a notification shows, and what it does not

The title is the sender's name and the body is the first ~140 characters of the message —
a lock screen is a public surface, so there is no "reply in app" permalink into a
conversation and no message history beyond the one that arrived. Tapping it opens the Chat
tab (`/?nooki=chat`), focusing the copy of Nooki that is already open instead of starting a
second one; leaving a live duel still asks before forfeiting it. While the app is open the
home-screen icon shows the unread count (Badging API), cleared exactly where the messages
are actually read.

The payload carries only the sender's name, the preview, the tab and the unread count. The
device's endpoint and public keys live in `push_subscriptions`, readable only by their own
account — not by the partner, and not by `anon` — and the private VAPID key exists only as
a function secret. `send-push` needs the service key because the sender must read the
*recipient's* devices; that key never leaves the function.

### Known limits

- **iOS reach is gated by the install step.** A partner who never adds Nooki to their Home
  Screen cannot receive anything on an iPhone, however the app is configured. The card
  explains the two steps; a previously dismissed notification permission shows
  `support = 'blocked'` and points at Settings instead of asking again.
- **You cannot test it from a laptop.** Push needs an HTTPS origin with a real service
  worker and, for iOS, a device. Use the deployed Vercel URL and two phones; the local
  preview page has no backend and never registers a subscription.
- **The Vite dev server is fine for the API**, but a service worker on `localhost:5173`
  will be registered for that origin — remove it in DevTools → Application if you switch
  projects, or a stale worker can serve a stale subscription.

### Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| The card says notifications are off "for this Nooki yet" | `VITE_VAPID_PUBLIC_KEY` is missing or malformed in the environment the build used. Rebuild and redeploy; check the build log for the warning. |
| The switch turns itself off again | The RPC failed: the push migration was not applied, or `PUSH_WEBHOOK_SECRET`/VAPID secrets are missing on the function. `verify.sql` and the function's logs will say which. |
| Subscribed, nothing arrives | The webhook is not on `messages`/Insert, its Authorization header does not match `PUSH_WEBHOOK_SECRET`, or the message had a NULL `sender_id` (system notes are deliberately not announced). Supabase → Edge Functions → `send-push` logs show every call. |
| Chats notify but letters or miss-yous stay silent | Either the triggers are missing or the deployed function is older than the event. Run `202610250002_fix_push_webhooks.sql` (it needs `202610210002_miss_you_push.sql` first, or the function cannot read the taps) **and** redeploy `send-push`. In Supabase → Edge Functions → `send-push` logs, a stale build answers `{"skipped":"not a watched table"}` for a table it should handle. |
| Works on Android, silent on iPhone | The app is in a Safari tab rather than added to the Home Screen. Push cannot exist there. |
| The function will not boot: `Cannot find module 'https'` (or a web-push error at import) | The pinned `npm:web-push@3.6.7` could not run on that runtime. Replace it with Deno's own implementation (`jsr:@negrel/webpush`), which changes only the import and the two calls (`setVapidDetails`/`sendNotification`) — the payload, the secrets and the webhook stay exactly as they are. |
| It worked, then stopped after a few days | The browser rotated its subscription. Opening the app re-claims it automatically (the registration refresh runs on load); if it recurs weekly, check the function logs for 410s against a stale endpoint. |

## Deploying this release — exact steps

### 1. Database (Supabase dashboard → SQL Editor)

Run **one** of these, depending on the project:

| Project state | Run this |
| --- | --- |
| Brand-new, empty project | `supabase/schema.sql` once, then `supabase/verify.sql` |
| Live project with real couples | The migrations in order — `202610150001_pairing_flow.sql`, `202610150002_couple_events.sql`, `202610150003_messages.sql`, `202610150004_discuss_questions.sql`, `202610150005_discuss_comments_chat_links.sql`, `202610150006_chat_replies_edits.sql`, `202610150007_games.sql`, `202610150010_snake_duel.sql`, `202610150011_chess.sql`, `202610150012_tetris_duel.sql`, `202610150008_shared_books.sql`, `202610150009_two_book_shelf_limit.sql`, `202610150015_web_push.sql`, `202610150016_miss_you.sql`, `202610170001_partner_locations.sql`, `202610170002_daily_decisions.sql`, `202610180001_daily_decision_pool.sql`, `202610180002_remove_daily_games_and_tic_tac_toe.sql`, `202610180003_couple_photo.sql`, `202610180004_duel_report_retries.sql`,
`202610180006_connect_four.sql`, `202610180007_together_visits_and_someday_list.sql`, `202610180008_someday_details_order_and_visit_link.sql`, `202610180009_dash_duel.sql`, `202610190001_word_wheel.sql`, `202610190002_dash_duel_dodge_speed.sql`, `202610190003_word_wheel_async_practice.sql`, `202610190004_together_tab_restructure.sql`, `202610190005_together_time_agreement.sql`, `202610190006_remove_shared_books.sql`, `202610190007_someday_notebook_and_remove_together_time.sql`, `202610200001_epistles.sql`, `202610210001_epistle_replies.sql`, `202610210002_miss_you_push.sql`, `202610250001_lock_truth_or_dare_spicy.sql`, `202610250002_fix_push_webhooks.sql`, `202610300001_raise_a_child.sql`, `202610300002_raise_a_child_talk_it_out.sql`, `202610300003_raise_a_child_chat_links.sql`, `202610300004_daily_decision_chat_links.sql` — then `supabase/seed/word_puzzles.sql`, `supabase/verify.sql` (PASS), plus `supabase/verify-games.sql` once Games is live |

All migrations are idempotent and safe to rerun. Take a snapshot first: the Games
retirement migration deletes daily-game and Tic Tac Toe match history,
`202610190006_remove_shared_books.sql` deletes shared books and files, and
`202610190007_someday_notebook_and_remove_together_time.sql` deletes scheduled Together-time
records and converts former private ideas into shared list items. Legacy idea notes are kept
in storage but no longer shown. The other migrations preserve existing data.

`supabase/verify.sql` is read-only and must print **PASS**. It checks the pairing RPCs,
RLS on every table, the anniversary-lock trigger, the `couple_events` calendar, the repeat
column, the realtime `messages` chat (type check, policies, immutability trigger and
publication membership), the Discuss engine (its five tables, the policies that never
reveal a sealed answer, the canonicalised library, the three question RPCs, and that the
app cannot write to `questions`), the web-push device table (its RLS policies, the "no
direct update" rule and the three RPCs), the miss-you tap table (that it can only be
written through its functions), the profile locations (their seven columns, the
whole-place check, the generated `city_key` and the key rule spelled the way the frontend
spells it), and that `anon` cannot reach couple data. If it raises,
it names the file to rerun. `verify-games.sql` additionally checks that both duels' replays and their private
internals are in place, that a phone cannot settle a duel or score a run without playing
it, and that Word Wheel has a shared puzzle, per-player start times and server-counted
results. Word Wheel also needs its pregenerated puzzle bank: run
**`supabase/seed/word_puzzles.sql`** once after its migrations.

**If you already ran the calendar migration before the repeat control existed**, rerun
`202610150002_couple_events.sql`: it upgrades `repeats_yearly` to `repeat_frequency` in
place, converting `true` rows to `'yearly'`, then drops the old column.

### 2. Project settings (Supabase dashboard)

- **Authentication → Providers**: Email enabled.
- **Authentication → URL Configuration**: Site URL = your production origin, and the
  production plus preview callback URLs in the redirect allowlist.
- **Authentication → Emails → SMTP**: configure custom SMTP before real users sign up. The
  built-in sender is capped at **2 emails/hour for the whole project**, only delivers to
  your organisation's team members, and is the cause of the `over_email_send_rate_limit`
  error. With your own sender the cap starts at 30/hour and is yours to raise under
  **Authentication → Rate Limits**.
- **Edge Functions** (only for push notifications): deploy `send-push` from this
  repository (`supabase functions deploy send-push --no-verify-jwt`, or paste
  `supabase/functions/send-push/index.ts` into the dashboard), set its `VAPID_*` and
  `PUSH_WEBHOOK_SECRET` secrets, add the Database Webhooks on `messages` (Insert),
  `answers` (Insert), `game_matches` (Update) and `miss_you_taps` (Insert, Update), and run
  `202610250002_fix_push_webhooks.sql` for the letters' trigger. Raise a Child adds one
  more caller of the same function: a Database Webhook whose type is **Scheduled**
  (Dashboard → Database → Webhooks → Create → *Scheduled*, not table events) pointing at
  `send-push`, plus the Vault secrets `nooki_send_push_url` and
  `nooki_push_webhook_secret` that the hourly job reads. Redeploy the function whenever a
  new event type is added: a webhook on a function that does not handle its table answers
  200 and drops the notification. The step-by-step list is under **Push notifications**
  above and under **Raise a Child** below.
- **Realtime**: on by default, nothing to configure. Presence uses a couple-scoped channel,
  chat messages ride Postgres Changes on `messages`, Discuss rides a second couple-scoped
  channel over `question_sessions`, `couple_settings`, `answers` and `answer_comments`,
  and `last_seen_at` writes ride on the existing "update own profile" policy. The chat and
  Discuss migrations add those tables to the `supabase_realtime` publication (checked by
  `verify.sql`). Optionally enable Realtime Authorization to lock channels down at the
  database level.
- **Table privileges**: no action needed. The migrations now grant `profiles`, `couples`,
  `couple_events`, `messages` and the five Discuss tables to `authenticated` explicitly and
  revoke `anon`, so the app works whether or not the project still hands out Supabase's
  legacy automatic grants (projects created since 2026-05-30, and every project from
  2026-10-30, need the explicit grants). The Discuss migration also revokes write access to
  `questions` from `authenticated` — on a legacy project that inherited it — so the shared
  library stays read-only for the app.

### 3. Environment (Vercel → Project Settings → Environment Variables)

- `VITE_SUPABASE_URL` — the HTTPS project URL.
- `VITE_SUPABASE_ANON_KEY` — the **public anon or publishable** key only, never a
  service-role/secret key.
- `VITE_VAPID_PUBLIC_KEY` — optional, for push notifications: the **public** half of the
  VAPID keypair. The private half is a Supabase function secret and must never be set
  here.

Set them for Production and any Preview environment you test, then **redeploy**: the values
are inlined at build time, so an existing deployment keeps the old ones. A preview pointing
at the production project uses real production data.

### 4. Verify before pushing

```sh
cp .env.example .env.local   # fill in the two values
npm ci
npm run check:env            # fails closed without valid public config
npm test                     # unit, UI and database tests; no live project contacted
npm run lint
npm run build
```

A green build does **not** prove the live database, key validity, email delivery or
two-device behaviour — run the acceptance test below as well.

## Checks before pushing

With your real project settings in `.env.local`:

```sh
npm ci
npm run check:env
npm run build:geo         # the place dataset; predev and prebuild run it for you
npm test
npm run lint
npm run check:functions   # type-checks the send-push Edge Function (no Deno needed)
npm run build
```

`npm ci` installs `country-state-city` and `tz-lookup` (devDependencies), which
`build:geo` reads to write the git-ignored `public/geo/`. Without them the location
pickers fall back to typed fields and the browser's timezone, and nothing else changes.

Tests run in isolated PostgreSQL (PGlite) and DOM environments. Test accounts exist only
inside those tests: no test contacts, inserts data into, or resets your live project.
Tests cover password visibility, email-confirmation handling, place selection and the
timezone derived from it,
pairing navigation/cancellation, protected profile retries, anniversary locks, RLS,
configuration failures, the read-only database verification script, and the global header
(YMD counter across end-of-month/leap-day edges, partner clock timezones and weekdays,
last-seen labels, the presence dot greying out and re-greening, and the `last_seen_at`
heartbeat), the calendar (the month grid, anniversary/monthsary clamping, yearly repeats
including 29 Feb, the upcoming window, swipe direction, `couple_events` CRUD under RLS
with cascade on breakup, that `verify.sql` catches a project missing the calendar
migration, and the full UI flow of browsing, adding, editing, deleting and closing without
leaving the Home tab), and the chat: day separators and bubble times, `messages` under RLS
(reads and writes sealed per couple, the type check, read receipts, the immutability of a
sent message, cascade on breakup and safe re-migration), and the live tab itself — send
with the button and with Enter (Shift+Enter making the paragraph), an incoming message
appearing without a reload, one check turning into two when the partner reads it, the
typing indicator, the unread badge counting and clearing, day grouping, auto-scroll,
retry after a failed send,
and the phone/video buttons saying "coming soon"), and discuss: the question vocabulary
normalised identically in SQL and TypeScript for every accepted spelling, a CSV-shaped
import repaired or refused row by row, one shared library with per-couple sessions,
answers sealed by RLS until both partners reply and the reveal that the second answer
triggers, all four input types validated in the database, comments gated on the reveal,
the 18+ gate needing both partners and closing the moment either opts out, a third account
and an unpaired user refused, cascade on breakup with the library left intact, safe
re-migration, and `verify.sql` catching a half-applied one — plus the live tab itself:
browsing categories and depths, asking, answering privately, the reveal arriving over
realtime, commenting, "Say more" into the chat and the quote linking back, the unanswered-question badge, ranking by button, the
multi-choice, slider and text inputs, editing a sealed answer, the settings switch and an
empty library, the settings sheet's own scaffolding (capped by the frame, one scrolling
body under a pinned header, and the backdrop around it never scrolling instead), the
launch path (the boot splash's race handed to the React splash as a head start rather
than replayed, the fonts fetched without blocking the first paint, and the couple plus
partner fetched as two trips in flight at once instead of three in a row), and
push notifications: the platform matrix (an iOS tab told to install, a
refused permission named as blocked, a browser without the Push API offered no switch at
all), the public-key shape check that refuses half a keypair, the deep link a notification
carries and its consumption, the service worker's push/tap/badge handlers (and the absence
of a fetch handler), the manifest and icon sizes an install needs, the RPCs an account
uses to claim, release and re-claim a device under RLS, cascade when an account or couple
is deleted, and that `verify.sql` catches a project missing the push migration — plus the
Edge Function's own checks (no private key in the file, a 404/410 device deleted, the
partner rather than the author notified), and the miss-you button: the taps that are
waiting (received ones are never counted twice, a partner away for a weekend adds up
without claiming "today"), the wording for one tap, four taps, a second batch the same day
and a batch across two days, the taps counted per sender and per own calendar day in the
database (a wrong clock refused, one row per day, receiving as the reset that keeps the
day's record, a third account and a self-receive refused, direct writes to the table denied
by RLS, cascade when the couple ends, safe re-migration and `verify.sql` catching a
half-applied one) — plus the live tab: the button in the top-left of the nook only while the
partner is away, three taps counted on the button and in the database, and the other
phone's load opening the big heart with the sentence and marking the taps received, once —
and the locations: the generated place dataset (zones kept and canonicalised, cities
grouped under the right state, a city that keeps another clock written down as an
exception, and a real run over all 250 countries into a throwaway directory), the place
rules in TypeScript (the key, the derivation order city → state → country, what may be
saved and what is refused), the marketplace's choice of city (the partner's by default,
yours next, one city when you are in the same one, and the sentence that says whose turn
it is when they have not added theirs), the columns and constraints in the database (a
migrated live project keeping its couples, a generated key that cannot be written, half a
place refused, a partner reading but never rewriting, a stranger seeing nothing, and
`verify.sql` naming the migration when any piece is missing), and the two forms themselves:
signup deriving `Africa/Lagos` from Nigeria and `America/Chicago` from Gary, Indiana,
keeping a zone picked by hand, typing a state where the data has none, degrading to typed
fields when one country's file is missing and to the old timezone picker when the index is
— and Couple Settings showing both places, and saving one partner's move without touching
the rest of their profile.

A successful build does **not** verify a deployed key, email delivery, an applied live
migration, or two-device connectivity. Complete the acceptance test below as well.

## Push and deploy

Work for this Arena session stays on `arena/15aaf779-nooki`:

```sh
git status
git diff --check
git add .
git commit -m "Collect country, state and city: a derived clock, Update location in Couple Settings, and the marketplace's city"
git push origin arena/15aaf779-nooki
```

Open a pull request from that branch to `main`. Test the Vercel preview with its environment
settings configured, then merge the reviewed PR to your configured production branch.
Pushing this working branch alone does not necessarily update the production site.
`vercel.json` builds with `npm run build`, publishes `dist`, and provides SPA routing —
with two identity rewrites ahead of the catch-all so the service worker and the web app
manifest are never answered with `index.html` (a worker served as HTML fails to register
with a MIME error, and push would silently never work).
Do not publish a build produced with automated-test configuration.

## Required deployed acceptance test (two separate devices/browsers)

Use your actual accounts; there is no automatic user creation.

- [ ] Both partners can sign up/confirm email/sign in independently.
- [ ] Password show/hide works; signup asks for country, state and city, and the timezone
      shown is the one that place implies (Nigeria → Africa/Lagos) with `Change` still
      available. On a phone in another country, check the derived zone is the local one.
- [ ] Partner A can create a code and edit/save the anniversary while waiting.
- [ ] A can go back, confirm cancellation and choose either create or enter a code.
- [ ] A cancelled code is rejected; a newly generated code is accepted by partner B.
- [ ] B can join using the current code, including a pasted/lowercase code.
- [ ] Both devices unlock the same couple; A's waiting screen updates automatically.
- [ ] Every tab's header shows both names with a live "Together for 2Y 1M 4D" counter.
- [ ] With both apps open, the header dot is green with a faint pulse; hovering/long-pressing it says the partner is online.
- [ ] Closing one app greys the dot within about a minute and its tooltip reads "Last seen ...".
- [ ] The header clock beside the dot matches the partner's own device time and weekday, and never shows your own clock.
- [ ] The Today card shows today's date and the anniversary/monthsary that fall today.
- [ ] With one app open and the other closed, the nook shows a small "I miss you" pill in its top-left corner; open both and it disappears.
- [ ] Before a picture is framed, the nook's frame invites "Upload your couple picture"; the chosen picture opens in the fit-to-frame step (drag + zoom) and frames exactly what was chosen. Framing one on device A shows it on device B without a refresh, and B's replace (behind its confirm) lands back on A.
- [ ] Tapping it a few times shows the count on the button (2, 3…) and never on the other phone yet.
- [ ] Opening the other app shows a big heart expanding over the load with "… missed you N times today" (a single tap reads "Hi, … missed you"), fading away on its own.
- [ ] Opening that second app again shows no heart: the taps were received, and the count starts again from one.
- [ ] The calendar icon opens the calendar over the Home tab; the tab is still there when you close it.
- [ ] Tapping a day adds, edits and deletes an event, and the other device sees the change after a refresh.
- [ ] Tapping the repeat chip on the event form cycles Once → week → month → year, and the saved event shows that wording.
- [ ] A weekly event reappears 7 days later, a monthly one on the same day next month, and a yearly one the following year.
- [ ] Swipe left/right and the ‹ › buttons move months; the picker jumps to any month and year.
- [ ] Chat opens with the partner's name, their live status and the phone/video buttons; both
      buttons show a "coming soon" toast.
- [ ] A message typed on device A appears on device B without a reload, on the correct side
      (your own on the right in pink, the partner's on the left in white).
- [ ] Enter sends the message; Shift+Enter starts a new paragraph, and the send button
      sends too.
- [ ] The "typing…" indicator and three-dot bubble appear on the other device while typing,
      and disappear shortly after it stops.
- [ ] One check appears once the message is stored, and two checks once the other device has
      the chat open; a message sent with the network off shows "Not sent — tap to retry" and
      retries successfully.
- [ ] Messages from days ago sit under `Yesterday` / weekday separators as you scroll back.
- [ ] Swiping a message toward the centre of the chat (or long-pressing it and tapping
      Reply) quotes it above the composer, the sent bubble shows the quote, and tapping
      the quote jumps back to the original message on either device.
- [ ] Long-pressing your own message offers Edit; saving it marks the bubble "edited"
      with the new words on both devices, and the partner's messages never offer Edit.
      There is no delete option anywhere.
- [ ] Sending from device B while device A sits on Home shows a pink count on the Chat tab,
      and opening the chat clears it.
- [ ] A third account cannot read or write the couple's messages.
- [ ] Discuss opens on categories with what is left in each; the Intimacy tile is a lock
      that explains how to open it, and no adult question text reaches either device.
- [ ] Tapping a category shows depth chips with counts, and a depth with nothing left is
      disabled. "Surprise me" produces a question the couple has not asked.
- [ ] "Ask my partner" opens the answer composer with the input that question asked for,
      and Send stays disabled until the answer is complete.
- [ ] Device A's answer stays sealed: A sees only their own answer, and B's answer is
      nowhere on A's screen or in A's network responses until B has answered too.
- [ ] When device B answers, both answers appear side by side on both devices without a
      refresh, with the reveal animation.
- [ ] After the reveal, a comment saves on one device and appears on the other; the
      answers are locked and cannot be edited any more, and **Say more in chat** opens the
      chat with the question attached — the sent message quotes it, and the quote reopens
      the revealed answers on both devices.
- [ ] A question asked from device B while device A sits on Home badges the Discuss tab,
      and the history list marks it "Your turn".
- [ ] Ranking reorders by dragging and by the up/down buttons, and the stored order
      matches what was sent. Multi-choice, slider and text answers store as written.
- [ ] Turning Intimacy on in Settings on one device only leaves the category locked;
      turning it on for both unlocks it, and either device turning it off hides it again.
- [ ] With an empty `questions` table, Discuss says "The question library is empty"
      instead of showing bundled questions; after importing the CSV the categories fill up.
- [ ] Home shows only the compact **Today’s decision** card; its Play button opens the
      couple's private daily choice.
- [ ] Uploading `daily_decision_questions` rows (question + three options, no date) fills
      the pool; opening Today's decision shows one random question with exactly its three
      options, the same one on both devices all day, and a different unseen one tomorrow.
      With an empty pool the sheet explains that no decisions have been added yet, and a
      couple that has been assigned every question is told they've been through them all
      rather than being shown a repeat.
- [ ] After device A submits, A sees their own choice but device B cannot see it in the UI
      or response rows. Once B replies, both choices appear on both devices.
- [ ] Matching choices mark the decision agreed and lock it; differing choices stay
      editable and **Take to chat** posts one line with an **Open today's decision** link
      (no options in the chat), and tapping that link reopens the card on both devices.
- [ ] A third account cannot read either partner's responses, and an app user cannot write
      prompt rows or update/delete responses directly.
- [ ] A third account cannot read the couple's sessions, answers or comments.
- [ ] The Together tab has no **Read together** shelf, no book upload, no full-screen reader,
      and no Together-time scheduler.
- [ ] The Someday list looks like one paper notebook: one-line task titles, numbered rows,
      and up/down arrows that save the shared order for both partners. There are no private
      ideas, context fields, or want/vote controls; either partner can remove an item.
- [ ] **Clear this visit** in the edit sheet asks "Clear this visit for both of you?" first;
      confirming removes the countdown on both phones and ideas pinned to the visit reappear
      on the someday list. "Keep it" changes nothing.
- [ ] Adding a task on either phone updates the numbered notebook on both; up/down arrows
      persist the new order, and either partner can complete or delete a task.
- [ ] Couple Settings shows **Notifications**; on Android/desktop the switch turns on after
      the browser's permission prompt, and says "On this device" afterwards.
- [ ] With both apps closed, a message from device A produces a notification on device B
      within a few seconds, showing the sender's name and the first line of the message.
- [ ] Tapping the notification opens the Chat tab — from cold, straight onto the chat, and
      from an already-open Nooki, by switching tab without a reload or a second window.
- [ ] The home-screen icon shows the unread count while the app is closed, and the count
      clears once the chat is open on screen.
- [ ] Turning the switch off on device B stops its notifications, and device A's own device
      is unaffected; signing out on B also stops them even though the browser keeps the
      permission.
- [ ] On an iPhone in a Safari tab the card shows the Share → Add to Home Screen steps and
      no switch; after adding it to the Home Screen and opening it from the icon, the switch
      appears and works.
- [ ] A third account never sees the couple's devices: it cannot read the table, claim or
      mute another account's device.
- [ ] After joining, anniversary edits and unilateral cancellation are rejected.
- [ ] A third account cannot join an already complete couple.
- [ ] Refreshing and signing out/in preserve the couple, anniversary and partner names.
- [ ] Check browser Network errors and Supabase Auth/Postgres logs if any step fails.

## Current feature scope

Signup, onboarding (a first name plus country, state and city, with the timezone derived
from the place instead of picked from 400), pairing, the global header (couple names, live
together counter,
presence ticker and the partner's local time), the Today card and shared calendar, the
compact Home game/decision cards, and **Daily Decisions** (owner-uploaded three-choice
prompts, private answers revealed only after both reply, a shared decision only on matching
choices, and a Take to chat bridge), the realtime **Chat tab** (message bubbles, day separators, sent/read receipts, typing
indicator, unread badge, multi-paragraph composer), the **Discuss tab** (a shared question
library read from the database, category and depth browsing, "Surprise me", four answer
input types, answers sealed until both partners reply — enforced by row-level security —
the side-by-side reveal, one comment each under the answers, the **Say more** bridge
into the chat (`messages.session_id` quoting the question and linking back to the
reveal), history and an
unanswered-question badge, and a both-partners 18+ gate), couple details, sign-out,
**Update location** (each partner's own place, which moves the other's clock and the city
the marketplace will open on) and
mutual-breakup settings are implemented. **Couple Settings** (the header's gear) is a
sheet pinned inside the phone frame: the title and the X stay put and the sections scroll
under them, so a new setting lengthens the list instead of pushing the danger zone off
the bottom of the screen. **Notifications** are standard Web Push sent by
this repository's own `send-push` Edge Function — no notification service, SDK or account
is involved — with a per-device switch in Couple Settings, the platform requirements
explained in place (an iPhone needs the app on its Home Screen), a tap that opens the Chat
tab, and an unread count on the installed app's icon. Together hosts **Next visit** (a
countdown to the next shared date), **Raise a Child** (one small life, raised together one
year at a time — one card opens the family; see its own section below) and **Someday** (a
shared, numbered notebook of task titles that both partners can add, reorder, complete and
delete). Together time and Read together
have been removed. Synced music
and scrapbooks are still to come. Games includes
Rock Paper Scissors, Chess, Sudoku, asynchronous Snake and Tetris Duels, and Dash Duel
(a Lagos runner with an async course challenge, online-only live race and local free play).
Voice/video calling is still a "coming soon" toast. No sample conversations or questions
are loaded into the app itself — the in-memory transcript only exists on the development
preview page, Discuss uses the rows imported into `questions`, and Daily Decisions uses the
owner-uploaded pool rows in `daily_decision_questions`, drawn one random unseen question per couple per day.
Home also carries the **framed couple picture** standing in the nook — the couple's own
photo in a gift-wrapped frame, one per couple, replaceable by either partner, stored in a
private couple-scoped bucket and opened only through signed URLs — and the **"I miss you"
button** in the nook's top-left corner, offered only while the partner is away. Taps are counted per partner and
per day, and the other phone opens them over its next load as a big heart with a sentence
that counts them ("Hi, Jayo missed you", "Jayo missed you 4 times today"), then resets.
Scenes and illustrated backgrounds are deliberately out of scope for now: the Discuss tab
uses the plain sage accent colour like every other surface. So is the **marketplace**:
what exists is the location model it needs and `resolveMarketCities()`, the function that
decides which city it opens on — no vendors, no listings, no Market tab and nothing for
sale (see **What the marketplace scaffolding is (and is not)**).

## Design system

`src/tokens/designTokens.ts` contains the warm cream, blush pink, pastel mint, lavender
and sage palette, typography, radii and shadows. The app remains locked until both
partners are paired; ending a completed couple requires both partners' agreement.

## Games tab

Games are always available: there is no daily Games challenge. Apply
**`supabase/migrations/202610150007_games.sql`**, then
**`202610150010_snake_duel.sql`**, **`202610150011_chess.sql`**,
**`202610150012_tetris_duel.sql`**, then
**`202610180002_remove_daily_games_and_tic_tac_toe.sql`**, **`202610180006_connect_four.sql`**,
**`202610180007_together_visits_and_someday_list.sql`**,
**`202610180008_someday_details_order_and_visit_link.sql`**,
**`202610180009_dash_duel.sql`**, **`202610190001_word_wheel.sql`**,
**`202610190002_dash_duel_dodge_speed.sql`**, and
**`202610190003_word_wheel_async_practice.sql`** to an existing project before running
**`supabase/verify-games.sql`**. New projects receive the same final shape from
`schema.sql`. Word Wheel also needs its puzzle rows: run **`supabase/seed/word_puzzles.sql`**
once after the migrations (the seed is idempotent). The retirement migration deletes historical daily-game and Tic Tac Toe rows,
removes their date/board columns, and replaces the daily-flag Games RPC.

### Truth or Dare

Truth or Dare lives in the Games tab — as one chip in the game rail, beside the duels
rather than as its own card on the tab — and uses a couple-scoped room with server-refereed
turns and Supabase Realtime updates. Both partners tap **I’m in** for each round. Flirty
requires both to meet 18+, using a stored profile date of birth when available and
otherwise a one-time minimum-age confirmation; only the confirmed age tier is stored, and
no columns are added to `profiles`. Random has no age gate.

**Spicy is locked for everyone.** Age is not proof of marriage, so the theme cannot be
opened by any couple right now — not by a 20+ confirmation, not from the theme picker, and
not by calling the RPCs directly. It is visible in the picker as a dashed, disabled
**Married couples only** card. `public.tod_theme_locked()` is the single switch that every
Spicy-facing RPC consults, and `tod_start_round` also ends any Spicy room left open by an
older build so a couple is never trapped in an unplayable round. The lock migration closes
those rooms and withdraws approved Spicy prompts from the live pool. Spicy returns only
when marriage-certificate verification ships: at that point, replace
`public.tod_theme_locked()`, re-activate reviewed Spicy prompts and restore the Spicy bucket
in `public.tod_state()`.

`supabase/seed/truth-or-dare/` holds six prompt buckets prepared for review: 120 prompts
each for Random/Flirty/Spicy × Truth/Dare, with 24 at each intensity. The Spicy buckets stay
in the repository for the future release but must remain inactive. Run
`npm run seed:truth-or-dare -- --validate-only` to check counts, length limits and near
matches. To seed, set `SUPABASE_URL` and the server-only `SUPABASE_SERVICE_ROLE_KEY`, then
run `npm run seed:truth-or-dare`. The upsert is safe to rerun and does not overwrite an
owner's active/review state. All rows start inactive; after content review, the owner must
activate prompts in Supabase. Until both Truth and Dare have active prompts for a theme,
the app keeps that theme unavailable.

- **Rock Paper Scissors:** best of 3 (first to 2 wins) or 5 (first to 3). Ties replay
  without adding a point. Each pick stays secret until both partners lock in.
- **Snake Duel:** one authoritative, no-pause run each; the higher score wins. The database
  deals food and replays reported turns, so a phone cannot claim a score it did not play.
  Leaving or going quiet for more than 30 seconds forfeits the run.
- **Chess:** classic chess, Capture Race and Queen Hunt; the database validates every move.
- **Sudoku:** a solo, race or shared grid in easy, medium and hard difficulties.
- **Tetris Duel:** each partner plays the same server-dealt pieces in a five-minute sprint
  or survival duel. The database replays taps to settle the result.
- **Connect Four:** turns are async and resume across devices. The server checks whose turn it
  is, drops each checker into the selected column, and decides wins and draws under a row lock.
- **Dash Duel:** a three-lane Lagos dodge run with top-to-bottom obstacles, left/right-only
  lane changes and a speed ramp that picks up as you survive. It has async shared-course
  challenges, a live race shown only while the partner is online, and a local unranked free
  run. The server replays inputs to verify distance and hearts.
- **Word Wheel:** play a solo practice run any time, or set an asynchronous challenge with
  your partner. Multiplayer shares the same seven-letter wheel and hidden words, but each
  player starts their own 1, 3 or 5 minute clock whenever they are ready — no need to be
  online together. Swipe across the letters (each letter once, swipe back to undo) or type
  a word. Correct words fill the blanks and the seven-letter grand prize has its own row.
  Most words wins; a tie goes to the earlier last word on that player's own clock. Practice
  is local and never affects multiplayer scores.
- **The library is a carousel, not a scroll.** The game titles sit in a rail at the top
  (Rock Paper Scissors → Snake → Chess → Sudoku → Tetris → Connect Four → Dash → Word
  Wheel → Truth or Dare) and only the chosen game's rules, settings and start button sit
  under it. Tap a title, use the arrow keys, or swipe the card sideways to walk the rail;
  a swipe that ends on a button is never mistaken for a tap on it. Adding a game means
  adding one entry to `GAMES` and one panel — the rail, the focus order and the swipe come
  for free.
- **Truth or Dare is a chip, not a card above the rail.** Its panel names any open round
  and opens the shared round (or the theme picker) from there; it is the same entry point
  as Sudoku's. `src/lib/gameLibrary.ts` holds the rail order: the duels from `GAMES`
  followed by Truth or Dare, the one entry there that is not a duel row.
- **Raise a Child is a reserved seat, and its own card.** It sits above the Ongoing games
  card — the place a game of its own takes on this tab — and holds nothing but the game's
  name and a disabled **Coming soon** button, on a dashed edge. No rules, no promise, no
  way to start it: it is deliberately kept out of the rail because it is the one thing on
  the tab that is not a game yet. `RaiseAChildCard` in
  `components/games/LibraryPanels.tsx` is where it will start when its rules exist.
- **The Games tab is three things.** The **Raise a Child** seat described above; an
  **Ongoing games** card, always showing how many games are open, holding one swipe per
  live match at a single card's height; and the game catalogue carousel beneath it.
  Nothing else sits on the tab. A match waiting on
  you wears a 🔔 bell and says **Your move**; a match waiting on your partner says
  **Waiting for {partner}** and wears no bell, so you can see at a glance which game to
  open. A duel whose two runs are in — and every settled match — leaves the card
  entirely: finished duels are history, not something to "resume". The Games tab badge
  counts matches waiting for this phone.
- Secret picks and live opponent scores are never exposed through direct table access or a
  realtime payload; the app receives only the sanitized Games RPC snapshot.

Before release, test each game with two paired accounts, including a reload during an open
match and a sealed Rock Paper Scissors pick. For Snake, Tetris and Dash Duel, test their
run/ready flows on two phones. For Word Wheel, also verify solo practice works without a
partner action, then test an async challenge with widely separated start times: each phone
must receive its full selected duration from its own start. Check that a player who never
starts is zero-filled after the seven-day challenge window, a started attempt that never
submits is zero-filled after its own deadline and grace period, and equal scores use each
player's own last-word elapsed time for the tie-break.

### Word Wheel puzzles

The full product and implementation spec — rules, round lifecycle, difficulty matrix,
generation pipeline, RPC contract, edge cases and the two-device release checklist — is
[`docs/WORD_WHEEL_PRODUCT_SPEC.md`](docs/WORD_WHEEL_PRODUCT_SPEC.md).

The puzzle bank is generated ahead of time and stored; the server never invents a puzzle
during a round. Each row in `word_puzzles` holds seven letters, the seven-letter
`base_word` (the grand prize), the union of every word used by its packs (a searchable
vocabulary record), and a `packs` object with one exact hidden list for every
difficulty × duration combination:

```json
{
  "letters": "ceiprtu",
  "base_word": "picture",
  "packs": {
    "easy":   { "60": ["picture", "price", "cute", "true", "cut", "put", "it"] },
    "medium": { "60": ["picture", "cutie", "price", "truce", "cute", "true", "cut", "put", "it"] },
    "hard":   { "300": ["picture", "...20 words..."] }
  }
}
```

Longer rounds ask for more words; harder levels lean toward longer words while keeping
the same 2–7 letter mix and the seven-letter grand prize. A pack the base cannot fill is
omitted, so the server never deals an impossible round.

- **Regenerate:** `npm run build:word-puzzles` writes
  `supabase/seed/word_puzzles.sql` and `.json` from the curated base list in
  `scripts/word-puzzle-bases.json`, using the SUBTLEX frequency list and the English
  dictionary dev-dependencies.
- **Upload:** run `supabase/seed/word_puzzles.sql` in the Supabase SQL Editor, or set
  `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` (server-side only, never a `VITE_`
  variable) and run `npm run upload:word-puzzles`. Both paths upsert on `base_word`, so
  rerunning is safe.
- **Review:** the generator blocks rude, medical, violent and name-like words. Read a new
  batch before uploading anyway; word quality is the part players notice most.

### Troubleshooting the Duel button

The library button calls `start_game('snake', …)`; **Start my run** then calls
`snake_start`. The Tetris Duel is the same shape with its own entry point: the card calls
`start_tetris(mode)` and **Start my 5 minutes** calls `tetris_start` — a duel fixed to a
mode gets an RPC of its own, exactly as Chess does. All of them depend on the live database,
not just a successful Vercel build. The base Games migration cannot start Snake on its own,
so it rejects Snake with `Invalid game settings.` even though the Games library loads
normally, and a Tetris card on a project without `012` reports `012` by name.

In the Supabase project used by the deployment:

1. Apply `supabase/migrations/202610150007_games.sql` if Games has not been installed.
2. Apply pending `supabase/migrations/202610150010_snake_duel.sql` **after** `007`,
   then `supabase/migrations/202610150011_chess.sql` for the Chess-enabled release, then
   `supabase/migrations/202610150012_tetris_duel.sql` for Tetris, and finally
   `supabase/migrations/202610180002_remove_daily_games_and_tic_tac_toe.sql`.
3. Run `supabase/verify-games.sql` and require **PASS**, then try Duel again.

If `verify-games.sql` instead fails with **"The Snake internals must stay
server-side: public.snake_commit(uuid,integer,jsonb,boolean)"**, the project was
installed before migrations 010, 011 and 012 named `authenticated` in their internal
`REVOKE`s: Supabase's default privileges grant EXECUTE on every new public
function directly to `authenticated`, so the internals stayed callable by any
signed-in phone. Run
**`supabase/migrations/202610150013_lock_down_game_internals.sql`** — it changes
privileges only (no functions, tables or data, safe with saved matches, safe to
run twice) — then rerun `verify-games.sql` and require **PASS**.

If starting **Chess** fails with **"new row for relation "game_matches" violates
check constraint "game_matches_game_check""**, Chess is installed but the game
check on the project predates it — each Games migration replaces that constraint
wholesale, so rerunning `010` after `011` silently removes `'chess'` from it.
Run **`supabase/migrations/202610150014_restore_chess_tetris_game_check.sql`** (it
restores just that constraint — to the current full list, Tetris included — touches
no functions or data, and refuses to run if Chess was never installed — in that
case apply `011` instead), then rerun `verify-games.sql` and require **PASS**.
The app no longer shows the raw constraint text for this: it names the database
update to apply.

Do not rerun the full schema on an existing project. Rerunning `007` after `010`
overwrites `start_game` and `games_state` with their older versions. If Chess already has
saved matches, do **not** rerun the whole older `010` script: its game constraint excludes
Chess. Take a backup and restore only the affected `start_game` definition from `010` and
the latest `games_state` definition — from `012` on a project that has Tetris, otherwise
`011` — preserving the Chess-enabled constraint. Tetris is the one game here that adds no
`start_game` of its own, so a restoration that keeps `start_game` intact keeps Tetris
starting too.
The verifier detects obsolete Snake entry points, missing Chess support, missing
tables/functions and unsafe permissions.

A failed start stays visible next to its library button (or above an open match), names
the Snake migration when appropriate, and survives background polling. **Try again**
retries the actual failed action. Starting a duel/run also shows a pending label and blocks
duplicate taps. Pairing and network errors remain distinct from migration errors.

### Sudoku layout and browser regressions

The board has nine equal rows and columns, continuous cell borders, and thicker 3×3 box
boundaries. Cells explicitly reset the library buttons' padding/radius/minimum size; the
board and number pad shrink to their containing card instead of overflowing narrow phones.
The header wraps, all nine number keys stay together, and Erase has its own row.
Sudoku and Snake warm-ups do not need the shared Games snapshot to load. Sudoku is still
local to this device; its competition/collaboration settings are not synchronized with a
partner's device.

The browser tests render the real Games UI/hook with intercepted HTTP responses (no live
Supabase calls), check actual cell geometry at 320, 360, 390, 480 and 1024px, and cover
Duel start/resume, missing-migration errors across polling, retry, and offline local play.
The PostgreSQL tests additionally run the old/new migrations and the real Duel RPC flow.

```sh
npx playwright install chromium   # once, on your development/CI machine
npm run test:browser
# Or use an already installed Chromium:
# PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium npm run test:browser
```

## Together tab: Read together (removed)

Read together — the shared EPUB/PDF shelf, the full-screen reader, saved places,
highlights and the chat-to-book jump — has been removed from the Together tab.
Apply **`supabase/migrations/202610190006_remove_shared_books.sql`** on an existing
project. It deletes shelf rows, reading progress, highlights, and Together-time records
whose activity was a book. Hosted Supabase will not let SQL delete the private
`shared-books` bucket; remove that bucket in Storage after the migration if a file
is still there. Migration `202610190007_someday_notebook_and_remove_together_time.sql`
removes the remaining Together-time scheduler and reminders.
A chat message that quoted a passage keeps the words already stored on that message;
only the link back into a book goes away. New projects get the same end state from
`schema.sql`. Do not run `verify-books.sql`; that check belonged to the retired feature.

## Together tab: Our next visit & the someday list

Before deploying to an **existing** project, apply
`supabase/migrations/202610180007_together_visits_and_someday_list.sql`,
`supabase/migrations/202610180008_someday_details_order_and_visit_link.sql`, and
`supabase/migrations/202610190007_someday_notebook_and_remove_together_time.sql`, then run
`supabase/verify.sql` again. New projects
get the same tables and functions from `schema.sql`.

### The notebook

- **Adding** — write a single task title (up to 500 characters); new tasks go to the end
  until either partner moves them. The notebook has no practical item limit.
- **Numbering and order** — numbered paper-like lines follow the couple's saved order.
  Accessible up/down arrows work on phones and keyboards; changes are saved for both.
- **Completion and deletion** — either partner can check off, restore, or delete any task.
  No vote or agreement is required before removing something. There are no private items,
  context/notes fields, or “I want this” controls.
- **Migration** — old private entries are retained and become shared tasks. Legacy note text
  remains in storage but is not displayed in the notebook.

### Planning the next visit

- With no visit set, **Pick your next visit date** is the most prominent card. The existing
  visit planner still stores the shared date, location and timezone; the card keeps its
  countdown once a visit is saved. Plans change, so the edit sheet also has **Clear this
  visit**: after an in-place "Clear this visit for both of you?" the visit comes off the
  calendar on both phones and the empty state returns. Someday ideas pinned to the visit go
  back to the unplanned list (the database unlinks them rather than deleting them).
  The wish, day-by-day plan, checklist and memories sections that used to sit under the
  countdown were removed from the tab; their tables stay in the schema (and under RLS),
  so no existing data was deleted — the client simply no longer reads or writes them.

### Removed feature

Together time scheduling, due-time push reminders, private Someday visibility, and yes-votes
are retired. The latest database migration drops the scheduling table and reminder functions;
it also converts all existing private list entries to shared items so the couple has one
notebook. Existing visit dates and the other visit-planning tools are unchanged.

### Data and privacy

The shared notebook and visit data remain couple-scoped with row-level security. Both partners
can read and arrange every notebook task; Realtime keeps their list in step.

Local coverage: `node --test tests/someday-database.test.mjs tests/someday-hook.test.mjs tests/someday-list.test.mjs tests/together-restructure.test.mjs tests/together-time-removal.test.mjs tests/together-hooks.test.mjs tests/together-tab.test.mjs`.

Before release, use two real paired accounts: set a next visit, then clear it and confirm
the countdown disappears on both phones; add and reorder tasks from each phone and check
that both see the same numbering; complete and delete an item from either account. Check
that a third account sees none of the couple's data.

## Raise a Child — one small life, decided together

A cosy life sim for two: one child, one chapter per year, from birth to eighteen. Both
parents answer the same small moment privately, the answers reveal together, and the year
resolves on the server. It is entered from **one card in the Together tab** — not a tab, not
a rail chip — and it opens as a sheet over the page.

Nothing here shames anyone. There are no bars, scores, streaks or bond numbers; a split is
described in a sentence and felt as a gentle nudge, and a missed day is met with “We went
with your pick.”

### Deploying

1. **Database.** Apply, in order, `supabase/migrations/202610300001_raise_a_child.sql`,
   `202610300002_raise_a_child_talk_it_out.sql` (the split, the two decisions each, the
   lead parent's call), `202610300003_raise_a_child_chat_links.sql` (the link from a
   "Talk it out" message back to its moment), and `202610300005_raise_child_decision_memory.sql`
   (strict age ranges and family-scoped decision prerequisites) in the SQL Editor — or use
   `supabase/schema.sql` on a new project. These migrations are safe to rerun. The memory
   migration adds a column to `event_templates` and updates the picker. Then run
   `supabase/verify-games.sql`: it checks the family tables and the chat links, that the
   temperament and the bonds are unreadable from the app, and that only the nine app RPCs
   are executable.
2. **The hourly job.** The migration schedules `nooki-raise-a-child-hourly`
   (`7 * * * *`) on `pg_cron`, calling `public.raise_child_daily_tick()`. It opens the
   day's moments and gifts, resolves anything past its timeout, and queues at most one
   notification per person per day. If your project has no `pg_cron`, the app still works
   for the current day, but new days only open when someone loads the tab (the state RPC
   ticks the caller's own family).
3. **Push (optional).** The same `send-push` function now drains the day's queue:
   * Vault → add `nooki_send_push_url` = `https://<project>.supabase.co/functions/v1/send-push`
     and `nooki_push_webhook_secret` = the same long random string you set as
     `PUSH_WEBHOOK_SECRET` on the function.
   * Database → Webhooks → **Create a new webhook** → type **Scheduled** (not a table
     event), name `raise-child-daily`, table `raise_child_notifications`, method `POST`,
     Edge Function `send-push`, header `Authorization: Bearer <the same secret>`.
   * Redeploy `send-push` after updating this release: without its
     `raise_child_notifications` branch the scheduled call answers 200 and sends nothing.
   * Realtime needs no configuration; the tables are added to `supabase_realtime` by the
     migration.

### The loop

- **A chapter is a year.** The child's age is the chapter, and a chapter holds
  `moments_per_chapter` moments (`moments_young` while the child is 0–3) — three normally,
  two while they are tiny. They arrive one a day, and Age up appears once every moment in
  the chapter has been answered, once per day by default. A chapter with fewer cards than
  that has run out of content: it can end rather than stall.
- **A moment is one card.** Both parents see the same title, scene and 2–4 options — three
  where the batch allows it, because two reads as yes or no. Each answer is sealed: the
  other phone is told only that a pick exists.
- **Same pick** → “You both wanted the same thing.” The option's effects land, the year
  settles at once, and the bond moves by its small value for both.
- **Different picks** → nothing settles by itself. Both picks come into the open and the
  card offers two ways through: **Talk it out**, which posts the split into the chat and
  opens it — the message says who picked what and carries an **Open this moment** link
  that brings either parent back to the card, still undecided — and — for that year's
  **lead parent** only (alternating each chapter) —
  **Use my decision**, which settles the year with their own pick, in the open. A split
  that settles this way says so plainly: “You wanted different things. Ana had this
  year's call, and used it.” The option's own bond value is ignored; each parent's bond
  moves by one point, in opposite directions, and the child keeps their own small mood
  change. Nothing is scored, and nothing compares the parents.
- **Two decisions each.** Every parent can change their mind once while the card is open
  (`family_votes.revisions`, 0 → 1). A change that lands on the other parent's pick
  settles the year as an agreement. A change that still disagrees leaves the card open
  with the second say spent — the pick is final from there.
- **No answer inside 24 hours** → the pick that was made counts, the note reads “We went
  with Ana's pick.”, and neither bond moves. No penalty, no mention of the wait. A split
  nobody settled or used is kept by the lead parent when the clock runs out, said plainly:
  “You wanted different things. This year went with Ana's call.”
- **Gifts** arrive daily for both parents, drawn from the child's age and traits. Each is
  a small card in the album.
- **Milestones** write themselves at 1, 5, 7, 14 and 18.
- **At eighteen** the child writes a templated letter to both parents, built from the
  traits they showed and how often the parents agreed. There is no external AI in the
  path, no app-drawn signature, and the letter is never cruel. Both parents can write one
  short note back, keep the album forever, and start a new child (which archives the old
  family rather than deleting anything).

### What the parents see, and what they never see

| Kept hidden | Shown instead |
| --- | --- |
| the child's temperament (drawn server-side from both parents' traits) | nothing — it only colours which cards and gifts fit |
| both parents' bond values (0–100) | one soft line of language, and a heart |
| the partner's sealed pick | “Ana has answered.” |
| gift weighting | the card itself, from the child |

The hidden columns are hidden by **database grants**, not by politeness: `authenticated`
may select `child_state` and `family_parents` only through explicit column lists that omit
`temperament` and `bond`. `verify-games.sql` fails if that ever changes, and
`tests/raise-a-child-database.test.mjs` proves it with a real `SET ROLE authenticated`.

### Setup

Each parent picks three of the ten parent traits (`trait_catalog`), with a one-line
description beside each. Together they name the child and choose a skin tone, a hair style
and an outfit colour. The family only becomes active when both parents have their three
traits and the child has a name; the first chapter and the opening gift follow immediately.

### Writing the moments — the content pipeline

**This repository contains no production moments.** The game is only as good as the batch
you write, and `docs/EVENT_CONTENT_SPEC.md` is the brief to paste into whatever writes it:
the JSON shape, every rule the importer enforces, the effect ranges, the trait lists, the
content rules (no death, serious injury, abuse, neglect, abandonment, unresolved bullying,
sexual content, child substance use or self-harm; grade-7 English; no brands; every option a
trade-off), the coverage targets, and five labelled examples.

```sh
npm run events:validate -- ./batch-01.json          # rules only; writes nothing
npm run events:import   -- ./batch-01.json          # validates, then upserts as INACTIVE
npm run events:import   -- ./batch-01.json --activate   # only once you have read them
npm run events:activate   -- --batch=batch-01
npm run events:deactivate -- --slugs=the-broken-vase,one-more-chapter
npm run events:coverage   -- --batch=batch-01
```

`validate` and `import` refuse a batch on any problem and print every one with its slug and
field: missing fields, unknown category or tone, `min_age`/`max_age` outside 0–17 or out of
order, 1 or 5 choices, duplicate labels, `setup_text` over 220 characters, `outcome_text`
over 260, unknown child trait keys, effect weights outside −2…2, unknown or contradictory
trait tags, duplicate slugs, near-duplicate titles or scenes (80% of the words shared), and
an obvious-word screen for the excluded topics. `import` upserts on `slug`, so re-running a
corrected batch updates those rows and touches nothing else. A batch is written with
`active = false` unless you pass `--activate`: nothing reaches a family by accident.

`events:import`, `activate`, `deactivate` and `coverage` need `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` in the environment. The service key never reaches the app, and
`event_templates` is read-only for every signed-in phone (active rows only).

**Dashboard or script?** The dashboard's row editor is fine for *looking* at a row or
flipping `active`, but a moment's `choices` is a nested JSON array of objects with their own
effects; pasting that into the grid view is where quoting mistakes happen, and a broken card
is only discovered by a family mid-chapter. Write and change content through the script (or
`WITH ... INSERT` SQL built from a validated file), and use the dashboard only to inspect
what landed. `--json` on `validate` prints the machine-readable problem list, which is handy
in CI.

The picker keeps every card within its exact age range. It prefers cards matching the
family's traits, then falls back to unfiltered traits; it never repeats a card a family has
already met. With `202610300005_raise_child_decision_memory.sql`, follow-ups may also
require particular resolved choices from the same family; those requirements are never
relaxed. Existing resolved moments serve as memory. If nothing fits, the family has a
quiet day instead of an error. `events:coverage` names thin age bands and missing categories,
but counts do not guarantee a particular family meets a card's trait or memory requirements.

### Tuning

Every number lives in one row of `game_config` (edit with SQL; the app cannot write it):

| Column | Default | Meaning |
| --- | --- | --- |
| `moments_per_day` | 1 | how many moments can arrive in a day |
| `moments_per_chapter` | 3 | how many moments a year holds from age 4 up |
| `moments_young` | 2 | how many a year holds while the child is 0–3 |
| `timeout_hours` | 24 | how long a moment waits before the lone pick counts |
| `chapters_per_day` | 1 | age-ups allowed per real day |
| `gifts_per_day` | 1 | surprise cards per parent per day (0 turns them off) |

`raise_child_state()` returns the whole tuning row to the app, so a change takes effect on
the next load without a deploy.

### Files

| Piece | File |
| --- | --- |
| Tables, RPCs, RLS, cron | `supabase/migrations/202610300001_raise_a_child.sql` |
| The split, two decisions each, the lead's call | `supabase/migrations/202610300002_raise_a_child_talk_it_out.sql` |
| The link from a chat message back to its moment | `supabase/migrations/202610300003_raise_a_child_chat_links.sql` |
| The way back from a chat bubble | `src/hooks/useRaiseChildChatLinks.ts`, `src/components/chat/ChatView.tsx` |
| Content pipeline | `scripts/raise-a-child-events.mjs` |
| The brief for writing moments | `docs/EVENT_CONTENT_SPEC.md` |
| Service, realtime and error copy | `src/lib/raiseChildService.ts` |
| State and actions | `src/hooks/useRaiseChild.ts` |
| The Together card | `src/components/raisechild/RaiseAChildCard.tsx` |
| The family sheet (setup, home, album, letter) | `src/components/raisechild/RaiseAChildModal.tsx` |
| The layered child drawing | `src/components/raisechild/ChildAvatar.tsx`, `src/lib/raiseChildLook.ts` |
| Design-preview state | `src/preview/PreviewTogether.tsx`, `src/preview/usePreviewRaiseChild.ts` |
| Push queue handler | `supabase/functions/send-push/index.ts` |

### Tests

`node --test tests/raise-a-child-database.test.mjs tests/raise-a-child-events.test.mjs tests/raise-a-child-ui.test.mjs`

- **Database (PGlite, real RLS and real column grants):** "Talk it out" posting one linked
  message (and reusing it rather than copying), setup by one parent then both,
  trait validation, the temperament absent from every JSON field and unreadable as a column,
  private votes (the partner sees zero rows until both answer), a split going to the lead
  parent with a two-point bond difference, the lead alternating at the next chapter, the
  24-hour timeout resolving with the lone pick and no bond change, the daily and per-moment
  age-up rules, the configured pacing, eighteen writing the letter, replies, the archived
  family, another couple's rows being invisible, content being unwritable, and a quiet day
  with no active content.
- **Content pipeline:** every validator rule, the CLI refusing a bad batch, the batch
  summary and coverage report, and that a batch is written inactive unless asked.
- **UI (jsdom, real components over the preview's in-memory family):** the one card in
  Together, the private pick, the waiting state, the reveal, the gift, the album grouped by
  age, and the letter with its one-line reply.

Two-device acceptance before release: pair two real accounts, choose traits on both
phones, name the child together, answer a moment from each side and watch the reveal appear
on both without a refresh; check that the second phone never shows the first pick before
its own; leave a moment unanswered past its timeout; age up twice and confirm the second is
refused; set `moments_per_day = 2` and confirm the second card appears. Then confirm a third
account sees no family data and cannot select a temperament or a bond.

## Everyday status + mood (Home)

Before deploying this feature to an **existing** project, apply
`supabase/migrations/202610180005_everyday_status.sql` in the Supabase SQL Editor.
It is additive and safe to rerun. New projects get it through `supabase/schema.sql`.

Home now shows a compact **Our day** card beside **Today’s decision**. It opens a
modal with both partners’ current check-ins side by side: optional mood, activity and a
120-character note. At least one field is required; sharing is never mandatory.
Updates expire after 12 hours by default, with 1- and 4-hour choices. A server-side
policy hides expired rows; Home also checks expiry every 30 seconds and on resume.
Realtime refreshes inserts, updates and acknowledgements; polling covers missed
changes, expiry and clears (Realtime delete filters are not reliable).

Only the author can save/clear their own check-in, through authenticated functions.
Their paired partner can acknowledge the exact visible version once. Editing resets
the acknowledgement. There is one stored snapshot per person, not a mood history;
expired snapshots remain inaccessible until replaced/cleared or the couple is deleted.
Deleting the couple cascades to these snapshots. Nothing is inferred from presence
or location, and check-ins do not send push notifications.

**Message** opens the existing couple chat without posting an automatic message or
carrying over a Discuss question. The editor stays inside the Our day modal, so Home preserves space for
the couple picture frame. The compact card reads “[Partner] left a message” when
the partner has an active check-in, otherwise “Update [Partner] on your day”. Switching accounts/couples or leaving Home discards unsaved drafts.

Two-device acceptance check after migration:
1. Share a mood-only update on one device; confirm the other sees it.
2. Send “Thinking of you”; verify the author sees it, and a replacement resets it.
3. Save an activity/note, cancel an edit, and clear your update. Confirm your partner's
   snapshot is unaffected; the other device reflects a clear within 30 seconds.
4. Tap Message and verify the existing conversation opens with no auto-sent text.
5. Test expiry and re-entry, and verify an unrelated account cannot read either row.

Local coverage: `node --test tests/everyday-status.test.mjs tests/everyday-status-ui.test.mjs`.

### Mascot artwork transparency

The five `src/assets/companions/pair-*.png` expressions use real alpha, including
inside the affectionate pose's heart pocket (not a baked-in grey checkerboard).
`public/assets/nooki/boot-pair.png` is derived from the cleaned happy pose so the
pre-React loader and React splash do not use different cutouts. Installed-app icons
retain their intentional cream canvas, with grey residue removed between the faces.
User-uploaded couple photos are not processed or changed by this cleanup.

To repeat or verify this targeted cleanup after changing artwork, install Pillow
in a Python virtual environment, then run `python scripts/clean-companion-art.py`
and `python scripts/check-companion-art.py`. The cleanup preserves enclosed eye,
shoe and clothing details; the regression check also protects the pink heart.
