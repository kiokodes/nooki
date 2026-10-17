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
   marketplace key generated from them). Apply pending migrations in
   this order; they preserve existing records.
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
   See **Locations, and the marketplace they are scaffolding for**.
3. Run `supabase/verify.sql` in the same SQL Editor. It is read-only and checks required
   functions, authenticated/anonymous pairing permissions, table permissions, RLS, the
   anniversary-lock trigger, the `couple_events` calendar, the realtime `messages` chat,
   the Discuss tables, reveal policy and question RPCs, the web-push device table, the
   miss-you tap table and the profile location columns (including that `city_key` is still
   generated by the database and still spells `ng/ri/port-harcourt` the way the frontend
   does). It must return **PASS**; if it complains about `couple_events`,
   `messages`, `questions`, `miss_you_taps` or `profiles.city_key`, that migration step was
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
(including `couple_events`, `messages`, the five Discuss tables, the shared-books tables,
`push_subscriptions` and `miss_you_taps`), the location columns and generated marketplace
key on `profiles`, RLS policies, pairing, question, push-device and
miss-you RPCs, the
anniversary and answer-reveal triggers, the Realtime publication membership for the chat
and Discuss tables, the mutual-breakup RPCs and the private `shared-books` storage bucket;
it does not populate user/couple records, and it contains no questions — import those
separately. Notifications additionally need the `send-push` Edge Function, its VAPID
secret and the `messages` Database Webhook, which no SQL file can create for you.

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

## Launch, the splash and the first paint

Opening the installed app is the one part of Nooki a couple does every session, so it is
deliberately the cheapest:

- **The boot splash paints before any JavaScript.** `index.html` carries a plain HTML/CSS
  copy of the splash (wordmark + the pink and green race) inside `#root`, so a phone shows
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

## Today card, daily game card and the full calendar

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
- A **Daily game card** (`src/components/home/DailyGameCard.tsx`): a playable
  **"Today's challenge"** card with a **Play** button and a head-to-head scoreboard
  showing wins for each partner (saved daily and practice wins).
- The **cozy nook** at the bottom of the screen — the shared room the companions stand in,
  with the "I miss you" button in its top-left corner (see below).

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
  bottom nav (capped at `99+`), updated live even while this phone sits on Home, Media or
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
Chat, Media, Discussion or Games. The app writes its own `last_seen_at` on mount, every
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
surface in the app. The Games tab is the real snake board over a
simulated duel: deal a run, steer it with the arrow keys, the WASD keys, a swipe or the
D-pad, watch the leave-and-forfeit question, and see the reveal against a sample partner
score; a toggle above the board switches to the Tetris Duel, where you can play five
minutes of it with the on-screen pad. It reuses the real header, chat and board components
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
  Media or Games. Screen readers hear *"Discuss, 1 question waiting"*.
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
5. **Add the webhook** (Dashboard → Database → Webhooks → Create):
   - Table `messages`, event **Insert**.
   - Type **Supabase Edge Function**, function `send-push`, method `POST`.
   - HTTP header `Authorization: Bearer <the same PUSH_WEBHOOK_SECRET>`.
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
| Works on Android, silent on iPhone | The app is in a Safari tab rather than added to the Home Screen. Push cannot exist there. |
| The function will not boot: `Cannot find module 'https'` (or a web-push error at import) | The pinned `npm:web-push@3.6.7` could not run on that runtime. Replace it with Deno's own implementation (`jsr:@negrel/webpush`), which changes only the import and the two calls (`setVapidDetails`/`sendNotification`) — the payload, the secrets and the webhook stay exactly as they are. |
| It worked, then stopped after a few days | The browser rotated its subscription. Opening the app re-claims it automatically (the registration refresh runs on load); if it recurs weekly, check the function logs for 410s against a stale endpoint. |

## Deploying this release — exact steps

### 1. Database (Supabase dashboard → SQL Editor)

Run **one** of these, depending on the project:

| Project state | Run this |
| --- | --- |
| Brand-new, empty project | `supabase/schema.sql` once, then `supabase/verify.sql` |
| Live project with real couples | The migrations in order — `202610150001_pairing_flow.sql`, `202610150002_couple_events.sql`, `202610150003_messages.sql`, `202610150004_discuss_questions.sql`, `202610150005_discuss_comments_chat_links.sql`, `202610150006_chat_replies_edits.sql`, `202610150007_games.sql`, `202610150010_snake_duel.sql`, `202610150011_chess.sql`, `202610150012_tetris_duel.sql`, `202610150008_shared_books.sql`, `202610150009_two_book_shelf_limit.sql`, `202610150015_web_push.sql`, `202610150016_miss_you.sql`, `202610170001_partner_locations.sql` — then `supabase/verify.sql` (PASS), plus `supabase/verify-games.sql` once Games is live and `supabase/verify-books.sql` once books are live |

