import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GamesState } from '../../hooks/useGames';
import {
  dashActions,
  type DashDuel as DashMatchState,
  type DashRun,
  type DashSide,
  type GameMatch,
} from '../../lib/gamesService';
import {
  DASH_BEAT_MS,
  DASH_MAX_TICKS,
  DASH_TICK_MS,
  createDashState,
  dashEventLabel,
  dashLevelLabel,
  replayDash,
  stepDash,
  dealPracticeDashCourse,
  type DashAction,
  type DashActionName,
  type DashCourseEvent,
  type DashLevel,
  type DashState,
} from '../../lib/dash';
import './games.css';

interface DashDuelProps {
  match: GameMatch;
  userId: string;
  partnerName: string;
  partnerOnline: boolean;
  games: GamesState;
  onExit: () => void;
}

interface ResumeRun {
  ticks: number;
  actions: DashAction[];
}

interface DashBoardProps {
  course: DashCourseEvent[];
  resume?: ResumeRun;
  partner?: DashSide;
  partnerName: string;
  characterSeed?: string;
  partnerSeed?: string;
  ranked: boolean;
  mode?: 'challenge' | 'together' | 'free';
  onBeat?: (ticks: number, actions: DashAction[]) => Promise<DashRun>;
  onFinish?: (ticks: number, actions: DashAction[]) => Promise<DashRun>;
  onForfeit?: () => Promise<unknown>;
  onExit: () => void;
  onReplay?: () => void;
}

function endLabel(ended: string | null | undefined): string {
  if (ended === 'barrier') return 'Barrier hit';
  if (ended === 'cap') return 'Course complete';
  if (ended === 'forfeit') return 'Run forfeited';
  if (ended === 'opponent-crash') return 'Partner crashed — you win';
  return 'Run finished';
}

function relativeFreshness(lastSeen?: string | null): string {
  if (!lastSeen) return 'distance saved';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(lastSeen).getTime()) / 1000));
  return seconds < 8 ? 'here now' : `updated ${seconds}s ago`;
}

