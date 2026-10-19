# Word Wheel — product and implementation spec

Status: **asynchronous/practice update implemented in this branch; database migration pending deployment.**

Word Wheel offers solo practice at any time and an asynchronous challenge for a couple. Both
partners share the same seven letters and hidden words, but each starts their own one-, three-,
or five-minute timer whenever they are ready. They do not have to be online together. The
server compares the two sealed attempts when both are submitted or the challenge expires.

This document is the source of truth for the current product behavior and how to verify it. The
code lives in:

| Area | File |
| --- | --- |
| Rules, scoring, formatting | `src/lib/wordWheel.ts` |
| Local practice puzzle picker | `src/lib/wordWheelPractice.ts` (uses the bundled puzzle bank; no Supabase call) |
| Board and async-start UI | `src/components/games/WordWheel.tsx` |
| Styles | `src/components/games/games.css` (`.word-*`) |
| Games-tab integration | `src/components/games/GamesView.tsx` |
| Hook and badge logic | `src/hooks/useGames.ts` |
| Service/type mapping | `src/lib/gamesService.ts` |
| Schema, RPCs, sweep | `supabase/migrations/202610190001_word_wheel.sql`, then `202610190002_dash_duel_dodge_speed.sql` and `202610190003_word_wheel_async_practice.sql` |
| Seed | `supabase/seed/word_puzzles.sql` and `.json` |
| Offline puzzle generator | `scripts/build-word-puzzles.mjs` |
| Curated base words | `scripts/word-puzzle-bases.json` |
| Optional service-role uploader | `scripts/upload-word-puzzles.mjs` |
| Tests | `tests/word-wheel-logic.test.mjs`, `word-wheel-database.test.mjs`, `word-wheel-ui.test.mjs` |
| Backend-free preview | `src/preview/PreviewWordWheel.tsx` (`/preview.html` → Games → Word Wheel) — settings, local practice, and a sample async lobby |

---

## 1. Product intent

A round should feel like the word-wheel puzzles people already know, with two ways to play:
practice alone whenever you like, or share a puzzle with your partner and compare attempts later.

Promises the product makes:

1. **One puzzle, two phones.** An async challenge gives both partners the same wheel and hidden
   list. Neither player is dealt an easier board.
2. **Independent starts.** Each player's full clock begins when that player starts. The other
   partner can be offline, start later, and still gets the full selected duration.
3. **Practice anytime.** Solo practice uses the bundled puzzle bank locally; it never needs a
   partner or database round and never affects multiplayer scores or wins.
4. **Swipe first.** The primary input is a finger tracing letters. Typing exists as a fallback,
   not as the main game.
5. **Words are the score.** A found word fills a blank. Extra words are welcome as discoveries
   but never inflate the score.
6. **The result explains itself.** "Most words wins" is visible during play; the tie-break
   ("earlier last word") is visible before the round and in the result.
7. **Nothing to install, nothing to pair.** Multiplayer uses the couple already signed in on
   each phone; practice is local.

Non-goals: live word-by-word spectating, a global leaderboard, public matchmaking, puzzle
authoring inside the app, and any form of turn-based timer.

---

## 2. The round, step by step

```
Practice: choose difficulty + duration → deal a local puzzle → play solo → result is not saved

Async challenge:
A chooses difficulty + duration → "Challenge partner asynchronously"
        │
        ├─ creates one shared word_rounds puzzle and two result rows
        │
A taps "Start my 1-minute attempt" whenever ready → word_start writes A.started_at
        │
B opens Ongoing games whenever ready → sees the same puzzle → taps their own Start button
        │
        ├─ word_start writes B.started_at independently; A's clock is unaffected
        │
each phone: countdown from its own started_at → swipe words, hints, shuffle
        │
each phone submits once: found words + elapsed ms of its own last find
        │
        ├─ a submission stays sealed; the partner sees only started/submitted flags
        ├─ both submissions: word_settle compares count and each player's own elapsed time
        │
result screen → "Play again" creates the next async puzzle
```

