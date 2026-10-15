import { requireSupabase } from './supabaseClient';
import type { SnakeChange, SnakePoint } from './snake';
import { isSnakeDirection } from './snake';

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
    id: 'sudoku',
    name: 'Sudoku',
    icon: '9️⃣',
    description: 'Fill the grid. Easy, medium or hard — solo, race your partner, or solve together.',
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

export interface GameMatch {
  id: string; game: GameId; daily_date: string | null; player_x: string; player_o: string;
  board: string[]; turn_id: string; best_of: number; round: number; score_x: number; score_o: number;
  my_pick: string | null; partner_locked: boolean; finished: boolean; winner_id: string | null;
  rounds: { round: number; x: string; o: string; winner: string | null }[];
  /** Present on snake duels only: the run this phone may play, and the partner's status. */
  snake?: SnakeDuel | null;
}
export interface GamesSnapshot { today: string; wins: Record<string, number>; matches: GameMatch[] }
const SNAKE_SETUP_ERROR = 'Snake Duel needs a database update. In Supabase SQL Editor, apply 202610150010_snake_duel.sql after 202610150007_games.sql, then run verify-games.sql and try again.';

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) {
    const snakeRequest = name.startsWith('snake_') || (name === 'start_game' && args.p_game === 'snake');
    // Migration 007's start_game exists, but only accepts the two original games.
    // This is not a missing-RPC error: it rejects a perfectly valid Duel button click.
    const legacySnakeStart = name === 'start_game' && args.p_game === 'snake'
      && args.p_daily === false && [3, 5].includes(Number(args.p_best_of))
      && ((error.code === 'P0001' && error.message === 'Invalid game settings.')
        || (error.code === '23514' && error.message.includes('game_matches_game_check')));
    if (legacySnakeStart) throw new Error(SNAKE_SETUP_ERROR);
    if (['PGRST202', '42P01', '42703', '42883'].includes(error.code)) {
      throw new Error(snakeRequest || error.message.includes('snake_')
        ? SNAKE_SETUP_ERROR
        : 'Games needs a database update. Apply migration 202610150007_games.sql, then 202610150010_snake_duel.sql.');
    }
    throw new Error(error.message);
  }
  return data as T;
}
export async function fetchGames(): Promise<GamesSnapshot> {
  const data = await rpc<GamesSnapshot>('games_state');
  if (!data || !Array.isArray(data.matches) || !data.wins || typeof data.wins !== 'object' || typeof data.today !== 'string') {
    throw new Error('Games returned an incomplete response. Retry the connection; if it persists, run supabase/verify-games.sql.');
  }
  return data;
}
export const startGame = (game: GameId, daily: boolean, bestOf: number) => rpc<string>('start_game', { p_game: game, p_daily: daily, p_best_of: bestOf });
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
