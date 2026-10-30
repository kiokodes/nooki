import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { GAMES, type GameMatch } from '../../lib/gamesService';
import { GAME_LIBRARY, type GameEntry, type GuestEntry, type LibraryEntry } from '../../lib/gameLibrary';
import { needsMyMove, type GamesState } from '../../hooks/useGames';
import { dealPracticeFoods, type SnakePoint } from '../../lib/snake';
import { dealPracticePieces, tetrisModeLabel, type TetrisMode } from '../../lib/tetris';
import { SnakeBoard } from './SnakeBoard';
import { SnakeDuel } from './SnakeDuel';
import { TetrisBoard } from './TetrisBoard';
import { TetrisDuel } from './TetrisDuel';
import { Sudoku } from './Sudoku';
import { ChessDuel } from './ChessDuel';
import { ConnectFour } from './ConnectFour';
import { DashDuel, DashFreePlay } from './DashDuel';
import { WordWheel } from './WordWheel';
import { TruthOrDare } from './TruthOrDare';
import type { TruthOrDareState } from '../../hooks/useTruthOrDare';
import { OngoingGames, type OngoingSlide } from './OngoingGames';
import { CHESS_MODES, type ChessMode } from '../../lib/chess';
import { DASH_LEVELS, dashLevelLabel, type DashLevel } from '../../lib/dash';
import {
  WORD_DURATIONS, WORD_LEVELS, WORD_LEVEL_LABELS, WORD_LEVEL_HINTS, wordDurationLabel,
  type WordDuration, type WordLevel,
} from '../../lib/wordWheel';
import { dealPracticeWordSession, type WordPracticeSession } from '../../lib/wordWheelPractice';
import './games.css';

/** A practice run in progress: its own pieces or food, dealt on this phone and never reported. */
interface WarmUp {
  game: 'snake' | 'tetris';
  foods: SnakePoint[];
  pieces: number[];
  nonce: number;
}

/**
 * A duel whose two runs are in is no longer ongoing — it is waiting on the referee, at
 * most one poll away. Listing it as "Resume" in the meantime is the one thing a couple
 * must never see: they have both played, and the card claims the game is still going.
 */
function runDuelConcluded(match: GameMatch): boolean {
  const duel = match.game === 'tetris' ? match.tetris : match.game === 'snake' ? match.snake : match.game === 'dash-duel' ? match.dash : null;
  if (!duel) return false;
  const mineIn = !!duel.mine && !['running', 'ready'].includes(duel.mine.status);
  const theirsIn = duel.partner.status !== 'waiting' && duel.partner.status !== 'running' && duel.partner.status !== 'ready';
  return mineIn && theirsIn;
}

