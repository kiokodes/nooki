import { useState } from 'react';
import { GAMES, type GameMatch } from '../../lib/gamesService';
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
import { LastDuelRow, OngoingGames, type OngoingSlide } from './OngoingGames';
import { CHESS_MODES, type ChessMode } from '../../lib/chess';
import { DASH_LEVELS, dashLevelLabel, type DashLevel } from '../../lib/dash';
import {
  WORD_DURATIONS, WORD_LEVELS, WORD_LEVEL_LABELS, WORD_LEVEL_HINTS, wordDurationLabel,
  type WordDuration, type WordLevel,
} from '../../lib/wordWheel';
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

export function GamesView({ games, userId, partnerName, partnerOnline = false }: { games: GamesState; userId: string; partnerName: string; partnerOnline?: boolean }) {
  const [bestOf, setBestOf] = useState(3);
  const [mode, setMode] = useState<TetrisMode>('sprint');
  const [warmUp, setWarmUp] = useState<WarmUp | null>(null);
  const [sudokuOpen, setSudokuOpen] = useState(false);
  const [chessMode, setChessMode] = useState<ChessMode>('classic');
  const [dashLevel, setDashLevel] = useState<DashLevel>('steady');
  const [wordLevel, setWordLevel] = useState<WordLevel>('easy');
  const [wordSeconds, setWordSeconds] = useState<WordDuration>(60);
  const [dashFreePlay, setDashFreePlay] = useState(false);
  const [dashFreeSeed, setDashFreeSeed] = useState(0);
  const startDashFreePlay = () => { setDashFreeSeed(Date.now()); setDashFreePlay(true); };
  const m = games.match;
  const isX = m?.player_x === userId;
  const result = m?.finished ? (!m.winner_id ? 'A draw! Well played, both of you.' : m.winner_id === userId ? 'You won! 🎉' : `${partnerName} won! 🎉`) : '';
  const openMatch = (id: string | null) => { setWarmUp(null); setSudokuOpen(false); setDashFreePlay(false); games.select(id); };
  const startTetrisWarmUp = () => setWarmUp({ game: 'tetris', foods: [], pieces: dealPracticePieces(), nonce: Date.now() });
  const startSnakeWarmUp = () => setWarmUp({ game: 'snake', foods: dealPracticeFoods(), pieces: [], nonce: Date.now() });
  // Keep failed starts beside the button that was tapped, not above an offscreen header.
  const inlineErrorGame = !m && !sudokuOpen && !warmUp ? games.errorGame : null;
  /** The most recent *settled* duel of either kind, so its result stays reachable below the library. */
  const lastDuel = games.data?.matches?.find((match) => (match.game === 'snake' || match.game === 'tetris' || match.game === 'dash-duel' || match.game === 'word-wheel') && match.finished);
  /** The couple's live matches: still to be played, one swipe away in their own card. */
  const ongoing = (games.data?.matches ?? []).filter((match) => !match.finished && !runDuelConcluded(match));
  const ongoingSlides: OngoingSlide[] = ongoing.map((match) => ({
    id: match.id,
    name: GAMES.find(g => g.id === match.game)?.name ?? 'Game',
    statusLine: `${needsMyMove(match, userId) ? 'Your turn · ' : ''}With your partner →`,
  }));
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
  /** The name and score line for the "last duel" row, whichever game it was. */
  const lastDuelLine = lastDuel?.finished ? {
    name: GAMES.find(g => g.id === lastDuel.game)?.name ?? 'Duel',
    won: lastDuel.winner_id === userId,
    drawn: lastDuel.winner_id === null,
    mine: lastDuel.game === 'word-wheel'
      ? lastDuel.word?.mine.count ?? 0
      : lastDuel.snake?.mine?.score ?? lastDuel.tetris?.mine?.score ?? lastDuel.dash?.mine?.distance ?? 0,
    // Optional chaining all the way down: each duel's own column is absent until its
    // migration is installed, and a missing field is never shown as a claimed score.
    theirs: lastDuel.game === 'word-wheel'
      ? lastDuel.word?.partner.count ?? 0
      : lastDuel.snake?.partner?.score ?? lastDuel.tetris?.partner?.score ?? lastDuel.dash?.partner?.distance ?? 0,
    mineHearts: lastDuel.game === 'word-wheel' ? null : lastDuel.dash?.mine?.hearts ?? null,
    theirHearts: lastDuel.game === 'word-wheel' ? null : lastDuel.dash?.partner?.hearts ?? null,
    words: lastDuel.game === 'word-wheel',
  } : null;

  return <section className="games-view" aria-label="Games">
    <header><span className="games-eyebrow">A little lovers rivalry</span><h1>{m ? GAMES.find(g => g.id === m.game)?.name : dashFreePlay ? 'Dash Duel · Free run' : 'Play together'}</h1>{m && <p>Just for fun · unlimited rematches</p>}</header>
    {games.error && !inlineErrorGame && <GameError games={games} card />}
    {!games.data && !games.error && <p role="status">Loading your games…</p>}
    {m ? <>
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
    </> : dashFreePlay ? <>
      <button className="game-back" onClick={() => setDashFreePlay(false)}>← All games</button>
      <DashFreePlay level={dashLevel} seed={dashFreeSeed} onExit={() => setDashFreePlay(false)} />
    </> : sudokuOpen ? <>
      <button className="game-back" onClick={() => setSudokuOpen(false)}>← All games</button>
      <Sudoku partnerName={partnerName} onExit={() => setSudokuOpen(false)} />
    </> : warmUp ? <>
      <button className="game-back" onClick={() => setWarmUp(null)}>← All games</button>
      {practice}
    </> : <>
      {/* Ongoing games live in their own swipeable card — ten open matches are ten
          swipes, not ten screens. Finished duels are history and sit below the library,
          never among the games that can still be played. */}
      <OngoingGames slides={ongoingSlides} onOpen={openMatch} />
      {lastDuelLine && <LastDuelRow
        name={lastDuelLine.name}
        outcome={`${lastDuelLine.won ? 'You won' : lastDuelLine.drawn ? 'A draw' : `${partnerName} won`} · You ${lastDuelLine.mine}${lastDuelLine.words ? ' words' : ''}${lastDuelLine.mineHearts === null ? '' : ` 💗 ${lastDuelLine.mineHearts}`} — ${lastDuelLine.theirs}${lastDuelLine.words ? ' words' : ''}${lastDuelLine.theirHearts === null ? '' : ` 💗 ${lastDuelLine.theirHearts}`} ${partnerName} →`}
        onOpen={() => openMatch(lastDuel?.id ?? null)}
      />}
      {GAMES.map(game => (
        <article className="game-card" key={game.id} data-game={game.id}>
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
                ? game.id === 'snake' || game.id === 'tetris' ? 'Opening duel…' : game.id === 'word-wheel' ? 'Setting the wheel…' : 'Opening game…'
                : game.id === 'snake' || game.id === 'tetris' ? `Duel ${partnerName} →` : game.id === 'word-wheel' ? `Set the wheel for ${partnerName} →` : game.id === 'sudoku' ? 'Play →' : game.id === 'chess' ? `Play Chess with ${partnerName} →` : `Play with ${partnerName} →`}
            </button>
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
      ))}
      <p className="game-hint">Games are always open for a rematch.</p>
    </>}
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
