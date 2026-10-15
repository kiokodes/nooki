import { useState } from 'react';
import { GAMES } from '../../lib/gamesService';
import { needsMyMove, type GamesState } from '../../hooks/useGames';
import { dealPracticeFoods, type SnakePoint } from '../../lib/snake';
import { SnakeBoard } from './SnakeBoard';
import { SnakeDuel } from './SnakeDuel';
import { Sudoku } from './Sudoku';
import './games.css';

/** A practice run in progress: its own food, dealt on this phone and never reported. */
interface WarmUp { foods: SnakePoint[]; nonce: number }

export function GamesView({ games, userId, partnerName }: { games: GamesState; userId: string; partnerName: string }) {
  const [bestOf, setBestOf] = useState(3);
  const [warmUp, setWarmUp] = useState<WarmUp | null>(null);
  const [sudokuOpen, setSudokuOpen] = useState(false);
  const m = games.match;
  const isX = m?.player_x === userId;
  const result = m?.finished ? (!m.winner_id ? 'A draw! Well played, both of you.' : m.winner_id === userId ? 'You won! 🎉' : `${partnerName} won! 🎉`) : '';
  const openMatch = (id: string | null) => { setWarmUp(null); setSudokuOpen(false); games.select(id); };
  const startWarmUp = () => setWarmUp({ foods: dealPracticeFoods(), nonce: Date.now() });
  /** The most recent snake duel, so its result stays reachable after it leaves the list. */
  const lastDuel = games.data?.matches.find((match) => match.game === 'snake');
  // A warm-up stands in for whatever the Games tab was showing: the duel panel, or the
  // whole library. It is the same board either way, and it never touches the database.
  // It yields the moment the duel is decided: nobody wants to be practising through the
  // reveal of who won.
  const practice = warmUp && !m?.finished ? <>
    <SnakeBoard key={warmUp.nonce} foods={warmUp.foods} warmUp onExit={() => setWarmUp(null)} onRestart={startWarmUp} />
    <p className="game-hint">A warm-up is yours alone: it is never reported, and it never scores.</p>
  </> : null;

  return <section className="games-view" aria-label="Games">
    <header><span className="games-eyebrow">A little friendly rivalry</span><h1>{m ? GAMES.find(g => g.id === m.game)?.name : 'Play together'}</h1>{m && <p>{m.daily_date ? `Daily challenge · ${m.daily_date} (UTC)` : 'Just for fun · unlimited rematches'}</p>}</header>
    {games.error && <div role="alert" className="game-card"><p>{games.error}</p><button onClick={() => void games.refresh()}>Retry connection</button></div>}
    {!games.data && !games.error && <p role="status">Loading your games…</p>}
    {m ? <>
      <button className="game-back" onClick={() => openMatch(null)}>← All games</button>
      {practice ?? (m.game === 'snake' ? (
        <SnakeDuel
          match={m}
          userId={userId}
          partnerName={partnerName}
          games={games}
          onWarmUp={startWarmUp}
          onWarmUpSkip={() => setWarmUp(null)}
        />
      ) : (
      <div className="game-card">
        <p className="game-status" role="status">{result || (m.game === 'tic-tac-toe' ? (m.turn_id === userId ? 'Your turn' : `Waiting for ${partnerName}…`) : m.my_pick ? `Your ${m.my_pick} is locked. Waiting for ${partnerName}…` : m.partner_locked ? `${partnerName} has locked in. Your pick?` : 'Make your secret pick.')}</p>
        {m.game === 'tic-tac-toe' ? <>
          <p>You are {isX ? 'X' : 'O'} · {partnerName} is {isX ? 'O' : 'X'}</p>
          <div className="ttt-board" role="group" aria-label="Tic Tac Toe board">
            {m.board.map((cell, i) => <button key={i} aria-label={`Row ${Math.floor(i / 3) + 1}, column ${i % 3 + 1}: ${cell || 'empty'}`} disabled={games.busy || m.finished || !!cell || m.turn_id !== userId} onClick={() => void games.play(m, String(i))}>{cell}</button>)}
          </div><p className="game-hint">Get three in a row, column or diagonal.</p>
        </> : <>
          <div className="game-score">You {isX ? m.score_x : m.score_o} <span>—</span> {isX ? m.score_o : m.score_x} {partnerName}</div>
          <p>Best of {m.best_of} · First to {Math.ceil(m.best_of / 2)} wins · Ties don’t count</p>
          {!m.finished && <><h3>Round {m.round}</h3><div className="rps-picks">{[['rock','✊'],['paper','✋'],['scissors','✌️']].map(([pick, icon]) => <button key={pick} disabled={games.busy || !!m.my_pick} onClick={() => void games.play(m, pick)}><span aria-hidden="true">{icon}</span>{pick}</button>)}</div><p className="game-hint">Tap to lock in. Neither pick is revealed until both are in.</p></>}
          {!!m.rounds.length && <div aria-live="polite"><h3>The reveal</h3>{[...m.rounds].reverse().map(r => <div className="game-round" key={r.round}><strong>Round {r.round} · {r.winner ? r.winner === userId ? 'You win' : `${partnerName} wins` : 'Tie — go again'}</strong><p>You: {isX ? r.x : r.o} · {partnerName}: {isX ? r.o : r.x}</p></div>)}</div>}
        </>}
        {m.finished && (m.daily_date ? <p>Today’s challenge is complete. Come back after midnight UTC for another, or play freely in Games.</p> : <button disabled={games.busy} onClick={() => void games.start(m.game, false, m.best_of)}>Play again</button>)}
      </div>
      ))}
    </> : sudokuOpen ? <>
      <button className="game-back" onClick={() => setSudokuOpen(false)}>← All games</button>
      <Sudoku partnerName={partnerName} onExit={() => setSudokuOpen(false)} />
    </> : warmUp ? <>
      <button className="game-back" onClick={() => setWarmUp(null)}>← All games</button>
      {practice}
    </> : <>
      {games.data?.matches.filter(match => !match.finished).map(match => <button className="game-card game-resume" key={match.id} onClick={() => openMatch(match.id)}>Resume {GAMES.find(g => g.id === match.game)?.name} <small>{needsMyMove(match, userId) ? 'Your turn · ' : ''}{match.daily_date ? `Daily · ${match.daily_date}` : 'With your partner'} →</small></button>)}
      {lastDuel?.finished && <button className="game-card game-resume" onClick={() => openMatch(lastDuel.id)} data-last-duel>Last Snake Duel <small>{lastDuel.winner_id === userId ? 'You won' : lastDuel.winner_id ? `${partnerName} won` : 'A draw'} · You {lastDuel.snake?.mine?.score ?? 0} — {lastDuel.snake?.partner.score ?? 0} {partnerName} →</small></button>}
      {GAMES.map(game => <article className="game-card" key={game.id}><div className="game-icon" aria-hidden="true">{game.icon}</div><h2>{game.name}</h2><p>{game.description}</p>{game.id === 'rock-paper-scissors' && <fieldset><legend>Match length</legend>{[3,5].map(n => <button key={n} aria-pressed={bestOf === n} onClick={() => setBestOf(n)}>Best of {n}</button>)}</fieldset>}<button disabled={games.busy || !games.data} onClick={() => game.id === 'sudoku' ? setSudokuOpen(true) : void games.start(game.id, false, bestOf)}>{game.id === 'snake' ? `Duel ${partnerName} →` : game.id === 'sudoku' ? 'Play Sudoku →' : `Play with ${partnerName} →`}</button>{game.id === 'snake' && <button className="snake-secondary" disabled={games.busy || !games.data} onClick={startWarmUp} data-action="library-warm-up">Warm-up run (not counted)</button>}
      {game.id === 'sudoku' && <button className="snake-secondary" disabled={games.busy || !games.data} onClick={() => setSudokuOpen(true)} data-action="library-sudoku">Play Sudoku →</button>}</article>)}
      <p className="game-hint">Games are always open for a rematch. Today’s Challenge on Home is one shared match per day.</p>
    </>}
  </section>;
}
