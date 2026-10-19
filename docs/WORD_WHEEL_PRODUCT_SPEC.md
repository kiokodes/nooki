# Word Wheel — product and implementation spec

Status: **v1 built, deployed to the Nooki Supabase project, awaiting the two-device acceptance pass.**

Word Wheel is the third "duel" in Nooki's Games tab after Snake and Tetris, and the first one
built for two phones playing at the same moment rather than taking turns. Both partners get the
same seven letters and the same hidden words. They swipe for one to five minutes, submit what
they found, and the faster, fuller word list wins.

This document is the source of truth for what v1 is, what it deliberately is not, and how to
verify it. The code lives in:

| Area | File |
| --- | --- |
| Rules, scoring, formatting | `src/lib/wordWheel.ts` |
| Board and lobby UI | `src/components/games/WordWheel.tsx` |
| Styles | `src/components/games/games.css` (`.word-*`) |
| Games-tab integration | `src/components/games/GamesView.tsx` |
| Hook and badge logic | `src/hooks/useGames.ts` |
| Service/type mapping | `src/lib/gamesService.ts` |
| Schema, RPCs, sweep | `supabase/migrations/202610190001_word_wheel.sql` |
| Seed | `supabase/seed/word_puzzles.sql` and `.json` |
| Offline puzzle generator | `scripts/build-word-puzzles.mjs` |
| Curated base words | `scripts/word-puzzle-bases.json` |
| Optional service-role uploader | `scripts/upload-word-puzzles.mjs` |
| Tests | `tests/word-wheel-logic.test.mjs`, `word-wheel-database.test.mjs`, `word-wheel-ui.test.mjs` |
| Backend-free preview | `src/preview/PreviewWordWheel.tsx` (`/preview.html` → Games → Word Wheel) |

---

## 1. Product intent

A round should feel like the word-wheel puzzles people already know, with one twist: the person
you love is doing the same puzzle at the same time, and the result is a shared little scoreboard.

Promises the product makes:

1. **One puzzle, two phones.** The wheel and the hidden list are identical on both screens. No
   one can be dealt an easier board.
2. **A fair start.** Neither phone starts the clock by itself. The server writes one start
   timestamp and both countdowns use it, even if one phone opens late.
3. **Swipe first.** The primary input is a finger tracing letters. Typing exists as a fallback,
   not as the main game.
4. **Words are the score.** A found word fills a blank. Extra words are welcome as discoveries
   but never inflate the score.
5. **The result explains itself.** "Most words wins" is visible during play; the tie-break
   ("earlier last word") is visible before the round and in the result.
6. **Nothing to install, nothing to pair.** It uses the couple already signed in on each phone.

Non-goals for v1: live word-by-word spectating, a global leaderboard, public matchmaking,
puzzle authoring inside the app, and any form of turn timer.

---

## 2. The round, step by step

```
A opens Games → picks difficulty + clock → taps "Set the wheel"
        │
        ├─ creates word_rounds(status=waiting) and two word_round_results rows
        │
B opens Ongoing games → sees the wheel → both tap "I'm ready"
        │
        ├─ the SECOND ready sets status=running and start_at = now() + 8s
        │
both countdown from the same server timestamp
        │
each phone independently: swipe words, hints, shuffle, local clock
        │
each phone submits once: found words + elapsed ms of its last find
        │
        ├─ first submission: sealed; the partner only sees "submitted"
        ├─ both submissions: word_settle compares and writes winner_id
        │
result screen → "Play again" starts a new round with the same settings
```

The second player does not need to open the game at exactly the same second. The lobby waits up
to **30 minutes** for both ready taps; after that the sweep cancels it. Once `start_at` exists,
the round is live whether or not a phone is looking at it. Opening late means the clock is
already running, which the UI states explicitly.

### 2.1 Lobby and ready handshake

- The creator chooses **difficulty** and **duration**; those settings are frozen on the round.
- If the couple already has a `waiting` or `running` round, `start_word_round` returns that round
  instead of replacing the puzzle underneath the other phone. This is deliberate: no one gets
  ambushed by a different wheel after readying up.
