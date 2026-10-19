# Dash Duel — Product & Implementation Specification

**Status:** Implemented; release validation in progress
**Product owner:** Nooki
**Target:** Mobile-first Lagos runner with async challenges, presence-gated live races and local free play
**Out of scope for this document:** art production beyond authored CSS/SVG, sound/music, monetization, matchmaking outside an existing couple

Dash Duel lives in Nooki’s paired-couple Games area and Supabase/Postgres RPC pattern. Ranked modes are not fake-local multiplayer: both partners play separate attempts on the same server-dealt course, with persisted progress and server-decided results. Free play is intentionally local and unranked.

---

## 1. Product intent

Dash Duel is a short, replayable three-lane runner set on the Lagos Express. Couples can set an async challenge (the first creator chooses the level), start a live race only while the partner is online (both ready up before the shared start), or take a free local run. Ranked partners use the same course, collect hearts, change lanes and jump barriers. Async progress stays available when the other person is offline; the live race shows the other runner’s confirmed distance.

### Product promises

- **Three clear modes:** Set a challenge is async-first; Play together is hidden unless the partner is online and starts only after both ready; Free run is local and unranked.
- **Async by default:** a challenge never needs both people online.
- **Same course:** each ranked match has one immutable, server-dealt course shared by both runs.
- **Fair result:** the database replays submitted inputs against that course and calculates distance/hearts/collision. A phone never submits a claimed score.
- **Transparent competition:** each side can see the partner’s current distance while a run is active and the final result after both runs settle.
- **Short, forgiving session:** one run should generally take about 1–2 minutes; the user can leave and resume the same live attempt.
- **Crash has mode-appropriate meaning:** in an async challenge it ends one attempt and waits for the other partner; in a live race, the other active runner wins immediately. A forfeit in an async challenge is zero distance/hearts.

## 2. Version-one gameplay decisions

| Topic | Decision |
|---|---|
| Camera | Portrait, forward-running track viewed from behind / slightly above; the runner stays near the lower third and track elements move toward them. |
| Lanes | Exactly 3, ordered left / centre / right, indexed 0 / 1 / 2. Start in centre. |
| Modes | Async challenge (first creator chooses Easy, Steady or Spicy), live together (only offered while the partner is present; both ready before ticks begin), and local free play (not saved or scored). |
| Course | A fixed, 900-tick maximum course, dealt once by the server at match creation. Both partners get the same obstacle and heart schedule. |
| Simulation | Deterministic discrete ticks at 120 ms. Distance advances one unit per survived tick. The authoritative result is based on ticks replayed, not wall-clock time. |
| Controls | Swipe left/right changes one lane; tap or swipe up jumps. On-screen left, jump and right controls are always available for discoverability/accessibility. Keyboard arrows and Space are supported on desktop. |
| Lane change | Immediate at the next simulation tick; a lane-change command at a tick is applied before that tick’s collision check. Out-of-bounds lane changes are ignored (not fatal). |
| Jump | A jump command gives 3 ticks of clearance, including the command tick. A jump cannot be extended by sending repeated jump commands while already airborne. |
| Hazards | Barrier events occupy one or two lanes. Collision occurs when the runner is in an occupied lane at the event tick and is not airborne. Every obstacle event must leave at least one valid safe lane, including a jump-safe option where applicable. |
| Hearts | Heart events occupy one lane. A heart is collected only by entering that lane at that event tick. Hearts add a tie-break score only; distance remains the primary objective. |
| End of run | Collision or reaching tick 900. The ranked run cannot be restarted; reload resumes the same attempt. Explicit “Leave run” confirms a forfeit (zero in a challenge; other active runner wins in live play). Free play can be restarted freely. |
| Winner | Async challenge: compare verified distance, then hearts; an exact tie is a draw. Live together: the first runner to crash loses immediately to the other active runner. A confirmed challenge forfeit is distance 0 and hearts 0. |
| Attempts | Exactly one run per partner per open match. Finished matches can be played again from the library, creating/resuming a new open match only when no open one exists. |
| Live display | Show the partner’s last server-confirmed distance and a target flag on the course. Polling may be every 2 seconds (existing Games cadence); a running run sends a progress heartbeat every 2 seconds. Show “updated X seconds ago” if the partner has not reported recently. Do not imply sub-second realtime. |
| Art | Use the existing Nooki visual language and a small, authored chibi runner made from CSS/SVG or existing local assets. Avoid remote runtime assets. Use distinct outfit/colour for each account’s character. Do not block mechanics on bespoke illustration. |
| Sound / haptics | Off by default; no sound dependency in v1. Respect reduced-motion settings; haptics are optional enhancement, not required feedback. |

