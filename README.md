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
   Then run `supabase/migrations/202610150002_couple_events.sql`, then
   `supabase/migrations/202610150003_messages.sql`, then
   `supabase/migrations/202610150004_discuss_questions.sql`, then
   `supabase/migrations/202610150005_discuss_comments_chat_links.sql`, then
   `supabase/migrations/202610150006_chat_replies_edits.sql`, the same way. All six are
   safe to rerun and change nothing that already exists: the second adds the shared
   calendar, the third adds the chat log, the fourth adds the Discuss question engine,
   the fifth rewrites reactions into comments and links chat messages to questions, and
   the sixth adds chat replies and edits (plus their Realtime publication membership).
3. Run `supabase/verify.sql` in the same SQL Editor. It is read-only and checks required
   functions, authenticated/anonymous pairing permissions, table permissions, RLS, the
   anniversary-lock trigger, the `couple_events` calendar, the realtime `messages` chat
   and the Discuss tables, reveal policy and question RPCs. It must return **PASS**; if it
   complains about `couple_events`, `messages` or `questions`, that migration step was
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
(including `couple_events`, `messages` and the five Discuss tables), RLS policies, pairing
and question RPCs, the anniversary and answer-reveal triggers, the Realtime publication
membership for the chat and Discuss tables, and the mutual-breakup RPCs; it does not
populate user/couple records, and it contains no questions — import those separately.

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

## Global header and Home tab

The global header sits above every tab and carries the couple's live status:

- **Initials** — `S & A`. Only the first letters are shown so no name length can crowd the
  layout; the full names sit in the element's accessible label and tooltip, and are used
  for personalisation elsewhere (e.g. the calendar's "Ana sees these dates too").
- **Presence ticker** — a small dot right beside the partner's name, green with a faint
  pulse while they are in the app and grey once they leave. Its tooltip/accessible label
  falls back to `Last seen 12m ago`, then a date after a week.
- **Partner's local time** — `5:14 PM Tue` in the partner's own timezone, with their
  weekday (so a different day is obvious). The reader's own clock is never shown.
- **Together counter** — a quiet `Together for 2Y 1M 4D` line under the names, from
  `anniversary_date`, measured on the viewer's own calendar day. The anniversary day
  itself reads `Happy anniversary — today is your day`, and a future date counts down.

The header owns its own one-second tick, so only the header re-renders as time passes.

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
- An **empty rounded area at the bottom of the screen**, reserved for a future animated
  scene.

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
- **Sending** — the composer is a growing multi-line box. **Enter starts a new
  paragraph**; only the send button sends, so a long message can be written properly on a
  phone. A sent message appears instantly, then its real row replaces it.
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

`npm run dev` serves a sample-data preview of the header, Home surface and Chat tab at
**http://localhost:5173/preview.html**. It uses static names ("Sam & Ana"), needs no
Supabase project, and lets you flip the partner between online and away, switch
anniversary examples, and open the real calendar modal with sample events where
add/edit/delete work in memory. The Chat tab is the real component over an in-memory
transcript, so you can send a message, watch one check turn into two, make Ana type, make
her reply, and see the unread badge — it reuses the real header and chat components so it
cannot drift from the app. It is a dev-server route only: `npm run build` still publishes
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

## Deploying this release — exact steps

### 1. Database (Supabase dashboard → SQL Editor)

Run **one** of these, depending on the project:

| Project state | Run this |
| --- | --- |
| Brand-new, empty project | `supabase/schema.sql` once, then `supabase/verify.sql` |
| Live project with real couples | `supabase/migrations/202610150001_pairing_flow.sql`, then `supabase/migrations/202610150002_couple_events.sql`, then `supabase/migrations/202610150003_messages.sql`, then `supabase/migrations/202610150004_discuss_questions.sql`, then `supabase/verify.sql` |

All four migrations are idempotent and safe to rerun; they never drop or rewrite existing
data (the pairing migration only changes policies, the calendar migration only adds a table
or converts an older one in place, the chat migration only adds a table, its policies and
its Realtime membership, and the Discuss migration only adds tables, functions, triggers
and policies). Take a snapshot first anyway.

`supabase/verify.sql` is read-only and must print **PASS**. It checks the pairing RPCs,
RLS on every table, the anniversary-lock trigger, the `couple_events` calendar, the repeat
column, the realtime `messages` chat (type check, policies, immutability trigger and
publication membership), the Discuss engine (its five tables, the policies that never
reveal a sealed answer, the canonicalised library, the three question RPCs, and that the
app cannot write to `questions`), and that `anon` cannot reach couple data. If it raises,
it names the file to rerun.

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

Set them for Production and any Preview environment you test, then **redeploy**: the values
are inlined at build time, so an existing deployment keeps the old ones. A preview pointing
at the production project uses real production data.

### 4. Verify before pushing

```sh
cp .env.example .env.local   # fill in the two values
npm ci
npm run check:env            # fails closed without valid public config
npm test                     # 17 tests, no live project contacted
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
npm test
npm run lint
npm run build
```

Tests run in isolated PostgreSQL (PGlite) and DOM environments. Test accounts exist only
inside those tests: no test contacts, inserts data into, or resets your live project.
Tests cover password visibility, email-confirmation handling, timezone selection,
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
with the button, Enter only making paragraphs, an incoming message appearing without a
reload, one check turning into two when the partner reads it, the typing indicator, the
unread badge counting and clearing, day grouping, auto-scroll, retry after a failed send,
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
empty library.

A successful build does **not** verify a deployed key, email delivery, an applied live
migration, or two-device connectivity. Complete the acceptance test below as well.

## Push and deploy

Work for this Arena session stays on `arena/a6d9925b-nooki`:

```sh
git status
git diff --check
git add .
git commit -m "Add the Discuss tab: sealed answers, a shared question library and the 18+ gate"
git push origin arena/a6d9925b-nooki
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
- [ ] Every tab's header shows both names with a live "Together for 2Y 1M 4D" counter.
- [ ] With both apps open, the header dot is green with a faint pulse; hovering/long-pressing it says the partner is online.
- [ ] Closing one app greys the dot within about a minute and its tooltip reads "Last seen ...".
- [ ] The header clock beside the dot matches the partner's own device time and weekday, and never shows your own clock.
- [ ] The Today card shows today's date and the anniversary/monthsary that fall today.
- [ ] The calendar icon opens the calendar over the Home tab; the tab is still there when you close it.
- [ ] Tapping a day adds, edits and deletes an event, and the other device sees the change after a refresh.
- [ ] Tapping the repeat chip on the event form cycles Once → week → month → year, and the saved event shows that wording.
- [ ] A weekly event reappears 7 days later, a monthly one on the same day next month, and a yearly one the following year.
- [ ] Swipe left/right and the ‹ › buttons move months; the picker jumps to any month and year.
- [ ] Chat opens with the partner's name, their live status and the phone/video buttons; both
      buttons show a "coming soon" toast.
- [ ] A message typed on device A appears on device B without a reload, on the correct side
      (your own on the right in pink, the partner's on the left in white).
- [ ] Enter starts a new paragraph instead of sending; the send button sends.
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
- [ ] After joining, anniversary edits and unilateral cancellation are rejected.
- [ ] A third account cannot join an already complete couple.
- [ ] Refreshing and signing out/in preserve the couple, anniversary and partner names.
- [ ] Check browser Network errors and Supabase Auth/Postgres logs if any step fails.

## Current feature scope

Signup, onboarding, pairing, the global header (couple names, live together counter,
presence ticker and the partner's local time), the Today card with the shared calendar,
the realtime **Chat tab** (message bubbles, day separators, sent/read receipts, typing
indicator, unread badge, multi-paragraph composer), the **Discuss tab** (a shared question
library read from the database, category and depth browsing, "Surprise me", four answer
input types, answers sealed until both partners reply — enforced by row-level security —
the side-by-side reveal, one comment each under the answers, the **Say more** bridge
into the chat (`messages.session_id` quoting the question and linking back to the
reveal), history and an
unanswered-question badge, and a both-partners 18+ gate), couple details, sign-out and
mutual-breakup settings are implemented. Media displays **Coming Soon**; Games includes Tic Tac Toe and Rock Paper Scissors, and
voice/video calling is still a "coming soon" toast. No sample conversations or questions
are loaded into the app itself — the in-memory transcript only exists on the development
preview page, and the question library is whatever the owner imported into `questions`.
Scenes and illustrated backgrounds are deliberately out of scope for now: the Discuss tab
uses the plain sage accent colour like every other surface.

## Design system

`src/tokens/designTokens.ts` contains the warm cream, blush pink, pastel mint, lavender
and sage palette, typography, radii and shadows. The app remains locked until both
partners are paired; ending a completed couple requires both partners' agreement.

## Games tab and Today's Challenge

Apply **`supabase/migrations/202610150007_games.sql`** to an existing project before
shipping Games, then run **`supabase/verify-games.sql`** in addition to the usual
`verify.sql`. New projects get Games from `schema.sql`. This migration is additive
and rerunnable; it does not reset existing matches. It has not been applied to your
live project by the frontend build.

- **Tic Tac Toe:** a 3×3 board, alternating turns, all eight winning lines and draws.
  The starting partner is X. Moves and results are validated by the database.
- **Rock Paper Scissors:** best of 3 (first to 2 wins) or 5 (first to 3).
  Ties replay without adding a point. Tap once to lock a secret pick; both picks
  are revealed together when the second partner submits. Locked picks cannot change.
- **Games:** unlimited rematches; starting a game with an unfinished practice match
  resumes that match, including the original match length.
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
  validator/daily selection pool together. No future game is selected until playable.

Before release, use two real paired accounts to play each game, verify a secret pick
is absent from the other device's network responses, resume after a reload, finish a
daily match, and confirm both devices can only view its result until midnight UTC.
The no-backend development preview remains sample UI, not a local game backend.