export function GamesView({ games, userId, coupleId, partnerId, partnerName, partnerOnline = false, truthOrDare }: {
  games: GamesState;
  userId: string;
  coupleId: string;
  partnerId: string;
  partnerName: string;
  partnerOnline?: boolean;
  truthOrDare?: TruthOrDareState;
}) {
  const [bestOf, setBestOf] = useState(3);
  const [mode, setMode] = useState<TetrisMode>('sprint');
  const [warmUp, setWarmUp] = useState<WarmUp | null>(null);
  const [sudokuOpen, setSudokuOpen] = useState(false);
  const [chessMode, setChessMode] = useState<ChessMode>('classic');
  const [dashLevel, setDashLevel] = useState<DashLevel>('steady');
  const [wordLevel, setWordLevel] = useState<WordLevel>('easy');
  const [wordSeconds, setWordSeconds] = useState<WordDuration>(60);
  const [wordPracticeSession, setWordPracticeSession] = useState<WordPracticeSession | null>(null);
  const [wordPracticeLoading, setWordPracticeLoading] = useState(false);
  const [wordPracticeError, setWordPracticeError] = useState<string | null>(null);
  const [libraryIndex, setLibraryIndex] = useState(0);
  const [libraryDirection, setLibraryDirection] = useState<'next' | 'prev'>('next');
  const [dashFreePlay, setDashFreePlay] = useState(false);
  const [truthOrDareOpen, setTruthOrDareOpen] = useState(false);
  const [dashFreeSeed, setDashFreeSeed] = useState(0);
  const startDashFreePlay = () => { setDashFreeSeed(Date.now()); setDashFreePlay(true); };
  const startWordPractice = async (level = wordLevel, seconds = wordSeconds) => {
    if (wordPracticeLoading) return;
    setWordPracticeLoading(true);
    setWordPracticeError(null);
    try {
      const session = await dealPracticeWordSession(level, seconds);
      setWarmUp(null);
      setSudokuOpen(false);
      setDashFreePlay(false);
      setWordPracticeSession(session);
    } catch (error) {
      setWordPracticeError((error as Error).message);
    } finally {
      setWordPracticeLoading(false);
    }
  };
  const activeEntry = GAME_LIBRARY[libraryIndex] ?? GAME_LIBRARY[0];
  const selectGame = (index: number) => {
    if (index === libraryIndex) return;
    setLibraryDirection(index > libraryIndex ? 'next' : 'prev');
    setLibraryIndex(index);
  };
  const m = games.match;
  const isX = m?.player_x === userId;
  const result = m?.finished ? (!m.winner_id ? 'A draw! Well played, both of you.' : m.winner_id === userId ? 'You won! 🎉' : `${partnerName} won! 🎉`) : '';
  const openMatch = (id: string | null) => { setWarmUp(null); setSudokuOpen(false); setDashFreePlay(false); setWordPracticeSession(null); games.select(id); };
  const startTetrisWarmUp = () => setWarmUp({ game: 'tetris', foods: [], pieces: dealPracticePieces(), nonce: Date.now() });
  const startSnakeWarmUp = () => setWarmUp({ game: 'snake', foods: dealPracticeFoods(), pieces: [], nonce: Date.now() });
  // Keep failed starts beside the button that was tapped, not above an offscreen header.
  const inlineErrorGame = !m && !sudokuOpen && !warmUp ? games.errorGame : null;
  /**
   * The couple's live matches: games still to be played, one swipe away in their own
   * card. A duel whose two runs are in is waiting on the referee, not on a player, and
   * a settled one is history — neither belongs here.
   */
  const ongoing = (games.data?.matches ?? []).filter((match) => !match.finished && !runDuelConcluded(match));
  const ongoingSlides: OngoingSlide[] = ongoing.map((match) => {
    const mine = needsMyMove(match, userId);
    return {
      id: match.id,
      name: GAMES.find(g => g.id === match.game)?.name ?? 'Game',
      waitingOn: mine ? 'me' : 'partner',
      statusLine: mine ? 'Your move' : `Waiting for ${partnerName}`,
    };
  });
  // A warm-up stands in for whatever the Games tab was showing: the duel panel, or the
  // whole library. It is the same board either way, and it never touches the database.
  // It yields the moment the duel is decided: nobody wants to be practising through the
  // reveal of who won.
  const practice = warmUp && !m?.finished ? <>
    {warmUp.game === 'tetris'
      ? <TetrisBoard key={warmUp.nonce} pieces={warmUp.pieces} warmUp onExit={() => setWarmUp(null)} onRestart={startTetrisWarmUp} />
      : <SnakeBoard key={warmUp.nonce} foods={warmUp.foods} warmUp onExit={() => setWarmUp(null)} onRestart={startSnakeWarmUp} />}
    <p className="game-hint">A warm-up is yours alone: it is never reported, and it never scores.</p>
  </> : null;
  const practiceMatch: GameMatch | null = wordPracticeSession ? {
    id: wordPracticeSession.id,
    game: 'word-wheel',
    player_x: userId,
    player_o: 'practice-partner',
    turn_id: userId,
    best_of: 1,
    round: 1,
    score_x: 0,
    score_o: 0,
    my_pick: null,
    partner_locked: false,
    finished: wordPracticeSession.round.status === 'finished',
    winner_id: null,
    rounds: [],
    word: wordPracticeSession.round,
  } : null;
  const finishWordPractice = (words: string[], finishedMs: number) => {
    setWordPracticeSession((current) => current ? {
      ...current,
      round: {
        ...current.round,
        status: 'finished',
        mine: {
          ...current.round.mine,
          submitted: true,
          words,
          count: words.length,
          finished_ms: finishedMs,
        },
      },
    } : current);
  };
  /** Whether a shared round is already open, shown on the Truth or Dare chip's panel. */
  const truthOrDareRound = truthOrDare?.snapshot?.round ?? null;
  const truthOrDareStatus = !truthOrDareRound ? null
    : truthOrDareRound.status === 'paused' ? 'Round paused'
      : truthOrDareRound.status === 'inviting' ? 'Waiting for both partners to join'
        : 'Round in progress';
  /** Truth or Dare's panel: the way into its own shared round, never a card above the rail. */
  const renderTruthOrDareCard = (entry: GuestEntry) => (
    <article
      className="game-card game-panel tod-panel"
      key={entry.id}
      data-game={entry.id}
      data-direction={libraryDirection}
      role="tabpanel"
      id={`game-panel-${entry.id}`}
      aria-labelledby={`game-tab-${entry.id}`}
    >
      <div className="game-icon game-icon-glyph" aria-hidden="true">{entry.icon}</div>
      <h2>{entry.name}</h2>
      <p>{entry.description}</p>
      {truthOrDareStatus && <p className="tod-panel-status" role="status">{truthOrDareStatus}</p>}
      <div className="game-actions">
        <button
          type="button"
          disabled={!truthOrDare}
          onClick={() => setTruthOrDareOpen(true)}
        >
          {!truthOrDare
            ? 'Opening your shared room…'
            : truthOrDareRound ? 'Resume round →' : 'Choose a theme →'}
        </button>
      </div>
      <p className="game-hint">Both phones play the same round. Either of you can pause or end it.</p>
    </article>
  );
  /** Raise a Child's panel: a reserved seat until its rules are written. */
  const renderRaiseAChildCard = (entry: GuestEntry) => (
    <article
      className="game-card game-panel raise-a-child-panel"
      key={entry.id}
      data-game={entry.id}
      data-direction={libraryDirection}
      role="tabpanel"
      id={`game-panel-${entry.id}`}
      aria-labelledby={`game-tab-${entry.id}`}
    >
      <div className="game-icon game-icon-glyph" aria-hidden="true">{entry.icon}</div>
      <h2>{entry.name} <span className="game-soon-chip">In the works</span></h2>
      <p>{entry.description}</p>
      <p className="game-hint" id="raise-a-child-note">
        A placeholder for now: the milestones, the choices and how the two of you raise a
        little one together are still being written.
      </p>
      <div className="game-actions">
        <button type="button" disabled aria-describedby="raise-a-child-note">Coming soon</button>
      </div>
    </article>
  );
  /** The panel under the rail, whatever kind of entry is chosen there. */
  const renderLibraryPanel = () => activeEntry.kind === 'truth-or-dare'
    ? renderTruthOrDareCard(activeEntry)
    : activeEntry.kind === 'raise-a-child'
      ? renderRaiseAChildCard(activeEntry)
      : renderGameCard(activeEntry);
  /** One game's settings and call to action, shown for the game picked in the rail. */
  const renderGameCard = (game: GameEntry) => (
    <article
      className="game-card game-panel"
      key={game.id}
      data-game={game.id}
      data-direction={libraryDirection}
      role="tabpanel"
      id={`game-panel-${game.id}`}
      aria-labelledby={`game-tab-${game.id}`}
    >
      <div className="game-icon" aria-hidden="true">{game.icon}</div>
      <h2>{game.name}</h2>
      <p>{game.description}</p>
      {game.id === 'rock-paper-scissors' && (
        <fieldset>
          <legend>Match length</legend>
          {[3, 5].map(n => <button key={n} type="button" aria-pressed={bestOf === n} onClick={() => setBestOf(n)}>Best of {n}</button>)}
        </fieldset>
      )}
      {game.id === 'chess' && (
        <fieldset>
          <legend>Choose your duel</legend>
          {CHESS_MODES.map(modeOption => (
            <button key={modeOption.id} type="button" aria-pressed={chessMode === modeOption.id} onClick={() => setChessMode(modeOption.id)}>
              {modeOption.icon} {modeOption.name}
            </button>
          ))}
        </fieldset>
      )}
      {game.id === 'tetris' && (
        <fieldset>
          <legend>How the duel is decided</legend>
          {(['sprint','survival'] as TetrisMode[]).map(option => <button key={option} type="button" aria-pressed={mode === option} onClick={() => setMode(option)} data-tetris-mode-option={option}>{tetrisModeLabel(option)}</button>)}
        </fieldset>
      )}
      {game.id === 'dash-duel' && (
        <fieldset className="dash-level-picker">
          <legend>Choose the course difficulty</legend>
          {DASH_LEVELS.map(option => <button key={option} type="button" aria-pressed={dashLevel === option} onClick={() => setDashLevel(option)}>{dashLevelLabel(option)}</button>)}
        </fieldset>
      )}
      {game.id === 'word-wheel' && (
        <>
          <fieldset className="word-level-picker">
            <legend>Choose the difficulty</legend>
            {WORD_LEVELS.map(option => (
              <button key={option} type="button" aria-pressed={wordLevel === option} onClick={() => setWordLevel(option)}>
                {WORD_LEVEL_LABELS[option]}
              </button>
            ))}
          </fieldset>
          <p className="game-hint word-level-hint">{WORD_LEVEL_HINTS[wordLevel]}</p>
          <fieldset className="word-duration-picker">
            <legend>How long is the round?</legend>
            {WORD_DURATIONS.map(option => (
              <button key={option} type="button" aria-pressed={wordSeconds === option} onClick={() => setWordSeconds(option)}>
                {wordDurationLabel(option)}
              </button>
            ))}
          </fieldset>
        </>
      )}
      {game.id === 'word-wheel' && wordPracticeError && <p className="word-error" role="alert">{wordPracticeError}</p>}
      {games.error && inlineErrorGame === game.id && <GameError games={games} />}
      {game.id === 'dash-duel' ? (
        <div className="game-actions dash-library-actions">
          <button type="button" disabled={games.busy || !games.data} aria-busy={games.pendingGame === game.id} onClick={() => void games.startDashDuel('challenge', dashLevel)}>
            {games.pendingGame === game.id ? 'Setting course…' : 'Set a challenge →'}
          </button>
          {partnerOnline && <button type="button" className="dash-together-button" disabled={games.busy || !games.data} onClick={() => void games.startDashDuel('together', dashLevel)}>
            Play together · online →
          </button>}
          <button type="button" className="snake-secondary" onClick={startDashFreePlay} data-action="dash-free-play">Free run · just for fun</button>
        </div>
      ) : <div className="game-actions">
        <button
          type="button"
          disabled={games.busy || (game.id !== 'sudoku' && !games.data)}
          aria-busy={games.pendingGame === game.id}
          onClick={() => game.id === 'sudoku' ? setSudokuOpen(true) : game.id === 'chess' ? void games.startChess(chessMode) : game.id === 'tetris' ? void games.startTetrisDuel(mode) : game.id === 'connect-four' ? void games.startConnectFour() : game.id === 'word-wheel' ? void games.startWordRound(wordLevel, wordSeconds) : void games.start(game.id, bestOf)}
        >
          {games.pendingGame === game.id
            ? game.id === 'snake' || game.id === 'tetris' ? 'Opening duel…' : game.id === 'word-wheel' ? 'Setting async challenge…' : 'Opening game…'
            : game.id === 'snake' || game.id === 'tetris' ? `Duel ${partnerName} →` : game.id === 'word-wheel' ? `Challenge ${partnerName} asynchronously →` : game.id === 'sudoku' ? 'Play →' : game.id === 'chess' ? `Play Chess with ${partnerName} →` : `Play with ${partnerName} →`}
        </button>
        {game.id === 'word-wheel' && (
          <button type="button" className="snake-secondary" disabled={wordPracticeLoading} aria-busy={wordPracticeLoading} onClick={() => void startWordPractice()} data-action="word-wheel-practice">
            {wordPracticeLoading ? 'Loading practice puzzle…' : 'Practice solo · not counted'}
          </button>
        )}
        {game.id === 'snake' && (
          <button type="button" className="snake-secondary" disabled={games.busy} onClick={startSnakeWarmUp} data-action="library-warm-up">
            Warm-up run (not counted)
          </button>
        )}
        {game.id === 'tetris' && (
          <button type="button" className="tetris-secondary" disabled={games.busy} onClick={startTetrisWarmUp} data-action="library-warm-up-tetris">
            Warm-up run (not counted)
          </button>
        )}
      </div>}
    </article>
  );

  return <section className="games-view" aria-label="Games">
    <header><span className="games-eyebrow">{truthOrDareOpen ? 'A shared game · separate phones' : 'A little lovers rivalry'}</span><h1>{truthOrDareOpen ? 'Truth or Dare' : m ? GAMES.find(g => g.id === m.game)?.name : wordPracticeSession ? 'Word Wheel · Practice' : dashFreePlay ? 'Dash Duel · Free run' : 'Play together'}</h1>{m && <p>Just for fun · unlimited rematches</p>}</header>
    {!truthOrDareOpen && games.error && !inlineErrorGame && <GameError games={games} card />}
    {!truthOrDareOpen && !games.data && !games.error && <p role="status">Loading your games…</p>}
    {truthOrDareOpen && truthOrDare ? <TruthOrDare game={truthOrDare} userId={userId} partnerName={partnerName} onExit={() => setTruthOrDareOpen(false)} /> : m ? <>
      {!(m.game === 'dash-duel' && m.dash?.mine?.status === 'running') && <button className="game-back" onClick={() => openMatch(null)}>← All games</button>}
      {practice ?? (m.game === 'dash-duel' ? (
        <DashDuel match={m} userId={userId} partnerName={partnerName} partnerOnline={partnerOnline} games={games} onExit={() => openMatch(null)} />
      ) : m.game === 'word-wheel' ? (
        <WordWheel match={m} userId={userId} partnerName={partnerName} games={games} onExit={() => openMatch(null)} />
      ) : m.game === 'connect-four' ? (
        <ConnectFour match={m} userId={userId} partnerName={partnerName} busy={games.busy} onMove={(column) => void games.playConnectFour(m, column)} onExit={() => openMatch(null)} />
      ) : m.game === 'chess' ? (
        <ChessDuel
          partnerName={partnerName}
          onExit={() => openMatch(null)}
          online={{
            match: m,
            userId,
            busy: games.busy,
            onMove: (move) => void games.playChess(m, move),
            onRematch: (nextMode) => void games.startChess(nextMode),
          }}
        />
      ) : m.game === 'snake' ? (
        <SnakeDuel
          match={m}
          userId={userId}
          partnerName={partnerName}
          games={games}
          onWarmUp={startSnakeWarmUp}
          onWarmUpSkip={() => setWarmUp(null)}
        />
      ) : m.game === 'tetris' ? (
        <TetrisDuel
          match={m}
          userId={userId}
          partnerName={partnerName}
          games={games}
          onWarmUp={startTetrisWarmUp}
          onWarmUpSkip={() => setWarmUp(null)}
        />
      ) : (
        <div className="game-card">
          <p className="game-status" role="status">{result || (m.my_pick ? `Your ${m.my_pick} is locked. Waiting for ${partnerName}…` : m.partner_locked ? `${partnerName} has locked in. Your pick?` : 'Make your secret pick.')}</p>
          <div className="game-score">You {isX ? m.score_x : m.score_o} <span>—</span> {isX ? m.score_o : m.score_x} {partnerName}</div>
          <p>Best of {m.best_of} · First to {Math.ceil(m.best_of / 2)} wins · Ties don’t count</p>
          {!m.finished && <><h3>Round {m.round}</h3><div className="rps-picks">{[['rock','✊'],['paper','✋'],['scissors','✌️']].map(([pick, icon]) => <button key={pick} disabled={games.busy || !!m.my_pick} onClick={() => void games.play(m, pick)}><span aria-hidden="true">{icon}</span>{pick}</button>)}</div><p className="game-hint">Tap to lock in. Neither pick is revealed until both are in.</p></>}
          {!!m.rounds.length && <div aria-live="polite"><h3>The reveal</h3>{[...m.rounds].reverse().map(r => <div className="game-round" key={r.round}><strong>Round {r.round} · {r.winner ? r.winner === userId ? 'You win' : `${partnerName} wins` : 'Tie — go again'}</strong><p>You: {isX ? r.x : r.o} · {partnerName}: {isX ? r.o : r.x}</p></div>)}</div>}
          {m.finished && <button disabled={games.busy} onClick={() => void games.start(m.game, m.best_of)}>Play again</button>}
        </div>
      ))}
    </> : wordPracticeSession && practiceMatch ? <>
      <button className="game-back" onClick={() => setWordPracticeSession(null)}>← All games</button>
      <WordWheel
        match={practiceMatch}
        userId={userId}
        partnerName={partnerName}
        games={games}
        practice
        onPracticeSubmit={finishWordPractice}
        onPracticeAgain={() => void startWordPractice(wordPracticeSession.round.difficulty, wordPracticeSession.round.duration_seconds)}
        onExit={() => setWordPracticeSession(null)}
      />
    </> : dashFreePlay ? <>
      <button className="game-back" onClick={() => setDashFreePlay(false)}>← All games</button>
      <DashFreePlay level={dashLevel} seed={dashFreeSeed} onExit={() => setDashFreePlay(false)} />
    </> : sudokuOpen ? <>
      <button className="game-back" onClick={() => setSudokuOpen(false)}>← All games</button>
      <Sudoku coupleId={coupleId} userId={userId} partnerId={partnerId} partnerName={partnerName} partnerOnline={partnerOnline} onExit={() => setSudokuOpen(false)} />
    </> : warmUp ? <>
      <button className="game-back" onClick={() => setWarmUp(null)}>← All games</button>
      {practice}
    </> : <>
      {/* Exactly two things on this tab: the couple's live matches (one swipeable card
          however many are open) and the game catalogue under it. A settled duel, or one
          whose two runs are both in, is history and is not listed here at all. */}
      <OngoingGames slides={ongoingSlides} onOpen={openMatch} />
      <GameLibrary entries={GAME_LIBRARY} activeIndex={libraryIndex} onSelect={selectGame}>
        {renderLibraryPanel()}
      </GameLibrary>
    </>}
  </section>;
}