All of the migrations are idempotent and safe to rerun; they never drop or rewrite existing
data (the pairing migration only changes policies, the calendar migration only adds a table
or converts an older one in place, the chat migration only adds a table, its policies and
its Realtime membership, and the Discuss migration only adds tables, functions, triggers
and policies). Take a snapshot first anyway.

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
it names the file to rerun. `verify-games.sql` additionally checks that both duels'
replays and their private internals are in place, and that a phone cannot settle a duel or
score a run without playing it.

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
  `PUSH_WEBHOOK_SECRET` secrets, and add the Database Webhook on `messages` (Insert). The
  step-by-step list, with the exact commands, is under **Push notifications** above.
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
- [ ] A third account cannot read the couple's sessions, answers or comments.
- [ ] The Media tab's empty shelf shows **Read together** with an Upload book button and
      the "DRM-free EPUB or PDF only" note; a picked file appears as the reading book.
- [ ] A second upload while a book is reading says "Leave or delete current book first."
      and the same rule holds even if the request is forced through.
- [ ] The reading card shows the title, both people's percentages and Continue reading;
      the reader opens full-screen, resumes this phone's place, and saves progress a few
      seconds after page turns (not on every turn).
- [ ] Tap the middle of the page to hide and show the bars; tap the edges or swipe to
      turn pages.
- [ ] Selecting text opens the comment box; **Highlight & share** paints the passage in
      this phone's colour and sends the quote (and comment) to the chat on both devices.
- [ ] Tapping the quote card in the chat opens the reader at the passage on both devices.
- [ ] Both devices see both people's highlights in the book, each in their own colour.
- [ ] "Jump to {partner}" lands on the partner's saved place, and their percentage on
      the bottom bar moves live while they read.
- [ ] Leave pauses the book and the card offers Continue reading again; Mark as finished
      keeps it with a Finished badge; Delete asks first, removes the file and row, and the
      quote in the chat keeps its words with the jump disabled ("Book deleted").
- [ ] A scanned PDF says it has no selectable text and simply cannot highlight — reading
      and jumping still work.