### Why async crash and live crash differ

A challenge may be started and crashed before the other partner opens the game. Declaring a winner at that point would make async play arbitrary, so an async crash ends only that attempt and the match waits for the other run. In Play together, both runners passed the ready gate and share a start tick; the first crash awards the active partner the live race.

## 3. Run and course model

### 3.1 Course format

Represent the course as a compact, ordered list of events in `game_matches.dash` (or a dedicated `dash` JSONB column on the match row if extending `game_matches`):

```ts
type DashCourseEvent =
  | { tick: number; kind: 'barrier'; lanes: number[]; jumpable: boolean }
  | { tick: number; kind: 'heart'; lane: number };
```

Requirements:

- Course is generated once inside the server-side `start_dash` RPC and remains immutable for the match.
- Events are sorted by tick; at most one event per tick in v1.
- Course generation is server-side and validates that barriers are not unavoidable. A phone must not be able to replace the course.
- Course cadence should average 1 event every 8–12 ticks, with a short 30-tick safe opening and increasing density in later thirds. Every 10th event on average may be a heart event. Hearts do not replace all hazards; ensure there are frequent route decisions.
- Include a course version number (`course_version: 1`) so replay rules can change later without silently changing old matches.
- Both clients receive the whole course. The route is not secret; fairness comes from server validation and identical course data.

### 3.2 Input log

The client sends only actions, never score or position claims:

```ts
type DashAction = [tick: number, action: 'left' | 'right' | 'jump'];
```

Rules:

- Sort ascending by tick. One action at most per tick. Input tick is zero-based, must be an integer >= 0, and must be less than the submitted tick count.
- Multiple different actions on the same tick are refused. A retry with an already-stored identical action is idempotently ignored, matching the retry-safe Tetris/Snake report behaviour.
- A run report contains the new input delta, current reached tick, and final flag. Server merges the delta, replays the full log from tick 0 through the reported tick, updates server-derived progress and last-seen time, and ends the run on collision/cap/forfeit.
- Cap cumulative input payload size (900 actions maximum for a 900-tick route) and reject invalid action strings, non-increasing input, out-of-range ticks, impossible run status transitions and stale match IDs.
- Never trust `distance`, `hearts`, `lane`, `jumping`, `crashed`, `status`, `score` or `winner_id` sent by the client.

### 3.3 Authoritative replay

Create a pure TypeScript simulation in `src/lib/dash.ts`; mirror it in private SQL functions in the migration. Both must implement the same order exactly:

1. Initialize lane=1, hearts=0, jump_ticks=0, alive=true, distance=0.
2. For each simulation tick from 1 through requested ticks (input tick is simulation tick minus one):
   - Apply the action logged for that tick (left/right one lane, or set jump_ticks=3 when currently grounded).
   - Ignore a lane change beyond 0..2.
   - If a jump is active, this tick is airborne; decrement jump_ticks after resolving the event.
   - Resolve this tick’s course event. For a heart in the current lane, increment hearts. For a barrier, collision if current lane is in `lanes` and the tick is not airborne.
   - If alive, increment distance by one. If collision happens, stop immediately; collision tick is not added to distance.
3. Stop at cap 900.
4. Store server-derived `distance`, `hearts`, `status`, `ended` (`barrier`, `cap`, `forfeit`), and `ticks`.

Be explicit in unit tests about whether a jump lasts exactly three collision checks and that an obstacle at tick N is handled after the N-tick input. Shared fixtures should exercise both TS and SQL replay so drift is caught.

## 4. Match lifecycle and async behaviour

### 4.1 Start / resume

