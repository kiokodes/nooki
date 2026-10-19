# Word Wheel — Product & Implementation Specification

**Status:** Implemented; database migrated and puzzle bank seeded; two-device release validation pending
**Product owner:** Nooki
**Target:** A simultaneous two-phone word hunt for a paired couple, with pregenerated puzzles and a server-timed round
**Out of scope for this document:** voice chat, live word-by-word score streaming, tournament ladders, monetization, sound/music, matchmaking outside an existing couple

Word Wheel lives in Nooki's paired-couple Games area beside the other duels. It is not a
local word game with a score-sharing screen: both partners receive the same seven letters
and the same hidden-word list, both clocks count down from one server timestamp, and the
database decides the winner from the words each phone actually submitted.

---

## 1. Product intent

A couple should be able to open Games, pick a difficulty and a 1, 3 or 5 minute round, and
be playing within seconds of their partner accepting. The loop is deliberately physical:
swipe a line through the wheel, build a word, watch blanks fill. The seven-letter word is
the trophy of every round; the short words keep the loop moving.

### Product promises

- **One shared puzzle:** both phones see the same seven letters and exactly the same hidden
  words. There is no per-player deal.
- **A real race, not an async score comparison:** both partners ready up; the server sets a
  single `start_at` a few seconds ahead; each phone runs its own countdown from that
  timestamp.
- **Most words wins:** the count is primary. A tie goes to the player whose **last found
  word** came earlier. Clearing every word ends that player's round immediately, and that
  moment becomes their tie-break time.
- **Fair by construction:** the hidden list is selected on the server when the round starts;
  submitted words are filtered against it. A phone can submit any list it likes and still
  only be credited for the round's actual words.
- **Word quality first:** a real word rejected as "not hidden" is a worse experience than a
  blank that stays empty. The puzzle bank is generated offline, frequency-gated, manually
  reviewable, and blocked from rude or medical vocabulary.
- **Nothing is generated live:** a round deals one prebuilt pack. There is no dictionary in
  the browser and no random word generation at play time.
- **Short commitment:** a 60-second round is the default social unit. Longer rounds ask for
  more words rather than simply stretching the same list.

## 2. Version-one gameplay decisions