/** How far a panel has to travel before the swipe counts as a change of game. */
const SWIPE_COMMIT_PX = 48;

/**
 * The game library as a carousel: one row of game titles, one settings panel.
 *
 * The library used to be a single column of six full cards — every game's rules and
 * buttons stacked, so finding the one you wanted meant scrolling past five others. Now
 * the titles ride in a rail at the top (tapping one, or swiping the panel under it,
 * brings that game's settings and start button in) and only the chosen game takes up
 * room. The rail scrolls sideways when it outgrows the phone, keeps the chosen chip
 * centred, and answers the arrow keys.
 *
 * Every entry is a chip in that one rail — the duels from `GAMES` and the games that are
 * not duel rows (Truth or Dare, and the Raise a Child placeholder) alike, so no game gets
 * a card of its own above the carousel.
 */
function GameLibrary({ entries, activeIndex, onSelect, children }: {
  entries: LibraryEntry[];
  activeIndex: number;
  onSelect: (index: number) => void;
  children: ReactNode;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState(0);
  const dragRef = useRef(0);
  const gesture = useRef<{ x: number; y: number; id: number | null; moved: boolean }>({ x: 0, y: 0, id: null, moved: false });
  /** A swipe ends on top of the panel's buttons; the click it would fire is not wanted. */
  const swallowed = useRef(false);
  const clamp = (index: number) => Math.min(Math.max(index, 0), entries.length - 1);

  /* Keep the chosen chip in view as the thumb walks the rail. */
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof rail.scrollTo !== 'function') return;
    const chip = rail.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!chip) return;
    rail.scrollTo({ left: Math.max(0, chip.offsetLeft - (rail.clientWidth - chip.clientWidth) / 2), behavior: 'smooth' });
  }, [activeIndex]);

  const endGesture = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current.id === null) return;
    gesture.current = { x: 0, y: 0, id: null, moved: false };
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!current.moved) return;
    const travelled = dragRef.current;
    dragRef.current = 0;
    setDrag(0);
    // A drag that ends on a button is not that button's tap, whether or not it went far
    // enough to change the game.
    swallowed.current = true;
    window.setTimeout(() => { swallowed.current = false; }, 400);
    if (Math.abs(travelled) < SWIPE_COMMIT_PX) return;
    onSelect(clamp(activeIndex + (travelled < 0 ? 1 : -1)));
  };

  return <section className="game-library" aria-label="Game library">
    <div
      className="game-rail"
      data-game-rail
      ref={railRef}
      role="tablist"
      aria-label="Choose a game"
      onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === 'Home' ? 0
          : event.key === 'End' ? entries.length - 1
            : clamp(activeIndex + (event.key === 'ArrowRight' ? 1 : -1));
        onSelect(next);
        document.getElementById(`game-tab-${entries[next].id}`)?.focus();
      }}
    >
      {entries.map((entry, index) => (
        <button
          key={entry.id}
          type="button"
          role="tab"
          id={`game-tab-${entry.id}`}
          className="game-rail-tab"
          data-game-tab={entry.id}
          aria-selected={index === activeIndex}
          aria-controls={index === activeIndex ? `game-panel-${entry.id}` : undefined}
          tabIndex={index === activeIndex ? 0 : -1}
          onClick={() => onSelect(index)}
        >
          <span className="game-rail-icon" aria-hidden="true">{entry.icon}</span>
          <span>{entry.name}</span>
          {entry.kind === 'raise-a-child' && <span className="game-rail-badge">Soon</span>}
        </button>
      ))}
    </div>
    <div
      className={`game-panel-track${drag ? ' is-swiping' : ''}`}
      data-game-panel-track
      style={drag ? { transform: `translateX(${drag}px)` } : undefined}
      onPointerDown={(event) => {
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        gesture.current = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
      }}
      onPointerMove={(event) => {
        const current = gesture.current;
        if (current.id !== event.pointerId) return;
        const dx = event.clientX - current.x;
        const dy = event.clientY - current.y;
        if (!current.moved) {
          // Vertical drags belong to the page, and a small wobble is still a tap.
          if (Math.abs(dx) < 12 || Math.abs(dx) <= Math.abs(dy)) return;
          current.moved = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        const edge = (dx > 0 && activeIndex === 0) || (dx < 0 && activeIndex === entries.length - 1);
        const next = edge ? dx * 0.3 : dx;
        dragRef.current = next;
        setDrag(next);
      }}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onClickCapture={(event) => {
        if (!swallowed.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {children}
    </div>
    <p className="game-hint game-library-hint">Tap a game above, or swipe the card for the next one.</p>
  </section>;
}

function GameError({ games, card = false }: { games: GamesState; card?: boolean }) {
  return (
    <div role="alert" className={card ? 'game-card game-error' : 'game-error'}>
      <p>{games.error}</p>
      <button type="button" disabled={games.busy} onClick={() => void (games.retry ?? games.refresh)()}>
        {games.errorGame ? 'Try again' : 'Retry connection'}
      </button>
    </div>
  );
}