- Add `dash-duel` to `GameId` and the Games library, with copy: **“Three lanes, one shared track. Grab hearts, dodge barriers, and beat your partner’s distance.”**
- A dedicated `start_dash(mode, level)` RPC starts or resumes the couple’s open challenge or live-together Dash Duel (one open match per mode). Lock the couple row, confirm both profiles are paired, create the match if none is open, and deal the immutable route on creation.
- Do not route Dash through generic `start_game` if that risks migration-era overload behavior; dedicated start RPC is consistent with `start_chess` / `start_tetris`.
- First player opening the match gets a run only on tapping **Start my run**. The second partner may start at any time. Resume returns the same run, route, progress and action log for that user.
- If a match has been open past its expiry/grace window, server sweep settles missing runs as forfeits before starting a new match. Choose a 7-day match expiry for an async game; an offline partner must not block a couple indefinitely.

### 4.2 Active run

- The UI replays the local game at the agreed cadence and buffers actions.
- Send heartbeat/progress every 2 seconds and on run end. Server replays the action log and returns canonical run state; reconcile client prediction to that response without visibly snapping unless reports disagree.
- Do not let routine progress RPCs use/clear the shared `games.busy` lock; follow existing `beat` / `beatTetris` patterns.
- If the network drops, keep the local prediction and queue the unacknowledged action delta. Retry with the same ticks/actions; server must be idempotent. Display “Trying to reconnect”; do not announce a locally predicted score as official.
- Hide/pause animation while browser tab is hidden, but do **not** silently pause a ranked run’s simulation clock: simulation is tick/input based, so no ticks elapse while hidden. On resume, continue from confirmed game state and submit elapsed local actions only if actually played.
- If navigating away during an active run, show a confirmation. “Keep running in background” is not a v1 option. Confirmed leave calls `dash_forfeit`; cancellation keeps the board open.

### 4.3 Match state and result

Expected match presentation (shape can align with `SnakeDuel` / `TetrisDuel`):

```ts
interface DashRunSide {
  status: 'waiting' | 'running' | 'done' | 'crash' | 'forfeit';
  distance?: number;          // visible live; server verified
  hearts?: number;            // show live if desired; final is authoritative
  ticks?: number;
  last_seen?: string | null;
  ended?: 'barrier' | 'cap' | 'forfeit' | null;
}
interface DashMatchState {
  course_version: 1;
  course: DashCourseEvent[];
  mine: DashRun | null;
  partner: DashRunSide;
}
```

- Waiting side shows **“Waiting for [partner] to run”**.
- Running partner shows **“[Partner] · X m · here now / last seen N sec ago”** with a target flag at proportional course distance. Clamp visual position to course bounds and give a text equivalent for screen readers.
- Completed run shows distance/hearts; while the other side is not done, say **“Your run is saved. Waiting for [partner]”**.
- When both runs are done, the server sets `finished` and `winner_id` from the replayed result; draw leaves winner null. Reveal both final scores and provide access to the history row/rematch.
- An ongoing match where the run on both sides is done should be hidden from the “ongoing” swipe carousel, following `runDuelConcluded()` for Snake/Tetris.
- Add Dash to pending count while the user has not yet finished their own run. Once done, it should not keep the Games tab badge active while waiting on the partner.
- Add Dash to the duel bookkeeping path so a settled duel's name, result, verified distances and hearts are recorded. Avoid reporting stale/missing data as zero unless that is in fact the server result.

## 5. Database/API implementation contract

Use the next sequential migration after the Together list enhancements: **`supabase/migrations/202610180009_dash_duel.sql`** (007 adds visits and the list; 008 adds list details/order and visit links; 006 is Connect Four).

### Schema

- Add `dash jsonb NOT NULL DEFAULT '{}'::jsonb` to `public.game_matches`.
- Extend `game_matches_game_check` to include `dash-duel`, preserving only currently supported game IDs (`rock-paper-scissors`, `snake`, `chess`, `tetris`, `connect-four`, `dash-duel`). Do not restore retired Tic Tac Toe.
- Add a partial unique index for one open Dash match per couple if the existing generic unique index does not already cover it. Use the same index pattern as the existing game IDs; avoid conflicting with `tetris_mode` uniqueness.
- Add the match’s dash JSON to `games_state()`. Filter/shape each side with a private SQL `dash_view` helper as appropriate. Course can be public to the couple. A partner run can expose server-confirmed current distance and activity time; no need to seal distance because the stated product promises live partner distance.

### RPCs

