import { requireSupabase } from './supabaseClient';
import type { SnakeChange, SnakePoint } from './snake';
import { isSnakeDirection } from './snake';
import type { TetrisInput, TetrisMode } from './tetris';
import { isTetrisAction } from './tetris';

export const GAMES = [
  { id: 'tic-tac-toe', name: 'Tic Tac Toe', icon: '✕ ◯', description: 'Three in a row. A little friendly rivalry.' },
  { id: 'rock-paper-scissors', name: 'Rock Paper Scissors', icon: '✊ ✋ ✌️', description: 'Pick in secret. Reveal together.' },
  {
    id: 'snake',
    name: 'Snake Duel',
    icon: '🐍',
    description: 'One run each, highest score wins. No pause — leaving forfeits the duel.',
  },
  {
    id: 'tetris',
    name: 'Tetris Duel',
    icon: '🧱',
    description: 'Five minutes each, same pieces. Highest score, or last one stacking.',
  },
] as const;
export type GameId = typeof GAMES[number]['id'];

/** How a partner's half of a snake duel reads, without ever showing a sealed score. */
export interface SnakeSide {
  status: 'waiting' | 'running' | 'done' | 'forfeit';
  ended: string | null;
  /** Only present once the duel is over: a blind duel keeps the score sealed until then. */
  score?: number | null;
  /** Only present while they are actually playing, so you can tell they are on it. */
  last_seen?: string | null;
}

/** This phone's own run: the food the database dealt, and everything reported so far. */
export interface SnakeRun extends SnakeSide {
  score: number;
  ticks: number;
  /** Direction changes already reported, `[tick, direction]` pairs. */
  dirs: [number, string][];
  /** The run's whole food sequence, `[x, y]` cells, in the order they appear. */
  foods: [number, number][];
  started_at: string;
  last_seen: string;
  deadline: string;
  /** Set when the run is over: `wall`, `self`, `cap` (time up) or `forfeit`. */
  ended: string | null;
}

export interface SnakeDuel {
  mine: SnakeRun | null;
  partner: SnakeSide;
}

/** How a partner's half of a Tetris duel reads, without ever showing a sealed score. */
export interface TetrisSide {
  status: 'waiting' | 'running' | 'done' | 'forfeit';
  ended: string | null;
  /** Only present once the duel is over: a blind duel keeps the score sealed until then. */
  score?: number | null;
  /** Lines cleared, and how many ticks the run lasted. Only once it is over. */
  lines?: number | null;
  ticks?: number | null;
  /** Only present while they are actually playing, so you can tell they are on it. */
  last_seen?: string | null;
}

/** This phone's own run: the pieces the database dealt, and everything reported so far. */
export interface TetrisRun extends TetrisSide {
  score: number;
  lines: number;
  ticks: number;
  /** Taps already reported, `[tick, action]` pairs. */
  inputs: [number, string][];
  /** The duel's whole piece sequence, 0–6, in the order they appear. */
  pieces: number[];
  started_at: string;
  last_seen: string;
  deadline: string;
  /** Set when the run is over: `top` (the well filled), `cap` (time up) or `forfeit`. */
  ended: string | null;
}

export interface TetrisDuel {
  /** Which of the two ways this duel is settled. Fixed when the duel was started. */
  mode: TetrisMode | null;
  mine: TetrisRun | null;
  partner: TetrisSide;
}

export interface GameMatch {
  id: string; game: GameId; daily_date: string | null; player_x: string; player_o: string;
  board: string[]; turn_id: string; best_of: number; round: number; score_x: number; score_o: number;
  my_pick: string | null; partner_locked: boolean; finished: boolean; winner_id: string | null;
  rounds: { round: number; x: string; o: string; winner: string | null }[];
  /** Present on snake duels only: the run this phone may play, and the partner's status. */
  snake?: SnakeDuel | null;
  /** Present on Tetris duels only: this phone's run, the partner's status and the mode. */
  tetris?: TetrisDuel | null;
}
export interface GamesSnapshot { today: string; wins: Record<string, number>; matches: GameMatch[] }
async function rpc<T>(name: string, args = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) {
    if (['PGRST202', '42P01', '42883'].includes(error.code)) {
      throw new Error(name.startsWith('snake')
        ? 'Snake needs a database update. Apply migration 202610150010_snake_duel.sql.'
        : name.startsWith('tetris')
          ? 'Tetris needs a database update. Apply migration 202610150011_tetris_duel.sql.'
          : 'Games needs a database update. Apply migration 202610150007_games.sql.');
    }
    throw new Error(error.message);
  }
  return data as T;
}
export const fetchGames = () => rpc<GamesSnapshot>('games_state');
/** `mode` is the Tetris duel's way of settling it, and is ignored by every other game. */
export const startGame = (game: GameId, daily: boolean, bestOf: number, mode: TetrisMode | null = null) =>
  rpc<string>('start_game', { p_game: game, p_daily: daily, p_best_of: bestOf, p_mode: mode });