The first player can start immediately; the other partner may be offline and can start later
with their **full selected duration**. There is no two-phone ready gate or shared countdown.
The challenge has a **7-day window** to begin an attempt. If nobody starts, the sweep cancels
it; if one player has started, a partner who still has not started by then is zero-filled. This
window never shortens an attempt that has already started: a silent attempt is zero-filled only
after its own deadline plus a **45-second network grace window**.

### 2.1 Async challenge and personal start

- The creator chooses **difficulty** and **duration**; those settings and the selected puzzle
  are frozen for both attempts.
- `start_word_round` reuses the couple's existing open challenge instead of replacing its
  puzzle. A completed/expired challenge does not block a rematch.
- Either partner can start first or wait. `word_start` writes only that caller's `started_at`;
  starting one phone never starts, pauses or shortens the other player's clock.
- The round status becomes `running` after the first attempt starts. The unstarted partner sees
  the puzzle and a button to begin their own full-length attempt.
- `word_rounds.start_at` is retained as a legacy/first-start field for v1 compatibility; new
  countdowns use `word_round_results.started_at` for the current player.
- A waiting challenge can be cancelled before anyone starts. A running challenge cannot be
  cancelled; it expires under the per-attempt and seven-day sweep rules.

### 2.2 The clock

- Each phone computes `serverNow = localNow + (server_now - localNowAtFetch)`.
- `remaining = mine.started_at + duration - serverNow`; the partner's clock uses their separate
  `started_at` and is never used to calculate mine.
- The display refreshes four times a second (`useNow(250)`); the authoritative personal start
  and deadline are server-recorded.
- When a player's clock reaches zero, that phone submits whatever it has. Leaving does not pause
  a multiplayer clock; the client saves on expiry and the server sweep fills a missing result
  after the deadline plus grace.
- The last found word's elapsed time from that player's own start, not wall-clock time or the
  partner's start time, is the tie-break. A player who stops finding words early keeps the earlier
  timestamp. If no word was found, the submission/adjudicated time is the duration.
- Practice uses the same board and timer locally. Leaving practice ends it; its score is not
  stored or included in couple wins.

### 2.3 Under a minute

The default is a **1-minute** round. The picker offers exactly **1, 3 and 5 minutes**, as
requested. There is no untimed mode.

---

## 3. The wheel and hidden words

### 3.1 Wheel

- **Seven letter tiles.** A 6-letter wheel cannot contain a genuine 7-letter grand prize, and the
  grand prize is a standing requirement, so the wheel uses all seven. Tiles may repeat when the
  base word repeats a letter (e.g. `cookies`).
- The wheel is a **circle, not a grid**: any tile can connect to any other tile.
- Tiles have a stable shuffled order per phone. `⇄ Shuffle` animates the same seven letters into
  a new order. It never changes the letters, the hidden list, the clock or the score.
- Letters are laid out from the top clockwise at a 36%-radius ring.

### 3.2 Hidden words

- Everything is **2–7 letters**, lowercase a–z, buildable from the wheel using each tile **at
  most once**.
- There is exactly **one 7-letter word**, the **grand prize**, and it is always in the round.
  It gets its own gold-tinted blank row above the rest.
- The rest are ordered into rows by length, shortest first.
- Packs are deliberately composed from a length mix, not just the longest words. Easy leans
  3–5 letters; Medium adds sixes; Hard adds the most five- and six-letter words. A 2-letter word
  appears at every difficulty when the base can make a common one.
- Words that cannot be built from the wheel are never shown or accepted. The generator only
  emits buildable words.

### 3.3 Extra words

Only the round's frozen `words` list counts. A valid English word that is not on the list, a
duplicate, or a word built from unavailable letters gets the same gentle refusal: the path
clears, the wheel shakes, and the line says "Not one of the hidden words." This keeps scoring
honest without pretending the player typed nonsense.

---

## 4. Difficulty and duration

Difficulty controls **how many words** and **how long they are**. Duration controls **how many
words** are dealt. The 2–7 mix and the grand prize are present at every combination.