| Topic | Decision |
|---|---|
| Wheel | Exactly seven letter tiles (a–z). The letters may repeat because the base word may repeat a letter. The wheel is a circle, not a grid: any tile can connect to any other tile. |
| Hidden words | 2–7 letters. Every hidden word can be built from the wheel using each tile at most once. Exactly one 7-letter word is the **grand prize** and is always present. |
| Input | Swipe with a pointer across the wheel. The line is drawn as an SVG polyline over the tiles. Each tile may be used once per word. The hit area is smaller than the visible tile (8.5% of the wheel's width) so a swipe does not grab a neighbour accidentally. |
| Swipe back | Moving back onto the previous tile removes it from the path. Moving back over several tiles, or onto a tile already in the path, is ignored rather than corrupting the word. |
| Release | Lifting the pointer checks the word. A correct hidden word fills its blank and clears the path. A wrong word, a repeated word, or a word outside the hidden list shakes the wheel and clears the path without consuming a blank. |
| Keyboard input | A "Type a word" field and **Check** button mirror the swipe for desktop, accessibility and precision. The same validation path is used. |
| Extra words | A real English word that is not in this round's hidden list does **not** count and does not fill a blank. The feedback is "Not one of the hidden words." Packs are generated from the most common buildable words, so this should be rare rather than punitive. |
| Shuffle | **⇄ Shuffle** reorders the seven tiles around the wheel. It does not change the puzzle, the hidden words, the clock or the found words. The client may shuffle as often as it likes while the round is live. |
| Hints | Two per round, tracked locally per phone. Each hint reveals one letter of a random unfound word in its blank row. Hints are a convenience, not a scored resource; trust is appropriate for a couples game. |
| Clock | Player-selectable 1, 3 or 5 minutes. The phone never owns the deadline: it computes `start_at + duration_seconds` from the server snapshot. Leaving the screen does not pause the clock. |
| Countdown | When both partners ready up, `word_ready` sets `start_at = now() + 8 seconds`. Both phones show the same countdown. A partner who opens late still sees the correct remaining time because the deadline is absolute. |
| Difficulty | Easy, Medium, Hard. Difficulty controls **how many words** are asked for and **how long the words are**; the 2–7 mix and the seven-letter grand prize are present at every level. |
| Duration | 1, 3 or 5 minutes. Longer rounds ask for more words. See §3 for the exact matrix. |
| Result | Most words found wins. If the counts are equal, the earlier `finished_ms` (the time of the player's last found word, or the end of their round) wins. Equal count and equal time is a draw. |
| Submission | A phone submits once when the clock reaches zero, or immediately when it clears the last word. A second submission is idempotent and cannot change the score. The last word's elapsed time is sent explicitly so waiting for the clock does not erase a fast finish. |
| Partner visibility | While the round is live, the phone learns only whether the partner is ready, submitted, and (after settlement) their words and time. The partner's count stays sealed until the round is finished. |
| Rematch | **Play again →** starts a new round with the same difficulty and duration. The prior round remains as history. A couple can have only one waiting/running Word Wheel round at a time. |
| Abandonment | A lobby nobody accepts is cancelled after 30 minutes. A live round whose deadline has passed by a 45-second network grace window is settled by `word_sweep`: a phone that never submitted counts as zero words and the full duration. |
| Art | Existing Nooki pink/green styling, authored CSS and inline SVG. No remote runtime assets. The wheel should read clearly at phone width and respect reduced-motion for the shake. |
| Sound / haptics | None in v1; no sound dependency. Haptic feedback may be added later as an enhancement. |

## 3. Difficulty and duration matrix

The generator stores one complete hidden list per difficulty × duration on every puzzle
row. Counts include the seven-letter grand prize.

| Level | 1 minute | 3 minutes | 5 minutes | Length mix |
|---|---:|---:|---:|---|
| Easy | 7 words | 10 words | 13 words | Mostly 3–5 letters; one 2-letter word when available; no 6-letter words. |
| Medium | 9 words | 13 words | 17 words | 2–6 letters; one or two 6-letter words; more 5-letter words than Easy. |
| Hard | 12 words | 16 words | 20 words | 2–6 letters; the longest list and the most 5- and 6-letter words. |

Every pack contains the seven-letter base word. The generator starts from a length quota per
pack and, if a base cannot supply a length, redistributes the missing slots toward the
difficulty's preferred neighbouring lengths (Easy toward shorter words, Hard toward longer
ones). If it still cannot fill the pack exactly, that pack is omitted rather than dealing a
short or impossible round. The server only ever selects a puzzle with a non-empty pack for
the requested difficulty and duration.

Generation produced **137 puzzles** and **1,176 playable packs**:

| Level | 60 s | 180 s | 300 s |
|---|---:|---:|---:|
| Easy | 137 | 134 | 131 |
| Medium | 135 | 131 | 126 |
| Hard | 133 | 126 | 123 |

## 4. Puzzle bank and word quality

### 4.1 Curation pipeline

`scripts/build-word-puzzles.mjs` is a one-time/offline generator. It is not imported by the
app and never runs in the browser.

1. Read the hand-curated seven-letter bases in `scripts/word-puzzle-bases.json`.
2. Keep a base only if it is in the English dictionary and matches `^[a-z]{7}$`.
3. Enumerate every dictionary word of 2–7 letters that can be built from those letters with
   each letter used at most once.
4. Frequency-gate the candidates using SUBTLEX ranks. Two-letter words are restricted to a
   short allowlist (`am`, `an`, `as`, `at`, `be`, `by`, `do`, `go`, `he`, `if`, `in`, `is`,
   `it`, `me`, `my`, `no`, `of`, `on`, `or`, `so`, `to`, `up`, `us`, `we`).
5. Remove blocked words: profanity, slurs, sexual/medical terms, violence, death and a
   broad list of names. Word quality is treated as a safety and tone problem, not only a
   difficulty problem.
6. Sort each length by commonness, then alphabetically for stable reruns.
7. Fill the nine packs per base from the quotas in §3, always starting with the base word.
8. Emit `supabase/seed/word_puzzles.sql` and `supabase/seed/word_puzzles.json`.

A base that cannot fill any pack is skipped and logged. Regenerating is deterministic apart
from deliberate base-list edits, so the seed can be reviewed as a diff.

### 4.2 Stored shape

Each `word_puzzles` row stores:

- `letters` — the seven letters, sorted for a stable display (e.g. `ceiprtu`).
- `base_word` — the seven-letter grand prize (e.g. `picture`). Unique, so uploads upsert.
- `words` — the union of every word used by any pack. Kept as a simple vocabulary record
  and a search aid; a round only ever deals a pack.
- `packs` — `{"easy":{"60":[…],"180":[…],"300":[…]}, "medium":{…}, "hard":{…}}`.

A round copies the selected pack into `word_rounds.words` and the base word into
`word_rounds.grand_word`. From that point the round is immutable, so both phones and the
referee read the same list even if the puzzle bank is later regenerated.

### 4.3 Review rule

Read a new batch before uploading it. Word quality is the top product risk: a plausible
word that the game rejects feels arbitrary, while an obscure or rude word damages the tone.
The blocklist and frequency gates are a starting point, not a substitute for a human scan.

## 5. Data model and server rules

The migration is `supabase/migrations/202610190001_word_wheel.sql`; the consolidated
`schema.sql` contains the same definitions.

### 5.1 Tables

- `word_puzzles` — the pregenerated bank described above. RLS enabled, no direct table
  access for `anon` or `authenticated`.
- `word_rounds` — one couple's round: `couple_id`, `puzzle_id`, `difficulty`,
  `duration_seconds`, `letters`, `grand_word`, `words`, `status`
  (`waiting` / `running` / `finished` / `cancelled`), `start_at`, `finished_at`,
  `winner_id`, and both player ids. A partial unique index (`word_one_open_round`) allows at
  most one waiting/running round per couple.
- `word_round_results` — one row per player per round: `words_found`, `finished_ms`,
  `ready_at`, `submitted_at`. Created for both partners when the round starts, so readiness
  and missing submissions are represented without nullable match fields.

Both round tables are RLS-protected and private. The app sees only sanitized JSON from the
`SECURITY DEFINER` functions.

### 5.2 Public RPCs

| RPC | Behaviour |
|---|---|
| `start_word_round(difficulty, seconds)` | Locks the couple, validates Easy/Medium/Hard and 60/180/300, resumes the existing open round if there is one, otherwise chooses a random puzzle with a non-empty pack for that combination, preferring puzzles this couple has not seen in the last 60 days. Copies the pack and creates both result rows. |
| `word_ready(round_id)` | Stamps the caller's `ready_at`. When both rows are ready, atomically sets `status = 'running'` and `start_at = now() + 8 seconds`. Idempotent and safe to retry. |
| `word_submit(round_id, words[], finished_ms)` | Only after `start_at`. Filters to distinct lowercase words from the round's hidden list, clamps `finished_ms` into `0..duration*1000`, stores the result once, and calls `word_settle`. A retry after the first submission returns the existing view unchanged. |
| `word_cancel(round_id)` | Cancels a lobby that has not started. A live round cannot be cancelled. |

### 5.3 Internal functions

- `word_layout(words[])` — groups hidden words by length for the wire snapshot.
- `word_view(round, uid)` — the caller's sanitized projection: letters, difficulty,
  duration, grand word, hidden words, layout, totals, status, start time, server now, own
  result, and a partner result that stays sealed until `finished`.
- `word_settle(round_id)` — under the round row lock, waits until both result rows have
  `submitted_at`; compares count, then `finished_ms`; writes `finished`, `winner_id` and
  `finished_at`.
- `word_sweep(couple_id)` — called on every `games_state()` read. Cancels stale lobbies and
  settles live rounds 45 seconds past their deadline, treating a missing phone as zero
  words. This is why neither phone needs to run a server-side timer.

`games_state()` was extended to call `word_sweep` and to append a pseudo-match with
`game = 'word-wheel'` and a `word` view. That single change makes Word Wheel appear in the
Ongoing games card, the Games badge (`needsMyMove`), Last duel, rematches and the existing
2-second polling cadence without a second realtime channel.

### 5.4 Scoring rules in SQL

```
if count_x > count_o            -> player_x
else if count_o > count_x       -> player_o
else if finished_ms_x < finished_ms_o -> player_x
else if finished_ms_o < finished_ms_x -> player_o
else                            -> draw (winner_id null)
```

The `finished_ms` value is the elapsed time of the player's last found word, explicitly
submitted by the phone and clamped by the server. A player who never finds a word has 0 and
loses any count comparison. A player who clears every word submits immediately, so their
last-found time is their full-clear time. If both players clear, the faster full clear wins.

## 6. Client architecture

- `src/lib/wordWheel.ts` — pure rules shared by UI and tests: level/duration constants,
  normalisation, buildability, blank grouping, hint choice, shuffle, comparison and clock
  formatting.
- `src/components/games/WordWheel.tsx` — the view and the pointer state machine.
- `src/lib/gamesService.ts` — wire types, `wordRoundFromWire` sanitisation and the four RPC
  wrappers.
- `src/hooks/useGames.ts` — starts/readies/submits/cancels, polling, the 2-second snapshot
  and `needsMyMove`.
- `src/components/games/GamesView.tsx` — the library card (level and duration pickers) and
  the in-tab round panel.
- `src/components/games/games.css` — wheel, blanks, lobby, countdown, result and shake
  styling.

### 6.1 Screens

1. **Lobby** — wheel preview, chosen level and duration, total hidden words, both readiness
   states, the rules list, **I'm ready**, and exit. While waiting, the countdown shows when
   the shared start is set.
2. **Countdown** — a large number derived from the same `start_at`; the board unlocks at
   zero. A late joiner sees the clock already running rather than a fresh start.
3. **Board** — time left, words found / total, a "Saved" or "Round live" pill, partner
   status, a progress bar, blank rows (grand prize first, then 2–6 by length), current
   swipe, the SVG wheel, feedback, shuffle, hint count, type-a-word and exit.
4. **Saved** — shown when this phone submitted but the partner has not; states the count,
   last-word time and that the result will settle on the next refresh.
5. **Result** — winner or draw, both counts and last-word times, both word lists, **Play
   again →** with the same settings, and exit.

### 6.2 Pointer state machine

- `pointerdown` captures the pointer, finds the nearest tile within the hit radius and
  starts a path.
- `pointermove` adds the nearest new tile. Re-entering the previous tile truncates the path
  by one; re-entering an earlier tile is a no-op. Each index can appear at most once.
- `pointerup`/`pointercancel` ends the gesture. A path shorter than two tiles is discarded;
  otherwise the word is evaluated.
- The wheel sets `touch-action: none` and prevents default on pointer events so the page does
  not scroll under a swipe.
- Tile `<button>` elements are presentational (`tabIndex=-1`, `aria-hidden`) and the wheel
  has an accessible label; the type-a-word field is the keyboard path.

### 6.3 Local feedback vs server truth

The client keeps found words locally for immediate blank filling. Each successful word is
appended once and the last-found elapsed time is recorded. On the first submission the
phone sends the whole found list plus that time; the database owns the authoritative filtered
count. A background refresh merges any server-side words into local state without wiping a
word the swipe just found.

The clock uses `server_now` from the snapshot to estimate the phone-to-server offset, then a
250 ms local tick. This is a clock display, not a scoring authority: the server clamps
`finished_ms` and rejects submissions before `start_at`.

Unmounting after the clock expires still submits what was found. Without that path the
grace sweep would eventually score the phone as zero.

## 7. Edge cases and acceptance behaviour

| Situation | Expected behaviour |
|---|---|
| Partner never opens the lobby | The round stays waiting; after 30 minutes `word_sweep` cancels it and the next start creates a fresh one. |
| One phone readies and quits | The round waits. Readiness is per-user and idempotent. |
| Both ready, one phone offline during the countdown | The other plays on the absolute clock. A late mount shows the correct remaining time. |
| Player finds all words early | The phone submits immediately; the round ends for that player at that moment and the partner can keep playing until their own deadline. |
| Player finds no words | Submits an empty list at zero; count 0 and time 0, and loses to any positive count. |
| Both find the same number but one last word earlier | The earlier last-word time wins, even if the other person kept swiping longer. |
| Exact tie on count and time | Draw; `winner_id` is null and the UI says "A draw!" |
| Phone never submits | After the deadline plus 45 seconds the sweep stores zero words and full duration for it, then settles. |
| Duplicate submission / retry | The second call returns the existing view; the stored score cannot change. |
| Submitted word not in the hidden list | The database filters it out; the UI also shakes on it locally so the player gets instant feedback. |
| Swipe starts on a tile but never moves | Path length 1 is discarded; no penalty. |
| Swipe traces the same tile twice | The second entry is ignored, so the letter is used once. |
| Shuffle during a swipe or mid-round | Only the tile order changes; the path and found words reset safely. |
| Hint with every word found | Shows "Every word is already found!" and does not consume the hint. |
| Reload during a live round | The same round, words, deadline and local-ready state resume from the server snapshot. Found words that were never submitted are lost; the clock keeps running. |
| Partner's score during play | Sealed. The phone only knows whether they have submitted. |
| Finished round is replayed | Rematch keeps difficulty and duration but draws a new puzzle; history stays intact. |

## 8. Verification and release checklist

Automated coverage:

- `tests/word-wheel-logic.test.mjs` — buildability, normalisation, grouping, hints, shuffle,
  comparison, clock formatting.
- `tests/word-wheel-database.test.mjs` — schema, RLS, pack selection, readiness handshake,
  submission filtering, tie-break, sweep and permissions, against PGlite.
- `tests/word-wheel-ui.test.mjs` — lobby, countdown, board, swipe path, typed words,
  correct/wrong feedback, shuffle, hints and result states in JSDOM.
- `supabase/verify-games.sql` — tables exist and stay private, the one-open-round index
  exists, `games_state` includes `word_view`/`word_sweep`, the four public RPCs are
  `authenticated`-only and the internals are not executable by clients.
- The full suite (`npm test`, typecheck, `oxlint`) is green; the live project has passed
  `verify-games.sql`.

Manual two-device acceptance before calling the release done:

- [ ] Both phones start from the same countdown and show the same letters and blanks.
- [ ] A swipe fills a correct blank; a wrong word shakes and does not consume a blank.
- [ ] Swipe back over the last letter removes it; a letter cannot be used twice.
- [ ] Shuffle reorders only the wheel.
- [ ] Two hints each reveal a letter and decrement independently on each phone.
- [ ] A full clear submits immediately and the partner's round continues.
- [ ] Both submissions produce the correct winner; a count tie is decided by last-word time.
- [ ] A phone that never submits is scored zero after the grace window.
- [ ] Reloading mid-round resumes the same deadline; leaving does not pause it.
- [ ] A stale lobby disappears after 30 minutes and does not block a new round.
- [ ] Reduced-motion users do not get an essential-information-only animation.

## 9. Deliberately out of scope for v1

- Live word-by-word score streaming / Supabase Realtime. The existing 2-second Games poll is
  sufficient; the partner's score stays sealed until settlement.
- A server-side hint ledger. Hints are local, limited and low-stakes.
- Timers shorter than 1 minute or longer than 5, or levels beyond Easy/Medium/Hard.
- Images, definitions, pronunciations or translations for found words.
- Bot opponents, global leaderboards, streaks or currency.
- A browser-side dictionary or runtime puzzle generation. The database only accepts words
  from the pack dealt at round start.
- Anti-cheat beyond result trust and server-side filtering. Cheating is low risk for a
  private couples app; the server still refuses words that were not in the hidden list.

## 10. Future extensions that fit the current model

- Realtime word counts once the couple is already both online (add a broadcast channel, keep
  `games_state` as the reconnect source of truth).
- A post-round "you almost found" strip using the unused words from the puzzle's union.
- Weekly couple stats: favourite lengths, fastest full clear, most grand prizes.
- More curated base packs and themed wheels, regenerated through the same offline script.
- Optional haptics on each correct word and on the final blank.