export const playGame = (match: GameMatch, move: string) => rpc<void>('play_game', { p_id: match.id, p_round: match.round, p_move: move });

/* ---------------------------------------------------------------------------
   Snake duel. The run lives in the database, not in the phone: the food is
   dealt once at the start, the phone reports its direction changes as it goes,
   and the database replays them to work out what the run really scored. See
   supabase/migrations/202610150010_snake_duel.sql.
   --------------------------------------------------------------------------- */

/** The direction changes a phone reports, as the wire shape the database stores. */
export const snakeChangeRows = (changes: SnakeChange[]): [number, string][] => changes.map((change) => [change.tick, change.dir]);

/** The food sequence the database dealt, as board cells. */
export function snakePoints(foods: [number, number][] | undefined): SnakePoint[] {
  if (!Array.isArray(foods)) return [];
  return foods
    .filter((cell) => Array.isArray(cell) && cell.length === 2)
    .map(([x, y]) => ({ x: Number(x), y: Number(y) }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
}

/** A run's reported history, as the core's own move list. */
export function snakeChanges(dirs: [number, string][] | undefined): SnakeChange[] {
  if (!Array.isArray(dirs)) return [];
  const changes: SnakeChange[] = [];
  for (const row of dirs) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const tick = Number(row[0]);
    if (!Number.isInteger(tick) || tick < 0 || !isSnakeDirection(row[1])) continue;
    changes.push({ tick, dir: row[1] });
  }
  return changes;
}

export const startSnakeRun = (id: string) => rpc<SnakeRun>('snake_start', { p_id: id });
export const beatSnakeRun = (id: string, ticks: number, changes: SnakeChange[]) =>
  rpc<SnakeRun>('snake_beat', { p_id: id, p_ticks: ticks, p_dirs: snakeChangeRows(changes) });
export const finishSnakeRun = (id: string, ticks: number, changes: SnakeChange[]) =>
  rpc<SnakeRun>('snake_finish', { p_id: id, p_ticks: ticks, p_dirs: snakeChangeRows(changes) });
export const forfeitSnakeRun = (id: string) => rpc<SnakeRun>('snake_forfeit', { p_id: id });

/* ---------------------------------------------------------------------------
   Tetris duel. The same bargain as the snake duel, and the same reason for it:
   the database deals the pieces, the phone reports nothing but its taps, and
   the database replays them to work out what the run really scored. See
   supabase/migrations/202610150011_tetris_duel.sql.
   --------------------------------------------------------------------------- */

/** The taps a phone reports, as the wire shape the database stores. */
export const tetrisInputRows = (inputs: TetrisInput[]): [number, string][] => inputs.map((input) => [input.tick, input.action]);

/** The duel's piece sequence, as tetromino kinds. */
export function tetrisPieces(pieces: number[] | undefined): number[] {
  if (!Array.isArray(pieces)) return [];
  return pieces.filter((kind) => Number.isInteger(kind) && kind >= 0 && kind < 7).map((kind) => Number(kind));
}

/** A run's reported history, as the core's own tap list. */
export function tetrisInputs(inputs: [number, string][] | undefined): TetrisInput[] {
  if (!Array.isArray(inputs)) return [];
  const list: TetrisInput[] = [];
  for (const row of inputs) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const tick = Number(row[0]);
    if (!Number.isInteger(tick) || tick < 0 || !isTetrisAction(row[1])) continue;
    list.push({ tick, action: row[1] });
  }
  return list;
}

export const startTetrisRun = (id: string) => rpc<TetrisRun>('tetris_start', { p_id: id });
export const beatTetrisRun = (id: string, ticks: number, inputs: TetrisInput[]) =>
  rpc<TetrisRun>('tetris_beat', { p_id: id, p_ticks: ticks, p_inputs: tetrisInputRows(inputs) });
export const finishTetrisRun = (id: string, ticks: number, inputs: TetrisInput[]) =>
  rpc<TetrisRun>('tetris_finish', { p_id: id, p_ticks: ticks, p_inputs: tetrisInputRows(inputs) });
export const forfeitTetrisRun = (id: string) => rpc<TetrisRun>('tetris_forfeit', { p_id: id });