- `start_dash(p_mode text, p_level text) RETURNS uuid`: authentication/pair validation; lock couple; find/create the open async or live match; the first creator sets the level and the immutable course.
- `dash_start(p_id uuid) RETURNS jsonb`: authenticated match participant only; challenge mode starts that partner’s run; live mode records readiness and starts both attempts at one shared tick after both are ready.
- `dash_beat(p_id uuid, p_ticks integer, p_actions jsonb) RETURNS jsonb`: append idempotent actions, replay, update own run progress/last_seen, settle if terminal.
- `dash_finish(p_id uuid, p_ticks integer, p_actions jsonb) RETURNS jsonb`: same commit path, with final/cap semantics; final replay determines natural crash or cap, never client claim.
- `dash_forfeit(p_id uuid) RETURNS jsonb`: participant’s own running/waiting attempt only; settle it as forfeited with zero distance/hearts; check idempotency.
- Private helpers: `dash_replay`, `dash_commit`, `dash_settle`, `dash_sweep`, `dash_view`, `dash_max_ticks`, and course generation/validation. Revoke private helper EXECUTE from `PUBLIC`, `anon`, and `authenticated`; grant only public wrapper RPCs to authenticated. Keep match table inaccessible directly, consistent with the rest of Games.
- Use row locks for the match mutation and lock consistently to avoid race conditions between simultaneous heartbeat/finish/forfeit requests. A repeated stale tick/report must not erase newer data.
- Make migration safe to apply after `202610180007_together_visits_and_someday_list.sql` and safe to rerun where practical. Keep fresh consolidated `supabase/schema.sql` in sync.
- Extend `supabase/verify-games.sql` to check the column, game constraint, RPC signatures/privileges, and that all replay/settle internals remain server-only.

### Client integration

Follow existing patterns rather than introducing a separate backend abstraction:

- Add `DashDuel` match/state types and `'dash-duel'` to `GameId`/`GAMES` in `src/lib/gamesService.ts`.
- Add RPC wrappers and safe parsing/mapping for course/run data.
- Extend `useGames` with `startDash`, `startDashRun`, `beatDash`, `finishDash`, `forfeitDash`, and `duelLive` as needed. Ensure heartbeat methods do not block column/button input.
- Implement `src/lib/dash.ts` as deterministic, typed core with pure functions and replay. Keep React and network imports out of the core.
- Build `DashDuel.tsx` and styles with semantic buttons, keyboard controls, touch swipes, reduced-motion handling, reconnect status, exit confirmation and partner-progress display.
- Wire it in `GamesView.tsx`; include Dash start/retry copy, match view, ongoing filtering, badge, final-result/history row and rematch path. Do not add Dash to the library until its RPCs are wired; no disabled-looking fake card.
- No game asset must be downloaded at runtime. If a visual runner asset is not ready, use an authored CSS/SVG chibi silhouette and stable lane/obstacle icons; keep semantics available to assistive technology.

## 6. Screen-by-screen UX

### Library card

- Icon: 🏃. Name: **Dash Duel**.
- Description: **Three lanes, one shared track. Grab hearts, dodge barriers, and beat your partner’s distance.**
- Primary button: **Dash [partner] →** (or match existing library wording pattern).
- Loading state names the game and does not show a generic spinner without context.
- Start errors name `202610180009_dash_duel.sql` and `supabase/verify-games.sql` in the same way Snake/Tetris guide users to their setup migration. Show the live option only while partner presence is online; the async and free options stay visible.

### Waiting/gate screen

- Show match name, the shared track preview, the partner’s best/current distance if present, and clear status.
- Primary button: **Start my run** when mine is waiting; **Resume my run** when mine is running.
- If the partner has finished first: show their distance as the target and invite the current user to beat it.
- If mine is done while partner has not started: show the saved result and non-blocking waiting message, plus a back-to-games action.

### Active run board

- Track area with exactly three clearly separated lanes and approaching items. Character sits in lower region.
- HUD: current distance (units can be shown as metres if product uses one unit = one metre), hearts, partner marker/distance, and short connection status.
- Controls remain reachable on small phones; do not make canvas itself the only control. Touch controls must prevent accidental page scroll during play but must not disable scroll outside the active board.
- Every heart and barrier has an icon and accessible label; color is never the only cue. Respect `prefers-reduced-motion` by using simpler transitions/no shake.
- Crash message states why: “Barrier hit — your run ended at 186 m.” Show hearts and “Waiting for [partner]” or result if both complete.

## 7. Edge cases to implement explicitly

