import { requireSupabase } from './supabaseClient';
export const GAMES = [
  { id: 'tic-tac-toe', name: 'Tic Tac Toe', icon: '✕ ◯', description: 'Three in a row. A little friendly rivalry.' },
  { id: 'rock-paper-scissors', name: 'Rock Paper Scissors', icon: '✊ ✋ ✌️', description: 'Pick in secret. Reveal together.' },
] as const;
export type GameId = typeof GAMES[number]['id'];
export interface GameMatch {
  id: string; game: GameId; daily_date: string | null; player_x: string; player_o: string;
  board: string[]; turn_id: string; best_of: number; round: number; score_x: number; score_o: number;
  my_pick: string | null; partner_locked: boolean; finished: boolean; winner_id: string | null;
  rounds: { round: number; x: string; o: string; winner: string | null }[];
}
export interface GamesSnapshot { today: string; wins: Record<string, number>; matches: GameMatch[] }
async function rpc<T>(name: string, args = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) {
    if (['PGRST202', '42P01', '42883'].includes(error.code)) throw new Error('Games needs a database update. Apply migration 202610150007_games.sql.');
    throw new Error(error.message);
  }
  return data as T;
}
export const fetchGames = () => rpc<GamesSnapshot>('games_state');
export const startGame = (game: GameId, daily: boolean, bestOf: number) => rpc<string>('start_game', { p_game: game, p_daily: daily, p_best_of: bestOf });
export const playGame = (match: GameMatch, move: string) => rpc<void>('play_game', { p_id: match.id, p_round: match.round, p_move: move });