| Difficulty | 1 minute | 3 minutes | 5 minutes | Length character |
| --- | ---: | ---: | ---: | --- |
| Easy | 7 | 10 | 13 | Mostly 3–4 letters, a 5, one 2 when available; no 6-letter words in the 1- and 3-minute packs (one 5-minute fallback pack can include one) |
| Medium | 9 | 13 | 17 | 3–6 letters, one or two 6-letter words, more 5s |
| Hard | 12 | 16 | 20 | The longest list; the most 5- and 6-letter words |

The generator aims for these counts and accepts a pack only if it can fill each difficulty and
duration while preserving the grand prize. Empty or too-short packs are **omitted** rather than
dealt short. The live bank currently has:

- 137 puzzles, one per curated base word;
- 1,176 non-empty packs out of 1,233 difficulty/duration slots;
- per-level pack availability: Easy 137/134/131, Medium 135/131/126, Hard 133/126/123 for
  60/180/300 seconds. Every emitted pack fills its quota exactly; the shortfall is in *how many
  bases* can support that longer, harder pack, not in the number of words a round is dealt.

`start_word_round` filters on `packs -> difficulty ? seconds` and a non-empty array, so a missing
pack can never produce an empty round.

---

## 5. Puzzle generation and curation

Puzzles are **pre-generated and stored**, never produced at runtime. `npm run build:word-puzzles`
does the following, offline and deterministically enough to review:

1. Read the hand-curated 7-letter base words in `scripts/word-puzzle-bases.json`. Bases are
   common, concrete, couple-friendly nouns/adjectives with a good spread of sub-words.
2. Enumerate every 2–7-letter word in the source word list that can be built from the seven
   letters, using each letter at most once.
3. Filter by frequency and familiarity. The pipeline uses a SUBTLEX-style frequency list plus a
   small allowlist for very common 2-letter words that frequency data under-ranks (`at`, `in`,
   `on`, `to`, `it`, `is`, `be`, `we`, `he`, `me`, `my`, `so`, `up`, `us`, `go`, `no`, `am`,
   `an`, `as`, `by`, `do`, `if`, `or`, `of`).
4. Remove a profanity/medical/name blocklist. Curation is conservative: obscure Scrabble words,
   slurs, body parts and proper nouns do not reach the bank. The remaining list is reviewed by
   hand before upload.
5. Compose the nine packs per base (difficulty × duration) by length quota, always including the
   base word as the sole 7-letter grand prize, then the requested count of shorter words.
6. Emit `supabase/seed/word_puzzles.json` and `supabase/seed/word_puzzles.sql`. The SQL upserts
   on `base_word`, so re-running is idempotent and refreshes packs in place.

The generator is a development tool, not a server dependency. The app never ships the source
word list and never generates a puzzle on a phone.

### 5.1 Adding puzzles

1. Add a 7-letter base to `scripts/word-puzzle-bases.json`.
2. Run `npm run build:word-puzzles`.
3. Skim the emitted words for anything rude, obscure or not really English. Edit the blocklist or
   the base list rather than shipping a bad word.
4. Apply `supabase/seed/word_puzzles.sql` in the SQL editor, or set `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` and run `npm run upload:word-puzzles`.
5. Re-run `supabase/verify-games.sql`.

The bank is small on purpose. A couple sees a repeat only after many rounds, and
`start_word_round` deprioritises puzzles used by this couple in the last 60 days. 137 puzzles is
enough for months of occasional play and keeps every word reviewable.

---

## 6. Data model

### 6.1 `word_puzzles`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `letters` | text | Exactly 7 a–z, sorted for stable display |
| `base_word` | text | The 7-letter grand prize; unique |
| `words` | text[] | Union of every word used by the packs |
| `packs` | jsonb | `{ "<level>": { "<seconds>": string[] } }` |
| `created_at` | timestamptz | |

Example pack shape:

```json
{
  "easy":   { "60": ["picture", "cut", "it", "tie", "true", "cute", "up"], "...": [] },
  "medium": { "60": ["picture", "cutie", "price", "true", "cute", "tie", "cut", "it", "up"], "...": [] },
  "hard":   { "60": ["picture", "cutie", "price", "truce", "cure", "cute", "pure", "trip", "true", "cut", "ice", "it"], "...": [] }
}
```

### 6.2 `word_rounds`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | uuid PK | |
| `couple_id` | uuid | cascade on couple delete |
| `puzzle_id` | uuid | restrict; puzzle bank is not deleted casually |
| `difficulty` | text | `easy` / `medium` / `hard` |
| `duration_seconds` | int | 60 / 180 / 300 |
| `letters` | text | copied from the puzzle |
| `grand_word` | text | copied from the puzzle |
| `words` | text[] | the exact hidden list, 2–24 words, frozen at creation |
| `created_by` | uuid | |
| `player_x` / `player_o` | uuid | the couple, distinct |
| `status` | text | `waiting` / `running` / `finished` / `cancelled` |
| `start_at` | timestamptz | legacy/history field; set to the first multiplayer attempt start and not used for current clocks |
| `finished_at`, `winner_id` | | set by settle |

Constraints:

- `word_rounds_players_distinct`;
- `word_rounds_started_has_time` (a running round must have `start_at`);
- partial unique index `word_one_open_round` on `couple_id` where status is `waiting` or
  `running`. Finished rounds never block a rematch.

### 6.3 `word_round_results`

| Column | Type | Notes |
| --- | --- | --- |
| `round_id` | uuid | PK part |
| `user_id` | uuid | PK part |
| `words_found` | text[] | validated, deduplicated |
| `started_at` | timestamptz | this player's independent server start; null until they begin |
| `finished_ms` | int | elapsed from this player's start at the last found word, clamped to the duration |
| `ready_at` | timestamptz | v1 compatibility only; the v2 UI does not use a ready handshake |
| `submitted_at` | timestamptz | writes are one-way; a retry never improves the score |
| `PRIMARY KEY` | `(round_id, user_id)` | exactly one row per player per round |

Rows are created for both players up front, so per-player start and submission state can be
reported independently without inventing sentinel values.

### 6.4 Access and privacy

- RLS is enabled on all three tables and privileges are revoked from `anon` and
  `authenticated`. The app only ever goes through security-definer functions.
- `word_view` is the single shape a phone sees. It includes the hidden words deliberately: the
  phone needs instant local feedback, and this is a couples game. The database still validates
  every submitted word, so knowing the list cannot fabricate a score beyond the list.
- The partner's result is **sealed** until the round is finished: before that the other phone
  learns only whether they have started or submitted, never their words, count or elapsed time.
- The result screen reveals both word lists after settlement.

---

## 7. RPCs

| Function | Returns | Purpose |
| --- | --- | --- |
| `start_word_round(p_difficulty text, p_seconds int)` | `uuid` | Reuse the couple's open async challenge, or pick a puzzle with a non-empty pack and create one. Locks the couple row. |
| `word_start(p_id uuid)` | `jsonb` (round view) | Start only the caller's clock; set their `started_at` and mark the round running. |
| `word_ready(p_id uuid)` | `jsonb` (round view) | Compatibility alias to `word_start`; no shared ready gate. |
| `word_submit(p_id uuid, p_words text[], p_finished_ms int)` | `jsonb` | Validate words against the round's list, store against the caller's start time, and settle if both attempts are in. |
| `word_cancel(p_id uuid)` | `jsonb` | Cancel a waiting challenge before anyone has started. |
| `word_view(round, uid)` | `jsonb` | Shared serializer, including `server_now`, sealed partner result and layout. |
| `word_settle(p_id uuid)` | `word_rounds` | Compare the two attempts and write the winner. |
| `word_sweep(couple uuid)` | `void` | Cancel a challenge after seven days if nobody starts; zero-fill a started attempt after its own deadline + 45s and an unstarted attempt after the seven-day window. |
| `word_layout(words text[])` | `jsonb` | Length/count summary used by the round view. |
| `games_state()` | `jsonb` | Rewritten to include Word Wheel rounds in the same list as the other duels, so Ongoing games, the Games badge and wins work without a second polling loop. |