- Either partner can tap ready. The second ready is the one that writes `start_at`.
- The shared lead is **8 seconds** (`WORD_START_LEAD_MS`). It is long enough for a poll cycle to
  deliver the timestamp and short enough to feel immediate.
- A lobby can be cancelled before it starts. A live round cannot.
- The old lobby becomes `cancelled`; a finished round stays as history.

### 2.2 The clock

- Each phone computes `serverNow = localNow + (server_now - localNowAtFetch)`.
- `remaining = start_at + duration - serverNow`.
- The display refreshes four times a second (`useNow(250)`) but the authoritative start and end
  are the server's.
- When the clock reaches zero the phone submits whatever it has. Leaving the board does not pause
  the clock, and the unmount path still saves a result if the clock had already expired.
- If a phone goes silent past its deadline, `word_sweep` waits a **45-second network grace
  window**, then fills a zero-word result for the missing player and settles the round. No round
  can hang forever.
- The last found word's elapsed time, not the clock's end, is the tie-break. A player who stops
  finding words early keeps that earlier timestamp. If they find nothing, the submission time is
  the duration/adjudicated time.

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
| `start_at` | timestamptz | set only on the second ready |
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
| `finished_ms` | int | elapsed at the last found word, clamped to the duration |
| `ready_at` | timestamptz | lobby handshake |
| `submitted_at` | timestamptz | writes are one-way; a retry never improves the score |
| `PRIMARY KEY` | `(round_id, user_id)` | exactly one row per player per round |

Rows are created for both players up front, so "ready" and "submitted" are booleans without
inventing sentinel values.

### 6.4 Access and privacy

- RLS is enabled on all three tables and privileges are revoked from `anon` and
  `authenticated`. The app only ever goes through security-definer functions.
- `word_view` is the single shape a phone sees. It includes the hidden words deliberately: the
  phone needs instant local feedback, and this is a couples game. The database still validates
  every submitted word, so knowing the list cannot fabricate a score beyond the list.
- The partner's result is **sealed** until the round is finished: before that the other phone
  only learns `ready` and `submitted`.
- The result screen reveals both word lists after settlement.

---

## 7. RPCs

| Function | Returns | Purpose |
| --- | --- | --- |
| `start_word_round(p_difficulty text, p_seconds int)` | `uuid` | Reuse the couple's open round, or pick a puzzle with a non-empty pack and create one. Locks the couple row. |
| `word_ready(p_id uuid)` | `jsonb` (round view) | Mark this player ready; the second ready writes `status=running` and `start_at=now()+8s`. |
| `word_submit(p_id uuid, p_words text[], p_finished_ms int)` | `jsonb` | Validate words against the round's list, store once, and settle if both are in. |
| `word_cancel(p_id uuid)` | `jsonb` | Cancel a waiting lobby only. |
| `word_view(round, uid)` | `jsonb` | Shared serializer, including `server_now`, sealed partner result and layout. |
| `word_settle(p_id uuid)` | `word_rounds` | Compare the two attempts and write the winner. |
| `word_sweep(couple uuid)` | `void` | Cancel stale lobbies, settle expired live rounds with zero-filled missing results. |
| `word_layout(words text[])` | `jsonb` | Length/count summary used by the round view. |
| `games_state()` | `jsonb` | Rewritten to include Word Wheel rounds in the same list as the other duels, so Ongoing games, the Games badge, Last duel and wins work without a second polling loop. |

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
may be null or empty. `p_finished_ms` is clamped to `[0, duration]`. A submission before
`start_at` is rejected. A second submission after `submitted_at` is stored is a no-op that
returns the existing view.

### 7.2 Trust model

The database trusts the phone's list of words and its reported elapsed time, because cheating a
romantic partner in a private two-person game has no payoff worth the engineering. What the
server does not trust is the *universe* of words: it never accepts a word outside the round's
frozen list. Scores are counted server-side, not sent as a number by the client.

---

## 8. Client architecture