1. Both partners tap start at the same time: exactly one open match, one course.
2. Both start run around the same time: each gets one independent attempt, no duplicate runs.
3. Repeated/overlapping heartbeat and finish request: duplicate actions skipped idempotently, finish succeeds once.
4. Client reloads mid-run: fetch canonical state and resume same run, not a new attempt.
5. Partner offline for days: match remains open until the stated 7-day expiry; do not prematurely forfeit at the 30-second presence threshold used by active Snake/Tetris runs.
6. User crashes before partner starts: show crash score, leave match open, await the partner’s run.
7. Partner completed run before user starts: surface target score and let the user attempt course.
8. User hits barrier then submits later ticks: server ignores ticks after terminal collision and never awards distance past collision.
9. Invalid lane/action/tick, repeated different action for same tick, malformed course, nonparticipant match id, stale or future tick: reject safely with useful errors.
10. Hearts do not affect primary distance ordering; hearts break distance ties only.
11. Both score equal distance/hearts: draw, `winner_id` null.
12. Exit confirmation dismissed: do not forfeit. Confirmed forfeit: server persists, partner can complete and win.
13. A run reaches cap: end as `cap`, no crash penalty. In async and live modes, wait for the other attempt and compare verified distance/hearts; only a live crash or confirmed forfeit awards the other active runner immediately.
14. Database migration absent: user sees setup guidance specific to Dash, not raw Postgres/PGRST error.
15. A broken/stale games_state: keep migration errors visible and retry the actual failed start/action, following existing hook behavior.

## 8. Acceptance criteria

Dash Duel is ready for a release candidate only when all are true:

- [ ] Library card starts/resumes the same Dash match for both accounts in a couple and never for an unrelated account.
- [ ] Each match has one immutable shared course and each partner has at most one run.
- [ ] Three-lane controls work by swipe, visible buttons, and keyboard; lane bounds are safe.
- [ ] A barrier collision ends the run; a valid jump/lane change avoids it; hearts are counted only by the server.
- [ ] For the same course and action log, TypeScript and SQL replay produce identical distance/hearts/end reason.
- [ ] The client cannot spoof score/distance/hearts/winner by altering RPC arguments.
- [ ] Partner distance updates while a run is active, remains available async, and the UI indicates staleness.
- [ ] A finished run cannot be restarted in the same match; other partner may still play later.
- [ ] Async challenge settles to higher verified distance, hearts tie-break or draw without premature victory; live mode waits for both ready and awards the other active runner on crash.
- [ ] Retry/reload/overlap, forfeit, expiry, invalid move, nonparticipant, and RLS/privilege cases are covered.
- [ ] Pending badge, ongoing carousel, and rematch behavior agree with state.
- [ ] `supabase/verify-games.sql`, full test suite, TypeScript, lint (no new warnings/errors), and production build pass.
- [ ] README deployment sequence documents `202610180009_dash_duel.sql` after `202610180008_someday_details_order_and_visit_link.sql` and lists Dash verification.
- [ ] At least one browser-level test plays a full run on mobile-sized viewport and one server test validates replay/settlement.

## 9. Suggested implementation order

1. **Core first:** define course/action types, simulation and TS unit fixtures (lane bounds, jump windows, collisions, hearts, cap).
2. **SQL referee:** add migration, replay/settlement/RPCs and integration tests; prove SQL parity against shared fixtures before building the animated board.
3. **Service/hook:** map types, wrappers, migration-aware errors, retry-safe progress reporting and pending/duel-live logic.
4. **Game screen:** waiting gate, runner board/controls, partner target, pause/reconnect/crash/result states.
5. **Games integration:** library, selected match routing, ongoing/finished/history/badge/rematch.
6. **Hardening:** adversarial SQL tests, migration verify, browser controls/accessibility, full test suite/build, README setup sequence.

## 10. Explicitly deferred beyond v1

- True sub-second WebSocket/presence updates; 2-second server-confirmed progress polling is sufficient for “live when both online”.
- Power-ups, boosts, shields, skins unlocks, monetized cosmetics, leaderboards outside the couple.
- Different courses per mode, user-generated courses, matchmaking strangers, ghost replays, spectating and tournament brackets.
- Separate ranked matchmaking outside the couple. Async challenge comparison remains the default; the live-together option is explicitly presence-gated and ready-gated.