`word_settle` compares, in order:

1. higher `cardinality(words_found)`;
2. lower `finished_ms` (a null/missing attempt is treated as the duration);
3. otherwise `winner_id = null` (a draw).

### 7.1 Validation rules on submit

`word_submit` keeps a word only when all of these hold:

- it is in `word_rounds.words`;
- it lowercases to 2–7 a–z letters;
- it is distinct.

Everything else is dropped silently; the phone has already shown the local refusal. `p_words`
may be null or empty. `p_finished_ms` is clamped to `[0, duration]`. A submission is rejected
until that user has a server-recorded `started_at`. A second submission after `submitted_at` is
stored is a no-op that returns the existing view.

### 7.2 Trust model

The database trusts the phone's list of words and its reported elapsed time, because cheating a
romantic partner in a private two-person game has no payoff worth the engineering. What the
server does not trust is the *universe* of words: it never accepts a word outside the round's
frozen list. Scores are counted server-side, not sent as a number by the client.

---

## 8. Client architecture

### 8.1 `src/lib/wordWheel.ts`

Pure, React-free and network-free:

- `WORD_LEVELS`, `WORD_DURATIONS`, `WORD_HINTS = 2`;
- `normalizeWord`, `canBuildWord`;
- `wordGroups(words, grandWord)` — grand prize first, then rows by length;
- `nextHintIndex`, `chooseHint`;
- `compareWordAttempts` → `'mine' | 'partner' | 'draw'`;
- `formatWordClock`, `formatWordTime`;
- `shuffleLetters`.

### 8.2 Pointer input state machine

The wheel container owns pointer capture. On `pointerdown` it finds the nearest tile within a
**hit radius of 8.5% of the wheel width**, while tiles themselves are 19.5% wide. The tap target
is therefore smaller than the visible circle: a finger between letters is ignored rather than
snapping to a neighbour. `pointermove` adds the nearest new tile; `pointerup` evaluates the path;
`pointercancel` clears it.

Rules implemented in `pick`:

- no tile can be used twice in one attempt;
- moving back onto the previous tile removes the last letter (the one-tap undo);
- moving back two positions truncates to that position;
- moving onto any other already-used tile is ignored;
- a path shorter than 2 letters is discarded without feedback;
- `touch-action: none` and `user-select: none` prevent scrolling and text selection while
  tracing;
- the SVG polyline is drawn from tile centres with round caps, and small dots mark each chosen
  centre;
- the same component accepts typed words via `#word-type-input` and a "Check" button for
  desktop/keyboard play;
- `Shuffle` only permutes `order`; the hidden list is untouched.

### 8.3 Component states

`WordWheel.tsx` renders one of:

1. **Start lobby** (`waiting`, or `running` before this player starts) — wheel preview, both
   independent start/submission flags, rules, cancel only before anyone starts, and this player's
   Start button.