- [ ] A third account cannot read the couple's books, bookmarks or highlights, and no
      book file is reachable without the couple's own signed URL.
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
presence ticker and the partner's local time), the Today card with the shared calendar,
the realtime **Chat tab** (message bubbles, day separators, sent/read receipts, typing
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
tab, and an unread count on the installed app's icon; the chat is the only thing announced
so far. Media hosts **Read together** (shared books:
one EPUB or PDF in play per couple, a full-screen reader, saved places for both
partners, "Jump to {partner}", shared two-colour highlights, and the highlight → chat →
back-to-the-passage loop); synced music and scrapbooks are still to come. Games includes
Tic Tac Toe, Rock Paper Scissors, Chess, Sudoku, the asynchronous Snake Duel and the
asynchronous Tetris Duel (five minutes each, in either a sprint or a survival), and
voice/video calling is still a "coming soon" toast. No sample conversations or questions
are loaded into the app itself — the in-memory transcript only exists on the development
preview page, and the question library is whatever the owner imported into `questions`.
Home also carries the **"I miss you" button** in the nook — the small pink pill in the
top-left corner, offered only while the partner is away. Taps are counted per partner and
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

## Games tab and Today's Challenge

Apply **`supabase/migrations/202610150007_games.sql`** to an existing project before
shipping Games, then **`supabase/migrations/202610150010_snake_duel.sql`** before shipping
the Snake Duel, then **`supabase/migrations/202610150011_chess.sql`** before shipping
Chess, then **`supabase/migrations/202610150012_tetris_duel.sql`** before shipping the
Tetris Duel, then run **`supabase/verify-games.sql`** in addition to the usual
`verify.sql`. New projects get all four from `schema.sql`. The migrations are additive
and rerunnable; they do not reset existing matches or duels. Apply pending Games
migrations in order (007 → 010 → 011 → 012); do not downgrade the shared game constraint
by reapplying an older migration after Chess or Tetris has saved matches. Projects that
installed 010, 011 or 012 before those migrations revoked the game internals from
`authenticated` by name also need
`supabase/migrations/202610150013_lock_down_game_internals.sql` (privileges only) before
`verify-games.sql` will pass — see Troubleshooting the Duel button. The frontend build
does not apply migrations to your live project.

- **Tic Tac Toe:** a 3×3 board, alternating turns, all eight winning lines and draws.
  The starting partner is X. Moves and results are validated by the database.
- **Rock Paper Scissors:** best of 3 (first to 2 wins) or 5 (first to 3).
  Ties replay without adding a point. Tap once to lock a secret pick; both picks
  are revealed together when the second partner submits. Locked picks cannot change.
- **Snake Duel:** one run each, and the higher score wins. The two partners never need to
  be online at the same time: a duel waits for both runs whenever they are played, so it
  suits a couple in two time zones. A run starts the moment it is entered, lasts at most
  four minutes, and cannot be paused — there is no pause button and none is coming.
  Leaving the run is a forfeit and the partner takes the duel there and then, so the only
  score you can hand in is the one you played. A phone that goes quiet for more than
  **30 seconds** (locked, backgrounded, no signal) is treated as having left, and time in
  the background is not paused: the snake keeps travelling and will usually hit a wall
  before you get back. Reloading is the same — you get the 30 seconds to pick the run
  back up, from the tick the server last heard about.
- **Snake Duel · scorekeeping:** the score is not something the phone claims. The
  database deals the food, the phone reports only its direction changes and its tick
  count, and the database replays that history through the same rules as
  `src/lib/snake.ts` to derive the score, the length and the crash (`snake_replay`).
  Reports are append-only, cannot be rewound, and cannot outrun real time (one tick per
  160ms, plus two ticks of slack for the round trip), and each side may start exactly one
  run per duel — so a run cannot be re-rolled, sped up or handed in twice. The honest
  limits: the food sequence is sent to the phone, so a technical player who scripts a bot
  could still play a very good run at human speed; the duel is built to stop score
  forgery and re-rolls between two people who trust each other, not to police a
  tournament. Both `snake_replay` and `src/lib/snake.ts` hold the same constants and the
  same rules: **changing one without the other disqualifies honest runs**, and the
  database test compares the two scores precisely because that is the failure mode.
- **Snake Duel · secrecy:** it is a blind duel. While the duel is open, neither partner
  can see the other's score — a partner who is playing right now shows only as *playing
  right now*. Both scores are revealed together when both runs are in (`snake_view`
  strips the score from the snapshot until then, exactly as it strips rock-paper-scissors
  picks). A forfeit ends the duel immediately and reveals the score the leaver had
  reached.
- **Snake Duel · warm-up:** the same board, dealt on the phone itself, never reported and
  never scored. It is offered on the duel's gate, while waiting for the partner, and from
  the Snake Duel card in the library, so nobody's one attempt is their first attempt.
- **Snake Duel · leaving a tab:** a live ranked run guards the app's navigation. Changing
  tab asks first — over the board, which keeps moving, because there is no pause — and
  only changing the tab after *Leave and forfeit* gives the duel to the partner.
- **Snake Duel · not the daily challenge:** the daily pool stays Tic Tac Toe and Rock
  Paper Scissors (`start_game` never picks snake for a daily match). A duel waits however
  long both partners need, which one UTC day is the wrong container for.
- **Chess:** adapted clean-room from
  [PyChess](https://github.com/Kingcitaldo125/PyChess/tree/main/chess) — its 8×8 cell
  board, per-piece move generators, line-of-sight blocking and attack-based check test,
  re-implemented in `src/lib/chess.ts`. No PyChess code or PNG pieces are copied (it is
  GPL-3.0, and its bishop/queen movement, pawn blocking and checkmate test are broken or
  missing); the board here is a CSS grid of buttons with Unicode glyphs. The engine plays
  full normal chess — legal-move filtering (a pinned piece cannot expose its king),
  castling, en passant, promotion with a picker (underpromotion included), checkmate over
  all replies, stalemate, insufficient material, fifty-move and threefold draws — plus
  Nooki's situational layer, chosen by whoever starts the match: **Classic Duel**
  (checkmate wins), **Capture Race** (first to capture **7** enemy pieces wins the moment
  the seventh capture lands) and **Queen Hunt** (capture the opponent's *original* queen
  — a promoted queen does not count — to win on the spot). In every mode checkmate still
  wins and being checkmated still loses: goal moves are legal moves, so they can never
  leave your own king in check, and there is no move after you are mated for a goal to
  save you. Kings are never captured.
- **Chess · the referee is the database:** apply
  **`supabase/migrations/202610150011_chess.sql`** before shipping Chess
  (`verify-games.sql` checks it too). Like the Snake duel, the rules live on both sides:
  `chess_attacked` / `chess_pseudo` / `chess_legal` / `chess_has_move` in SQL mirror
  `src/lib/chess.ts`, and the only thing a phone may send is `chess_move` with a move in
  coordinate notation (`e2e4`, `e7e8q`, or `resign`) plus the match's round, checked
  exactly as `play_game` checks it. The server decides whose piece it is, whether the
  move is legal, what it captured, and whether checkmate, a draw, the Capture Race or
  the Queen Hunt ends the match — a phone can never claim a capture, or a queen, it did
  not really make. The starter is White (`player_x`); the position lives in the match's
  `chess` jsonb (64 piece codes — `wQ` the original queen, `wQ*` a promoted one —
  castling rights, the en-passant square, captures, history, repetition counts, which
  the snapshot strips). There are no secrets to seal, so the snapshot shows the whole
  position to both partners. One open chess match per couple, as with the other games;
  resigning is always allowed, on either turn. Chess is not in the daily pool. The
  design preview still plays pass-and-play on one phone, with undo, because it has no
  backend by design.
- **Tetris Duel:** five minutes each, and both partners play the same pieces — dealt once
  per duel, so the two runs are like for like no matter how far apart in time they happen.
  Neither partner needs to be online when the other plays. A run starts the moment it is
  entered and cannot be paused: leaving the run is a forfeit and the partner takes the duel
  there and then, and a phone that goes quiet for more than **30 seconds** (locked,
  backgrounded, no signal) is treated as having left. Time in the background is not paused
  either — the clock keeps running and the pieces keep falling, so a run that is left alone
  fills its own well. Reloading is the same: you get the 30 seconds to pick the run back up,
  from the tick the server last heard about. The well is 10×16 and the speed climbs with
  every ten lines you clear, from 0.75s a row to 0.15s at a hundred lines.
- **Tetris Duel · the two ways to settle it,** chosen when the duel is started and fixed for
  its lifetime:
  - **Sprint** — *highest score in five minutes*. Fill your well early and you bank whatever
    you had reached, which is usually not enough: the five minutes are the whole game.
  - **Survival** — *last one stacking wins*. Whoever keeps going for longer takes it, and
    the score only separates two runs that lasted exactly the same number of ticks. Sitting
    still is not a way to win this one: a well that is never cleared buries itself in about
    forty seconds, so you have to keep the board down to stay in it.
  A sprint and a survival can both be open at once; neither is the other's rematch.
- **Tetris Duel · the rules come from** [`KPaccarizi/_Tetris_Game`](https://github.com/KPaccarizi/_Tetris_Game),
  a Pygame coding-challenge entry: the same seven tetrominoes, the same spawn, the same
  rotation about a piece's first cell, and the same `{1:100, 2:300, 3:700, 4:1500}` for a
  clear. Its pygame loop is rewritten as a tick simulation so the database can replay it;
  three of its rough edges are deliberately **not** carried over, and `src/lib/tetris.ts`
  names all three (a row-clear that left a stale row behind, a game over that waited for
  the top row to fill, and a rotation that could wander off the top of the board).
- **Tetris Duel · scorekeeping:** exactly the Snake bargain. The database deals the pieces,
  the phone reports only its taps and its tick count, and the database replays that history
  through the same rules as `src/lib/tetris.ts` to derive the score, the lines and the
  top-out (`tetris_replay`). Reports are append-only, cannot be rewound, and cannot outrun
  real time (one tick per 50ms, plus six ticks of slack for the round trip), and each side
  may start exactly one run per duel — so a run cannot be re-rolled, sped up or handed in
  twice. Both `tetris_replay` and `src/lib/tetris.ts` hold the same constants and the same
  rules: **changing one without the other disqualifies honest runs**, and the database test
  compares the two scores precisely because that is the failure mode. As with Snake, the
  honest limit is that the piece sequence is sent to the phone, so a technical player who
  scripts a bot could still play a very good run at human speed: this stops score forgery
  and re-rolls between two people who trust each other, not a tournament.
- **Tetris Duel · secrecy and warm-up:** a blind duel, the same as Snake — the partner's
  score is sealed until both runs are in (`tetris_view` strips it from the snapshot), and a
  partner who is playing right now shows only as *playing right now*. A forfeit ends the
  duel immediately and reveals the score the leaver had reached. The same board, dealt on
  the phone itself, never reported and never scored, is offered on the gate, while waiting
  for the partner, and from the Tetris Duel card in the library.
- **Tetris Duel · controls:** a phone has no arrow keys, so the board is played with
  gestures and an on-screen pad: tap to turn the piece, slide sideways to move it, swipe
  down to slam it, or use the ◀ ▶ ▼ ⟳ ⤓ buttons under the well. The keyboard (arrows and
  space) works too. Where the piece would land is drawn as a shadow beneath it.
- **Tetris Duel · leaving a tab and the daily challenge:** a live ranked run guards the
  app's navigation, exactly as a Snake run does — changing tab asks first, over the board,
  which keeps running because there is no pause. Neither duel is ever the daily challenge
  (`start_game` never picks snake or tetris for a daily match): both wait however long the
  two partners need, which one UTC day is the wrong container for.
- **Games:** unlimited rematches; starting a game with an unfinished practice match
  resumes that match, including the original match length. A finished duel stays reachable
  from the library's *Last Duel* row — whichever of the two it was — so its result does
  not vanish.
- **Home → Today's Challenge:** randomly selects either available game on the first
  start and saves that choice for both partners. Exactly one shared match per couple
  per **UTC day**, enforced by a database unique constraint and serialized starts.
  Refreshing, switching devices or tapping again resumes the same match or its result;
  it never gives another attempt that day. RPS daily matches use best of 3.
- The Home scoreboard counts completed wins across daily and practice matches;
  draws do not award wins. Open matches survive tab changes and reloads.
- Both devices refresh game state every two seconds while visible. No secret picks
  are published through Realtime or exposed through direct table access. Only the
  RPC's sanitized snapshot is returned to the couple; other accounts cannot read it.
- To add another game, extend `GAMES` in `gamesService.ts`, its UI, and the database
  validator/daily selection pool together. No future game is selected until playable. A
  game with rules of its own (as Snake and Tetris have) wants its own RPCs plus its own row
  in the snapshot, the way `snake_*`/`tetris_*` and `games_state`'s `snake`/`tetris` keys
  do: never hand a phone the authority to score itself. A game that is played against the
  clock also wants a pure core next to `src/lib/snake.ts` and `src/lib/tetris.ts`, an SQL
  replay that mirrors it, and a test that holds the two scores against each other — that
  test is the only thing standing between a rule change and a week of disqualified runs.

Before release, use two real paired accounts to play each game, verify a secret pick
is absent from the other device's network responses, resume after a reload, finish a
daily match, and confirm both devices can only view its result until midnight UTC.
For either duel specifically: play both runs on two real phones (one of them in a
different time zone), leave a run halfway and confirm the partner is credited with the
win, lock one phone for longer than 30 seconds mid-run and confirm the run is lost,
reload mid-run and confirm the run resumes from the last report, and confirm the
partner's score is nowhere in the other phone's network responses until both runs are in.
For the Tetris Duel, play one sprint and one survival to completion and check the reveal
says what you expected, and confirm the two of you were dealt the same pieces.
The no-backend development preview remains sample UI, not a local game backend: the
preview's Snake and Tetris duels are played out on the page (there is a toggle above
them), and a ranked duel needs its migration.

### Troubleshooting the Duel button

The library button calls `start_game('snake', false, …)`; **Start my run** then calls
`snake_start`. The Tetris Duel is the same shape with its own entry point: the card calls
`start_tetris(mode)` and **Start my 5 minutes** calls `tetris_start` — a duel fixed to a
mode gets an RPC of its own, exactly as Chess does, so `start_game` is left alone for the
games that were already working. All of them depend on the live database, not just a
successful Vercel build. Migration `007` alone only accepts Tic Tac Toe and Rock Paper
Scissors, so it rejects Snake with `Invalid game settings.` even though the Games library
loads normally, and a Tetris card on a project without `012` reports `012` by name.

In the Supabase project used by the deployment:

1. Apply `supabase/migrations/202610150007_games.sql` if Games has not been installed.
2. Apply pending `supabase/migrations/202610150010_snake_duel.sql` **after** `007`,
   then `supabase/migrations/202610150011_chess.sql` for the Chess-enabled release, then
   `supabase/migrations/202610150012_tetris_duel.sql` for Tetris.
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

## Media tab: Read together (shared books)

The first Media feature: one book the couple reads together, EPUB first and PDF on the
same flow. Apply **`supabase/migrations/202610150008_shared_books.sql`** to an existing
project before shipping books, then run **`supabase/verify-books.sql`** in addition to
the usual `verify.sql`. New projects get books from `schema.sql`. The migration is
additive and rerunnable; it never touches a couple's existing data. It has not been
applied to your live project by the frontend build.

### The shelf, the reader and the loop

- **Upload** — a file picker on the Media tab takes a **DRM-free EPUB or PDF, up to
  40 MB**. The shelf row is created first (so a couple that already has an active book
  is told "Leave or delete current book first." before a single byte uploads), then the
  file goes up. The card shows the title, both people's percentages and **Continue
  reading**; a paused or finished book keeps its card with Continue, Upload new and
  Delete.
- **One active book per couple**, enforced by a unique index on `couple_id` where
  `status = 'reading'` — a second reading row cannot exist even if the app has a bug.
  Paused (`left`) and `finished` books stay on the shelf until deleted.
- **The reader** is full-screen over every tab: no chrome, tap the middle to show or
  hide the bars, tap the edges or swipe to turn pages. Each partner's place is saved on
  a debounce of a few seconds (never on every page turn) into `reading_progress`.
- **Jump to {partner}** reads the partner's row and lands there; their percentage on
  the bottom bar updates live through Realtime.
- **Highlight to chat** — select text, tap highlight, and the small box asks for an
  optional comment. That creates the `highlights` row AND sends a chat message carrying
  the quote and comment (`messages.highlight_id`). With no comment the message carries
  the quote itself.
- **Chat to book** — the message card quotes the passage ("from {title}"); tapping it
  opens the reader and jumps to the highlight's location. When the book has been
  deleted the card keeps the quote and says **"Book deleted — the quote stays"** with
  the jump disabled.
- **Both partners see each other's highlights** in the book, in two fixed colours — one
  per person (the smaller account id is rose, the other sage), so a passage always
  reads the same on both phones.
- **Leave / Finish / Delete** — Leave pauses (`left`) and the card offers Continue
  reading again; Finish keeps the book with a Finished badge (Keep / Delete / Upload
  new); Delete removes the file and the row. Deleting a book orphans its highlights on
  purpose: `book_id` goes NULL, so the quoted words survive in the chat and only the
  way back into the book goes away.

### Storage and privacy

Files live in the private **`shared-books`** bucket at
`books/{couple_id}/{book_id}.{epub|pdf}` — the folder name IS the couple id, which is
exactly what the storage policies check. Only the two partners can upload, read (via
one-hour signed URLs) or delete their own book's file; the bucket is never public and
nothing creates a shareable link. The bucket enforces a **40 MB** file-size cap, and
the phone caches the bytes after the first open (Cache API where available), so a
second open costs nothing on weak data.

### Know these before shipping

- **DRM-protected EPUBs (Kindle, most store-bought books) will not open.** The UI says
  "DRM-free EPUB or PDF only" wherever a file is picked; support cannot fix a locked
  file and the app never attempts to.
- **PDF highlighting is the weaker half.** It stores the page plus the selection's
  rectangles (fine at any zoom, but not a text anchor like an EPUB CFI), and a
  **scanned PDF has no selectable text** — the reader says so and simply does not offer
  highlighting there. Reading together and jumping still work.
- **Both partners download the whole file** before anything renders. Large PDFs are
  slow on weak data on the first open (the cache makes every later open instant).
- **Copyright**: users upload their own copy. A book is never readable outside the
  couple and never shareable by link. Do not add public sharing to this bucket.
- **Mobile browsers**: `epub.js` and `react-pdf` are the two engines (they load on
  demand, so the main bundle stays small). Both are widely used on mobile web, but
  verify text selection, page turns and the comment box on real iOS Safari and Android
  Chrome before release — selection behaviour is where mobile browsers differ.

Before release, use two real paired accounts to upload one EPUB and one PDF, read on
both devices at once, jump to each other, highlight with and without comments, jump
from a chat quote back into the passage, then Leave / Finish / Delete (checking the
chat quote after Delete). Upload a scanned PDF and confirm the no-selectable-text
note. Finally, check a third account cannot reach any of it in its network responses.