### 8.1 `src/lib/wordWheel.ts`

Pure, React-free and network-free:

- `WORD_LEVELS`, `WORD_DURATIONS`, `WORD_HINTS = 2`, `WORD_START_LEAD_MS = 8000`;
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

1. **Lobby** (`waiting`) — wheel preview, both ready flags, rules, cancel/exit.
2. **Countdown** (`running`, `start_at` in the future) — big number, wheel preview.
3. **Board** (`running`, clock live) — HUD, blanks, tracing wheel, hints, shuffle, typing.
4. **Saved** (`running`, this phone submitted, partner not) — result summary + waiting copy.
5. **Result** (`finished`) — winner, both scores and last-word times, both word lists, rematch.
6. **Missing puzzle** — defensive error if a round view lost its payload.

The board merges locally found words with server words when a refresh arrives. It does not reset
on every poll: only a new `match.id` clears the board, so a background refresh cannot erase a
word found mid-swipe. Hints reveal letters only in the local blank rows; they are not persisted
and do not alter the submitted score.

### 8.4 Games-tab integration

- `GAMES` gains the `word-wheel` entry. The Games tab is a carousel (`GameLibrary`): every game
  is a chip in a horizontally scrolling rail, and only the chosen game's panel — description,
  settings and start button — is on the page. Word Wheel's panel carries the difficulty picker,
  the duration picker, and a button that calls `startWordRound(level, seconds)`.
- Word rounds ride in `games_state()['matches']` as `game: 'word-wheel'` with a `word` payload,
  so the existing Ongoing games swipe card, badge and Last duel row keep working.
- `needsMyMove` shows the badge when the player still has to ready up, or is in a live round
  they have not submitted.
- `lastDuelLine` shows word counts instead of hearts/distance.
- `useGames` exposes `startWordRound`, `readyWord`, `submitWord` (does not take the shared busy
  lock, like a duel heartbeat) and `cancelWord`.
- `submitWord` refreshes the snapshot after writing, so the partner's submission can settle the
  round on the next poll.

### 8.5 Motion and mobile layout

- Tiles animate position over 220 ms on shuffle; the line updates immediately.
- A wrong word shakes the wheel for 420 ms; `prefers-reduced-motion` disables the shake and the
  tile transitions.
- The wheel is capped at 330 px, the blanks region at 30 vh on short phones, and the board is
  usable one-handed with no hover reliance.
- Shuffle, hint, ready, check, rematch and exit are real `<button>`s. The wheel container is a
  `role="application"` region with a label explaining both swipe and typing; its tiles are
  hidden from the accessibility tree because they are not individually tabbable. The typed
  input is the keyboard path for every word.

---

## 9. Edge cases and expected behaviour

| Situation | Expected |
| --- | --- |
| Both players tap ready at nearly the same time | Row lock serialises them; exactly one `start_at` is written; both read the same timestamp. |
| Partner never readies | Lobby stays for 30 minutes, then the sweep cancels it. |
| Player opens the app after `start_at` | Board opens with the clock already partly gone; the countdown screen is skipped. |
| Player leaves mid-round | Clock keeps running. On return the same round is resumed. If the clock expired, unmount saves the local result. |
| Player submits but partner never does | After `start_at + duration + 45s`, sweep stores a zero-word result and settles. |
| Same word found twice | Second attempt shakes the wheel, says "Already found." and does not change the score. |
| Word is valid English but not on the list | "Not one of the hidden words." No blank fills, no score. |
| Word repeats a tile | Local path prevents it; a typed repeat is refused because it cannot be in the buildable list. |
| Wrong word | Path clears, wheel shakes, message appears for 2.2 s. |
| All words found | Phone submits immediately with the current elapsed time; the round ends for that player without waiting for the clock. |
| Both clear every word | Earlier last-word time wins; equal counts and equal times are a draw. |
| Same word count, different last-word times | Earlier last-word time wins, even if the slower player's clock ended earlier. |
| Different word counts | Count wins; the tie-break is never consulted. |
| Round is cancelled while both phones are open | Next refresh removes it from Ongoing; `word_ready`/`word_submit` return a clear error. |
| Puzzle bank is empty | `start_word_round` raises a readable "No Word Wheel puzzles are installed" error; the Games tab shows the setup hint. |
| A pack is missing for a combination | That puzzle is skipped at selection time; the round is never dealt short. |
| Phone clock is wrong | The server `start_at` and `server_now` offset correct it; only the elapsed render could jitter. |
| Rotation / resize | Tiles are positioned by percentage; hit testing reads the live bounding box on every pointer event. |
| Reduced motion | No shake, no tile transition, no progress transition. |