2. **Countdown** (`running`, this player's `started_at` in the future) — big number and wheel.
3. **Board** (`running`, this player's clock live) — HUD, blanks, tracing wheel, hints, shuffle,
   typing.
4. **Saved** (this phone submitted, partner has not) — result summary + waiting copy.
5. **Result** (`finished`) — winner, both scores and each player's own elapsed last-word time,
   both word lists, rematch.
6. **Practice result** — local summary with replay, never written to the server.
7. **Missing puzzle** — defensive error if a round view lost its payload.

The board merges locally found words with server words when a refresh arrives. It does not reset
on every poll: only a new `match.id` clears the board, so a background refresh cannot erase a
word found mid-swipe. Hints reveal letters only in the local blank rows; they are not persisted
and do not alter the submitted score.

### 8.4 Games-tab integration

- `GAMES` gains the `word-wheel` entry. The library offers **Practice solo** and
  **Challenge partner asynchronously** using the selected difficulty and duration.
- Practice chooses an eligible row from the bundled puzzle bank and runs entirely in local
  component state. It does not create a match, call a Word Wheel RPC, or count as a couple win.
- Multiplayer rounds ride in `games_state()['matches']` as `game: 'word-wheel'` with a `word`
  payload, so the existing Ongoing games swipe card and badge keep working.
- `needsMyMove` shows the badge when the player has not started their own attempt, or has a live
  attempt they have not submitted.
- `lastDuelLine` shows word counts instead of hearts/distance.
- `useGames` exposes `startWordRound`, `startWordAttempt` (`readyWord` remains as a compatibility
  alias), `submitWord` (does not take the shared busy lock, like a duel heartbeat) and `cancelWord`.
- `submitWord` refreshes the snapshot after writing, so the partner's submission can settle the
  round on the next poll.

### 8.5 The library tab is settings, never a running clock

Selecting the Word Wheel chip in the Games rail shows difficulty, duration, **Practice solo**
and **Challenge partner asynchronously**. Practice loads a bundled puzzle and starts locally;
multiplayer creates/reuses a shared challenge but starts no clock until the player opens it and
taps their own Start button. The preview follows the same two paths. Entering the library or
opening an existing challenge never consumes any of the player's selected time.

### 8.6 Motion and mobile layout

- Tiles animate position over 220 ms on shuffle; the line updates immediately.
- A wrong word shakes the wheel for 420 ms; `prefers-reduced-motion` disables the shake and the
  tile transitions.
- The wheel is capped at 330 px, the blanks region at 30 vh on short phones, and the board is
  usable one-handed with no hover reliance.
- Shuffle, hint, per-player start, check, rematch and exit are real `<button>`s. The wheel container is a
  `role="application"` region with a label explaining both swipe and typing; its tiles are
  hidden from the accessibility tree because they are not individually tabbable. The typed
  input is the keyboard path for every word.

---

## 9. Edge cases and expected behaviour

| Situation | Expected |
| --- | --- |
| One player starts an attempt | Only that player's `started_at` is written; the partner remains unstarted. |
| Partner starts later or is offline | The late player gets the full chosen duration; the first player's clock is unchanged. |
| Nobody starts the challenge | It is cancelled after seven days. |
| A player opens after starting on another device | Their board resumes from their own server timestamp; no time is reset. |
| Player leaves mid-attempt | Clock keeps running. On return the same attempt resumes; expiry saves locally or is swept. |
| Player submits but partner never starts | At seven days the never-started side is zero-filled and the result settles. |
| Player submits but partner started and never submits | At that player's own `started_at + duration + 45s`, sweep zero-fills and settles. |
| Solo practice | Puzzle and score remain local; no multiplayer match or win is created. |
| Same word found twice | Second attempt shakes the wheel, says "Already found." and does not change the score. |
| Word is valid English but not on the list | "Not one of the hidden words." No blank fills, no score. |
| Word repeats a tile | Local path prevents it; a typed repeat is refused because it cannot be in the buildable list. |
| Wrong word | Path clears, wheel shakes, message appears for 2.2 s. |
| All words found | Phone submits immediately with elapsed time from its own start; the partner's attempt continues. |
| Both clear every word | Earlier per-player last-word elapsed time wins; equal counts and times are a draw. |
| Different word counts | Count wins; the tie-break is never consulted. |
| Challenge is cancelled while phones are open | Next refresh removes it from Ongoing; `word_start`/`word_submit` return a clear error. |
| Puzzle bank is empty | `start_word_round` raises a readable "No Word Wheel puzzles are installed" error; the Games tab shows the setup hint. |
| A pack is missing for a combination | That puzzle is skipped at selection time; the round is never dealt short. |
| Phone clock is wrong | Server `started_at` and `server_now` offset correct it; only the elapsed render could jitter. |
| Rotation / resize | Tiles are positioned by percentage; hit testing reads the live bounding box on every pointer event. |
| Reduced motion | No shake, no tile transition, no progress transition. |

---

## 10. Verification and release checklist

Automated checks to run for this branch:

- TypeScript check and production build, including the dynamically bundled practice puzzle bank.
- Word Wheel logic tests for buildability, hints, shuffle, clock formatting and tie-break.
- PGlite database tests for independent starts, delayed full-duration starts, sealed partner
  scores, personal elapsed-time tie-breaks, unstarted expiry, per-player deadline sweeps and
  idempotent submissions.
- JSDOM tests for the local-practice path and asynchronous start lobby/board/result states.
- Migration-chain tests must apply `202610190003_word_wheel_async_practice.sql` after the earlier
  Games migrations. `supabase/verify-games.sql` is for a deployment only after that migration
  and the puzzle seed have been applied; do not apply it remotely as part of local verification.

Manual two-device acceptance:

- [ ] Solo practice is available from the library with no partner online; start, finish and
      replay a local run. Confirm it creates no ongoing match and no multiplayer win.
- [ ] A and B are paired. A creates Easy / 1 minute and starts their own attempt.
- [ ] B sees the same puzzle in Ongoing games while still unstarted; no shared-ready gate appears.
- [ ] Wait about 20 seconds, then B starts. B sees a fresh `1:00`; A has about `0:40` remaining.
- [ ] Both wheels show the same seven letters and hidden words, even though their clocks differ.
- [ ] A finds a word by swiping; the correct blank fills; B's board does not change.
- [ ] A traces a wrong word; the wheel shakes and no blank fills.
- [ ] A traces a letter twice; the second visit is ignored.
- [ ] A traces three letters then swipes back one; only two remain on the line.
- [ ] A taps Shuffle; the wheel reorders and the hidden words are unchanged.
- [ ] A spends a hint; a letter appears in one blank and the counter drops from 2 to 1.
- [ ] A's clock expires and saves A's attempt while B keeps playing.
- [ ] B's clock also expires; the result appears on both phones with the same winner and both lists.
- [ ] A taps Play again; a fresh async challenge is created with the same settings.
- [ ] Force-close B after their own deadline; sweep zero-fills only B after the 45-second grace.
- [ ] Force a challenge with no starts to be older than seven days in test data; sweep cancels it.

---

## 11. Deployment

Order matters:

1. On an existing project, apply `202610190001_word_wheel.sql`, the other intervening migrations
   in order, then `202610190003_word_wheel_async_practice.sql`. Fresh projects use consolidated
   `supabase/schema.sql`.
2. Run `supabase/seed/word_puzzles.sql` once. It upserts on `base_word` and supports local practice.
3. Run `supabase/verify.sql` and `supabase/verify-games.sql`; both should print PASS after the
   migration and seed are applied.
4. Deploy the app with the existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. No new
   environment variables are required.
5. Complete the two-device checklist above.

Rollback: the feature is additive. Removing the Games-tab code leaves the three tables and RPCs
harmless; dropping them requires dropping the `word_*` functions first, then the tables. Do not
drop the puzzle bank without backing up `word_puzzles` — regenerating without the original source
word list will not reproduce the exact packs.

---

## 12. Deliberate exclusions and future extensions

**Excluded now**

- Live partner progress or a word-by-word race feed (the user asked for no live connection; only
  the final result is shared).
- Spectating, emoji reactions during a round, or chat integration.
- Persistence or public ranking for solo practice; practice is intentionally unranked and local.
- Server-side hint budgets. Hints are local and limited to 2; a determined player could reload.
- A 6-letter wheel. It cannot coexist with a true 7-letter grand prize.
- Runtime puzzle generation, puzzle authoring, or per-couple custom words.
- Global rankings, streaks, or rewards. Wins are counted in the existing couple wins map.

**Natural next steps**

1. Realtime progress (`word_round_results` row updates) once both phones are reliably subscribed.
2. A rematch on the *same* puzzle, with a fresh hidden subset, for a fair grudge match.
3. More puzzle bases, especially couple/relationship vocabulary, with the same curation gate.
4. Difficulty discovered from the player's history rather than chosen.
5. A daily shared Word Wheel with one puzzle for every couple.