export function DashDuel({ match, userId, partnerName, partnerOnline, games, onExit }: DashDuelProps) {
  const dash: DashMatchState | null = match.dash ?? null;
  const mine = dash?.mine ?? null;
  const partner = dash?.partner ?? { status: 'waiting', ended: null };
  const isTogether = dash?.mode === 'together';
  const course = dash?.course ?? [];
  const level = dash?.level ?? 'steady';
  const bothScores = match.finished;
  const won = match.winner_id === userId;
  const drawn = match.finished && match.winner_id === null;

  const partnerId = match.player_x === userId ? match.player_o : match.player_x;
  const startMyRun = async () => {
    await games.startDash(match.id);
  };
  if (!dash) {
    return <div className="game-card" role="status">Loading the shared Lagos course…</div>;
  }

  if (bothScores) {
    return (
      <div className="game-card dash-result" data-dash-result="finished">
        <div className="dash-result-stamp" aria-hidden="true">🏁</div>
        <span className="games-eyebrow">{dash.mode === 'together' ? 'Live race' : 'Async challenge'} · {dashLevelLabel(level)}</span>
        <h2>{drawn ? 'A photo finish — it’s a draw!' : won ? 'You won the Dash Duel!' : `${partnerName} won the Dash Duel!`}</h2>
        <div className="dash-score-pair">
          <div><span>You</span><strong>{mine?.distance ?? 0} m</strong><small>💗 {mine?.hearts ?? 0} hearts · {endLabel(mine?.ended)}</small></div>
          <div><span>{partnerName}</span><strong>{partner.distance ?? 0} m</strong><small>💗 {partner.hearts ?? 0} hearts · {endLabel(partner.ended)}</small></div>
        </div>
        <p className="game-hint">Same course, referee-checked scores. Set a fresh course whenever you’re ready for another run.</p>
        <button type="button" disabled={games.busy} onClick={onExit}>Back to Games</button>
      </div>
    );
  }

  if (mine?.status === 'running') {
    return (
      <>
        <DashBoard
          key={`${match.id}:${mine.started_at ?? mine.ready_at ?? 'run'}`}
          course={course}
          resume={{ ticks: mine.ticks, actions: dashActions(mine.actions) }}
          partner={partner}
          partnerName={partnerName}
          characterSeed={userId}
          partnerSeed={partnerId}
          ranked
          mode={isTogether ? 'together' : 'challenge'}
          onBeat={(ticks, actions) => games.beatDash(match.id, ticks, actions)}
          onFinish={(ticks, actions) => games.finishDash(match.id, ticks, actions)}
          onForfeit={() => games.forfeitDash(match.id)}
          onExit={onExit}
        />
      </>
    );
  }

  if (mine && mine.status !== 'ready') {
    return (
      <div className="game-card dash-waiting" data-dash-waiting="me">
        <span className="games-eyebrow">{dashLevelLabel(level)} · shared Lagos track</span>
        <h2>Your run is saved: {mine.distance} m</h2>
        <p className="game-status" role="status">
          {partner.status === 'running'
            ? `${partnerName} is on the track · ${partner.distance ?? 0} m · ${relativeFreshness(partner.last_seen)}`
            : partner.status === 'waiting'
              ? `${partnerName} hasn’t started yet. Your course and distance will be waiting when they open Dash Duel.`
              : `${partnerName} finished too — settling the result…`}
        </p>
        <p className="dash-hearts-earned">💗 {mine.hearts} hearts collected · {endLabel(mine.ended)}</p>
        <p className="game-hint">Your run is saved. No need to stay online while {partnerName} catches up.</p>
        <button type="button" onClick={onExit}>Back to Games</button>
      </div>
    );
  }

  if (isTogether && mine?.status === 'ready') {
    return (
      <div className="game-card dash-ready" data-dash-ready="true">
        <span className="games-eyebrow">Live together · {dashLevelLabel(level)}</span>
        <h2>You’re at the start line 🏁</h2>
        <p className="game-status" role="status">
          {partner.status === 'ready' || partner.status === 'running'
            ? `Starting with ${partnerName}…`
            : partnerOnline
              ? `Waiting for ${partnerName} to get ready. You’ll both launch on the same tick.`
              : `${partnerName} went offline. They can rejoin and ready up when they’re back.`}
        </p>
        <p className="game-hint">The live course stays here while you wait. You haven’t started moving yet.</p>
        <button type="button" className="dash-secondary" onClick={onExit}>Back to Games</button>
      </div>
    );
  }

  const partnerCopy = partner.status === 'running'
    ? `${partnerName} is running · ${partner.distance ?? 0} m · ${relativeFreshness(partner.last_seen)}`
    : partner.status === 'done' || partner.status === 'crash' || partner.status === 'forfeit'
      ? `${partnerName} finished first: ${partner.distance ?? 0} m to beat`
      : isTogether
        ? partnerOnline ? `${partnerName} is online — you can start together.` : `Waiting for ${partnerName} to come online.`
        : `${partnerName} will see your distance as a target to chase.`;

  return (
    <div className="game-card dash-gate" data-dash-mode={dash.mode}>
      <div className="dash-gate-art" aria-hidden="true">
        <span>🏙️</span><span>🚌</span><span>🌴</span>
      </div>
      <span className="games-eyebrow">{isTogether ? 'Play together' : 'Set a challenge'} · {dashLevelLabel(level)}</span>
      <h2>{isTogether ? 'Same track. Same time.' : 'One course, two runs.'}</h2>
      <p className="game-status" role="status">{partnerCopy}</p>
      {dash.created_by && dash.created_by !== userId && <p className="dash-course-owner">{partnerName} set this course first — you’re chasing their route.</p>}
      <div className="dash-course-preview" aria-label={`Shared ${level} Lagos course with ${course.length} course events`}>
        {[0, 1, 2].map((lane) => (
          <span className={`dash-mini-lane dash-mini-lane-${lane}`} key={lane}>
            {course.slice(0, 9).filter((_, index) => index % 3 === lane).map((event) => (
              <i key={`${event.tick}:${event.kind}`} aria-hidden="true">{event.kind === 'heart' ? '💗' : '🚧'}</i>
            ))}
          </span>
        ))}
      </div>
      {isTogether ? (
        <ul className="dash-rules">
          <li>Both of you ready up before the race starts.</li>
          <li>Crash ends the live race — the other runner wins.</li>
          <li>Live option only appears while {partnerName} is online.</li>
        </ul>
      ) : (
        <ul className="dash-rules">
          <li>Play whenever you like; you don’t need to be online together.</li>
          <li>The first runner sets this route. {partnerName} gets the same course later.</li>
          <li>Distance wins; hearts break a tie. A crash ends only your attempt.</li>
        </ul>
      )}
      <div className="dash-gate-actions">
        {isTogether && !partnerOnline
          ? <p className="game-hint">Play together will appear again when {partnerName} is online.</p>
          : <button
            type="button"
            disabled={games.busy}
            onClick={() => void startMyRun()}
            data-action="dash-ready"
          >
            {games.busy ? 'Getting ready…' : isTogether ? 'I’m ready to race' : 'Start my run'}
          </button>}
        <button type="button" className="dash-secondary" onClick={onExit}>Back to Games</button>
      </div>
    </div>
  );
}

function seededDashRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A local, unranked runner: no RPC, no match, no badge, just a quick lap. */
export function DashFreePlay({ level, seed, onExit }: { level: DashLevel; seed: number; onExit: () => void }) {
  const [nonce, setNonce] = useState(0);
  const course = useMemo(() => {
    // Free play uses the same rules with a local course; ranked routes come only from SQL.
    return dealPracticeDashCourse(level, seededDashRandom(seed + nonce));
  }, [level, seed, nonce]);
  return (
    <DashBoard
      key={`free:${nonce}:${level}`}
      course={course}
      partnerName="your own best"
      ranked={false}
      mode="free"
      onExit={onExit}
      onReplay={() => setNonce((value) => value + 1)}
    />
  );
}

function DashBoard({
  course,
  resume,
  partner,
  partnerName,
  characterSeed,
  partnerSeed,
  ranked,
  mode = 'free',
  onBeat,
  onFinish,
  onForfeit,
  onExit,
  onReplay,
}: DashBoardProps) {
  const [state, setState] = useState<DashState>(() => resume ? replayDash(course, resume.ticks, resume.actions) : createDashState());
  const stateRef = useRef(state);
  const actionsRef = useRef<DashAction[]>(resume?.actions.slice() ?? []);
  const pendingActionsRef = useRef<DashAction[]>([]);
  const queuedActionRef = useRef<DashActionName | null>(null);
  const inFlightRef = useRef(false);
  const lastBeatRef = useRef(0);
  const lastConfirmedTickRef = useRef(resume?.ticks ?? 0);
  const onBeatRef = useRef(onBeat);
  const onFinishRef = useRef(onFinish);
  const onForfeitRef = useRef(onForfeit);
  const [connection, setConnection] = useState<'live' | 'reconnecting' | 'free'>
    (ranked ? 'live' : 'free');
  const [finishSaved, setFinishSaved] = useState(!ranked || !resume);
  const [showLeave, setShowLeave] = useState(false);
  const [away, setAway] = useState(typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => { lastBeatRef.current = Date.now(); }, []);
  useEffect(() => { onBeatRef.current = onBeat; }, [onBeat]);
  useEffect(() => { onFinishRef.current = onFinish; }, [onFinish]);
  useEffect(() => { onForfeitRef.current = onForfeit; }, [onForfeit]);

  // Reconcile only server progress that is at least as new as the current local prediction.
  // An ordinary two-second poll behind the runner must not snap the animation backwards.
  useEffect(() => {
    if (!resume) return;
    const serverActions = resume.actions;
    const merged = new Map<number, DashActionName>();
    for (const action of serverActions) merged.set(action.tick, action.action);
    for (const action of actionsRef.current) if (!merged.has(action.tick)) merged.set(action.tick, action.action);
    actionsRef.current = [...merged.entries()].sort(([a], [b]) => a - b).map(([tick, action]) => ({ tick, action }));
    pendingActionsRef.current = pendingActionsRef.current.filter((action) =>
      !serverActions.some((saved) => saved.tick === action.tick && saved.action === action.action));
    if (resume.ticks >= stateRef.current.ticks && resume.ticks > lastConfirmedTickRef.current) {
      const canonical = replayDash(course, resume.ticks, actionsRef.current);
      stateRef.current = canonical;
      setState(canonical);
    }
    lastConfirmedTickRef.current = Math.max(lastConfirmedTickRef.current, resume.ticks);
  }, [course, resume, resume?.ticks, resume?.actions]);

  const commit = useCallback(async () => {
    if (!ranked || inFlightRef.current) return;
    const current = stateRef.current;
    if (!current.ended) return;
    inFlightRef.current = true;
    const actions = pendingActionsRef.current.slice();
    try {
      const accepted = await onFinishRef.current?.(current.ticks, actions);
      if (accepted) {
        const acceptedSet = new Set(accepted.actions.map(([tick, action]) => `${tick}:${action}`));
        pendingActionsRef.current = pendingActionsRef.current.filter((action) => !acceptedSet.has(`${action.tick}:${action.action}`));
        lastConfirmedTickRef.current = Math.max(lastConfirmedTickRef.current, accepted.ticks);
        setConnection('live');
        setFinishSaved(true);
      }
    } catch {
      setConnection('reconnecting');
      setFinishSaved(false);
    } finally {
      inFlightRef.current = false;
      lastBeatRef.current = Date.now();
    }
  }, [ranked]);

  // The step clock advances only while visible. A hidden tab does not accrue fake progress;
  // the server tick budget still prevents a client from moving faster than real time.
  useEffect(() => {
    const visibility = () => setAway(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, []);

  useEffect(() => {
    if (away || state.ended) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || stateRef.current.ended) return;
      const action = queuedActionRef.current ?? undefined;
      queuedActionRef.current = null;
      const next = stepDash(stateRef.current, course, action);
      if (next.applied) {
        actionsRef.current = [...actionsRef.current, next.applied];
        pendingActionsRef.current = [...pendingActionsRef.current, next.applied];
      }
      stateRef.current = next.state;
      setState(next.state);
      if (next.state.ended && ranked) {
        lastBeatRef.current = Date.now();
        void commit();
      } else if (next.state.ticks === DASH_MAX_TICKS && ranked) {
        void commit();
      }
    }, DASH_TICK_MS);
    return () => window.clearInterval(timer);
  }, [away, course, ranked, state.ended, commit]);

  // Periodic progress shares the action log without touching the Games busy lock.
  useEffect(() => {
    if (!ranked) return undefined;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || inFlightRef.current) return;
      const current = stateRef.current;
      if (current.ended) {
        if (Date.now() - lastBeatRef.current >= DASH_BEAT_MS) void commit();
        return;
      }
      if (Date.now() - lastBeatRef.current < DASH_BEAT_MS || !onBeatRef.current) return;
      inFlightRef.current = true;
      const actions = pendingActionsRef.current.slice();
      void onBeatRef.current(current.ticks, actions)
        .then((accepted) => {
          const acceptedSet = new Set(accepted.actions.map(([tick, action]) => `${tick}:${action}`));
          pendingActionsRef.current = pendingActionsRef.current.filter((action) => !acceptedSet.has(`${action.tick}:${action.action}`));
          lastConfirmedTickRef.current = Math.max(lastConfirmedTickRef.current, accepted.ticks);
          setConnection('live');
        })
        .catch(() => setConnection('reconnecting'))
        .finally(() => {
          inFlightRef.current = false;
          lastBeatRef.current = Date.now();
        });
    }, 300);
    return () => window.clearInterval(timer);
  }, [ranked, commit]);

  const steer = useCallback((action: DashActionName) => {
    if (stateRef.current.ended) return;
    // At most one input is recorded per tick. If a few taps land between ticks, the
    // latest deliberate control wins, keeping the log unambiguous and retry-safe.
    queuedActionRef.current = action;
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, select')) return;
      const action = event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a' ? 'left'
        : event.key === 'ArrowRight' || event.key.toLowerCase() === 'd' ? 'right'
          : event.key === 'ArrowUp' || event.key === ' ' || event.key.toLowerCase() === 'w' ? 'jump'
            : null;
      if (!action) return;
      event.preventDefault();
      steer(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [steer]);

  const onTouchEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    if (!start) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    touchStartRef.current = null;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
    if (Math.abs(dx) > Math.abs(dy)) steer(dx < 0 ? 'left' : 'right');
    else if (dy < 0) steer('jump');
  };

  const upcoming = course.filter((event) => event.tick > state.ticks && event.tick <= state.ticks + 28);
  const partnerDistance = partner?.distance;
  const partnerMarker = partnerDistance === undefined ? undefined : Math.min(95, Math.max(5, partnerDistance / DASH_MAX_TICKS * 100));
  const coursePct = Math.min(100, state.distance / DASH_MAX_TICKS * 100);
  const status = state.ended
    ? `${endLabel(state.ended)} — your run reached ${state.distance} metres and collected ${state.hearts} hearts.`
    : connection === 'reconnecting'
      ? 'Trying to reconnect. Your moves are saved on this device and will retry.'
      : away ? 'Run paused while this tab is hidden.'
        : ranked ? 'Run live. Your verified distance is sent every two seconds.' : 'Free run · this score is just for you.';

  return (
    <div className="dash-run" data-dash-run={mode} data-dash-distance={state.distance}>
      <div className="dash-hud">
        <div className="dash-distance"><span>{ranked ? 'Your distance' : 'Free run'}</span><strong>{state.distance}<small> m</small></strong></div>
        <div className="dash-hud-right">
          <span className="dash-hearts" aria-label={`${state.hearts} hearts collected`}>💗 {state.hearts}</span>
          {ranked && partner && partner.status !== 'waiting' && <span className="dash-partner-distance">{partnerName} · {partner.distance ?? 0} m</span>}
          <span className={`dash-pill dash-pill-${ranked ? connection : 'free'}`} data-dash-connection={connection}>
            {ranked ? connection === 'reconnecting' ? 'Reconnecting' : connection === 'live' ? 'Live' : 'Connecting…' : 'Not counted'}
          </span>
        </div>
      </div>
      <div className="dash-progress" aria-label={`You have run ${state.distance} of ${DASH_MAX_TICKS} metres`}>
        <i className="dash-progress-you" style={{ width: `${coursePct}%` }} />
        {partnerMarker !== undefined && <span className="dash-progress-partner" style={{ left: `${partnerMarker}%` }} aria-label={`${partnerName} at ${partnerDistance} metres`}>
          <ChibiRunner seed={partnerSeed ?? partnerName} contrastSeed={characterSeed} running={partner?.status === 'running'} airborne={false} mini />
        </span>}
      </div>
      <div className="dash-course-head"><span>📍 LAGOS EXPRESS</span><span>{dashLevelLabelForBoard(mode, ranked)}</span></div>
      <div
        className="dash-stage"
        role="img"
        aria-label={`Three lane Lagos running track. ${upcoming.map(dashEventLabel).join('; ') || 'Clear track ahead.'}`}
        onPointerDown={(event) => { touchStartRef.current = { x: event.clientX, y: event.clientY }; }}
        onPointerUp={onTouchEnd}
        onPointerCancel={() => { touchStartRef.current = null; }}
        data-current-lane={state.lane}
      >
        <div className="dash-city" aria-hidden="true"><i /><i /><i /><i /><i /><b>IKORODU</b></div>
        <div className="dash-route-sign" aria-hidden="true">LAGOS<br /><small>→ ISLAND</small></div>
        <div className="dash-lanes" aria-hidden="true">
          {[0, 1, 2].map((lane) => <div className="dash-lane" key={lane}><span>{lane === 0 ? 'LEFT' : lane === 1 ? 'CENTRE' : 'RIGHT'}</span></div>)}
        </div>
        {upcoming.map((event) => {
          const gap = event.tick - state.ticks;
          const top = 10 + (gap / 28) * 59;
          if (event.kind === 'heart') {
            return <span className="dash-track-item dash-track-heart" key={`${event.tick}:${event.kind}`} style={{ left: `${(event.lane + 0.5) * 100 / 3}%`, top: `${top}%` }} aria-hidden="true">💗</span>;
          }
          return event.lanes.map((lane) => (
            <span className="dash-track-item dash-track-barrier" key={`${event.tick}:${lane}`} style={{ left: `${(lane + 0.5) * 100 / 3}%`, top: `${top}%` }} aria-hidden="true">🚧</span>
          ));
        })}
        <div className="dash-runner-position" style={{ left: `${(state.lane + 0.5) * 100 / 3}%` }}>
          <ChibiRunner seed={characterSeed ?? 'local-runner'} running={!state.ended && !away} airborne={state.jumpTicks > 0} />
        </div>
        <div className="dash-road-stripe" aria-hidden="true" />
        <span className="dash-distance-label" aria-hidden="true">{state.distance} m</span>
      </div>
      <ul className="dash-sr-only" aria-label="Upcoming course events">
        {upcoming.slice(0, 8).map((event) => <li key={`${event.tick}:${event.kind}`}>In {event.tick - state.ticks} metres: {dashEventLabel(event)}</li>)}
      </ul>
      <p className="dash-live-status" role="status" aria-live="polite">{status}</p>
      {ranked && partner && partner.status === 'running' && <p className="dash-partner-live">{partnerName} · {partner.distance ?? 0} m · {relativeFreshness(partner.last_seen)}</p>}
      {state.ended ? (
        <div className="dash-ended-actions">
          <strong>{endLabel(state.ended)} · {state.distance} m · 💗 {state.hearts}</strong>
          {ranked
            ? <small>{finishSaved ? 'Run saved to the shared course.' : 'Waiting for the server to confirm this result…'}</small>
            : <small>Free run · not saved or counted.</small>}
          {!ranked && <button type="button" onClick={onReplay}>Run again</button>}
          {ranked && <button type="button" className="dash-secondary" onClick={onExit}>Back to Games</button>}
        </div>
      ) : (
        <div className="dash-controls" aria-label="Runner controls">
          <button type="button" aria-label="Move to the left lane" onClick={() => steer('left')}>←<small>LEFT</small></button>
          <button type="button" className="dash-jump" aria-label="Jump over a barrier" onClick={() => steer('jump')}>↑<small>JUMP</small></button>
          <button type="button" aria-label="Move to the right lane" onClick={() => steer('right')}>→<small>RIGHT</small></button>
          {ranked && <button type="button" className="dash-exit" onClick={() => setShowLeave(true)}>Leave run</button>}
        </div>
      )}
      {showLeave && ranked && (
        <div className="dash-leave" role="dialog" aria-modal="true" aria-label="Forfeit Dash Duel">
          <div className="snake-leave-card">
            <h2>Leave your run?</h2>
            <p>{mode === 'together'
              ? `${partnerName} takes the live race if you leave.`
              : `Your score becomes zero. ${partnerName} can still run this same course later.`}</p>
            <div className="snake-leave-actions">
              <button type="button" onClick={() => setShowLeave(false)}>Keep running</button>
              <button type="button" className="snake-leave-danger" onClick={() => {
                setShowLeave(false);
                void onForfeit?.().then(onExit);
              }}>Leave and forfeit</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function dashLevelLabelForBoard(mode: 'challenge' | 'together' | 'free', ranked: boolean): string {
  if (!ranked || mode === 'free') return 'FREE RUN';
  return mode === 'together' ? 'LIVE RACE' : 'SHARED COURSE';
}

function ChibiRunner({ seed, contrastSeed, running, airborne, mini = false }: { seed: string; contrastSeed?: string; running: boolean; airborne: boolean; mini?: boolean }) {
  const outfitPalette = ['#ef7699', '#5597a6', '#e1a54c', '#8d79b9', '#60a483', '#db785e'];
  const colorIndex = (value: string) => {
    let hash = 0;
    for (let index = 0; index < value.length; index += 1) hash = (hash * 31 + value.charCodeAt(index)) | 0;
    return Math.abs(hash) % outfitPalette.length;
  };
  const playerColor = colorIndex(seed);
  const partnerColor = contrastSeed ? colorIndex(contrastSeed) : -1;
  const outfit = outfitPalette[mini && playerColor === partnerColor ? (playerColor + 1) % outfitPalette.length : playerColor];
  return (
    <svg className={`dash-chibi${mini ? ' dash-chibi-mini' : ''}${running ? ' is-running' : ''}${airborne ? ' is-airborne' : ''}`} viewBox="0 0 64 78" role="img" aria-label={mini ? 'Partner chibi runner' : 'Chibi runner'}>
      <ellipse cx="32" cy="73" rx="19" ry="4" fill="#362a2e" opacity=".24" />
      <path d="M25 56 18 68l-8 3 2 4 13-2 9-13M39 56l7 11 9 2-1 4-14 1-8-12" fill="#71433b" stroke="#60372f" strokeWidth="2" strokeLinejoin="round" />
      <path d="M21 37q11-7 22 0l3 19q-14 8-29 0z" fill={outfit} stroke="#714331" strokeWidth="2" />
      <path d="M24 42 15 51l-5-1-2 4 9 4 12-9M41 42l8 7 7-2 2 4-10 6-12-9" fill="#8b553d" stroke="#714331" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="24" r="17" fill="#9a6047" stroke="#704333" strokeWidth="2" />
      <path d="M15 24q-1-21 18-21 17 1 17 20-8-8-17-7-10 0-18 8" fill="#29222c" />
      <circle cx="26" cy="25" r="2" fill="#2b2025" /><circle cx="38" cy="25" r="2" fill="#2b2025" />
      <path d="M28 32q4 4 8 0" fill="none" stroke="#703b36" strokeWidth="2" strokeLinecap="round" />
      <path d="m46 16 5 4-5 3" fill="#29222c" />
      <circle cx="19" cy="29" r="3" fill="#f7a1a7" opacity=".7" /><circle cx="45" cy="29" r="3" fill="#f7a1a7" opacity=".7" />
      <path d="m22 37 10 7 10-7" fill="none" stroke="#fff0d7" strokeWidth="2" />
    </svg>
  );
}

export default DashDuel;