---

## 10. Verification and release checklist

Automated (all passing at the time of writing):

- `npx tsc -p tsconfig.app.json --noEmit` — clean.
- `npx oxlint` — 0 warnings, 0 errors on the Word Wheel files.
- `npm test` — 91/91. Three Word Wheel suites:
  - **logic**: buildability, normalization, grouping, hint selection, shuffle, clock/time
    formatting, tie-break;
  - **database** (PGlite): one shared wheel, both-ready start, filtered submissions, sealed
    partner, tie-break, full-clear, idempotent retry, sweep, one-open-round rule;
  - **UI** (JSDOM): library settings, lobby handshake, seven tiles, blanks, clock, correct/wrong
    words, hint spend, shuffle, result reveal, rematch, draw.
- `supabase/verify-games.sql` — PASS on the live project after the migration and seed.
- `npm run build` — compiles with production env vars (the sandbox has no live `.env.local`, so
  the build was checked with placeholder public keys).

Manual two-device acceptance (the only unticked item):

- [ ] Both phones in the same couple; A starts Easy / 1 minute.
- [ ] B sees the round in Ongoing games and readies; A readies second.
- [ ] Both countdowns land on zero together and show `1:00`.
- [ ] Both wheels show the same seven letters in the same order before any shuffle.
- [ ] Both blank rows show the same hidden words in the same order.
- [ ] A finds a word by swiping; the correct blank fills; B's board does not change.
- [ ] A traces a wrong word; the wheel shakes and no blank fills.
- [ ] A traces a letter twice; the second visit is ignored.
- [ ] A traces three letters then swipes back one; only two remain on the line.
- [ ] A taps Shuffle; the wheel reorders and the hidden words are unchanged.
- [ ] A spends a hint; a letter appears in one blank and the counter drops from 2 to 1.
- [ ] A finds every word; A's board immediately says the round is saved, without waiting for 1:00.
- [ ] B lets the clock expire; B's found words submit automatically.
- [ ] The result appears on both phones with the same winner and both word lists.
- [ ] A taps Play again; a fresh wheel appears in the lobby with the same settings.
- [ ] Put one phone in airplane mode during the lobby: the other phone cannot start alone; when
      the connection returns, both can ready and the clock still starts together.
- [ ] Force-close one phone mid-round and reopen after the deadline: the round settles and the
      absent player counts as zero (after the 45-second grace window).

---

## 11. Deployment

Order matters:

1. Apply `supabase/migrations/202610190001_word_wheel.sql` (or the consolidated `schema.sql` on
   a fresh project).
2. Run `supabase/seed/word_puzzles.sql` once. It upserts on `base_word`.
3. Run `supabase/verify.sql` and `supabase/verify-games.sql`; both should print PASS.
4. Deploy the app with the existing `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. No new
   environment variables are required.
5. Complete the two-device checklist above.

Rollback: the feature is additive. Removing the Games-tab code leaves the three tables and RPCs
harmless; dropping them requires dropping the `word_*` functions first, then the tables. Do not
drop the puzzle bank without backing up `word_puzzles` — regenerating without the original source
word list will not reproduce the exact packs.

---

## 12. Deliberate v1 exclusions and future extensions

**Excluded now**

- Live partner progress or a word-by-word race feed (the user asked for no live connection; only
  the final result is shared).
- Spectating, emoji reactions during a round, or chat integration.
- A free-play/warm-up mode (unlike Snake and Tetris).
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
