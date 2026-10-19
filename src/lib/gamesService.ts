import { requireSupabase } from './supabaseClient';
import type { SnakeChange, SnakePoint } from './snake';
import type { ChessColor, ChessEndReason, ChessPieceType, ChessState } from './chess';
import { isSnakeDirection } from './snake';
import type { TetrisInput, TetrisMode } from './tetris';
import { isTetrisAction } from './tetris';
import type { DashAction, DashCourseEvent, DashLevel } from './dash';
import { isDashAction, isDashLevel } from './dash';

export const GAMES = [
  { id: 'rock-paper-scissors', name: 'Rock Paper Scissors', icon: '✊ ✋ ✌️', description: 'Pick in secret. Reveal together.' },
  {
    id: 'snake',
    name: 'Snake Duel',
    icon: '🐍',
    description: 'One run each, highest score wins. No pause — leaving forfeits the duel.',
  },
  {
    id: 'chess',
    name: 'Chess',
    icon: '♞',
    description: 'Classic checkmate, a first-to-7-captures race, or a hunt for their queen.',
  },
  {
    id: 'sudoku',
    name: 'Sudoku',
    icon: '9️⃣',
    description: 'Fill the grid. Easy, medium or hard — solo, race your partner, or solve together.',
  },
  {
    id: 'tetris',
    name: 'Tetris Duel',
    icon: '🧱',
    description: 'Five minutes each, same pieces. Highest score, or last one stacking.',
  },
  { id: 'connect-four', name: 'Connect Four', icon: '🔴', description: 'Take turns whenever you have a moment. First to connect four wins.' },
  {
    id: 'dash-duel',
    name: 'Dash Duel',
    icon: '🏃',
    description: 'Three lanes, one Lagos track. Grab hearts, dodge barriers, and beat your partner’s distance.',
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

export type DashMatchMode = 'challenge' | 'together';
export type DashRunStatus = 'ready' | 'running' | 'done' | 'crash' | 'forfeit';

/** The other runner's server-confirmed, public race progress. */
export interface DashSide {
  status: 'waiting' | DashRunStatus;
  ended: string | null;
  distance?: number;
  hearts?: number;
  ticks?: number;
  last_seen?: string | null;
}

/** One attempt, reconstructed and scored by the database referee. */
export interface DashRun extends DashSide {
  status: DashRunStatus;
  distance: number;
  hearts: number;
  ticks: number;
  lane: number;
  jump_ticks: number;
  actions: [number, string][];
  started_at?: string;
  ready_at?: string;
  last_seen?: string;
  finished_at?: string;
}

/** Shared immutable course and this phone's attempt, plus the partner's live distance. */
export interface DashDuel {
  course_version: number;
  course: DashCourseEvent[];
  mode: DashMatchMode;
  level: DashLevel;
  created_by: string | null;
  mine: DashRun | null;
  partner: DashSide;
}

/** A chess match as the database reports it: the position, and only the position. */
export interface ChessSnapshot {
  mode: 'classic' | 'capture-race' | 'queen-hunt';
  /** 64 piece codes, index 0 = a8: `wP`, `bQ`, `wQ*` (a promoted queen), `''` empty. */
  board: string[];
  castling: string;
  en_passant: number | null;
  halfmove: number;
  captures: { white: string[]; black: string[] };
  history: string[];
  end_reason: string | null;
  drawn: boolean;
}

export interface GameMatch {
  id: string; game: GameId; player_x: string; player_o: string;
  turn_id: string; best_of: number; round: number; score_x: number; score_o: number;
  my_pick: string | null; partner_locked: boolean; finished: boolean; winner_id: string | null;
  rounds: { round: number; x: string; o: string; winner: string | null }[];
  /** Present on snake duels only: the run this phone may play, and the partner's status. */
  snake?: SnakeDuel | null;
  /** Present on Tetris duels only: this phone's run, the partner's status and the mode. */
  tetris?: TetrisDuel | null;
  /** Present on chess matches only: the position the database has validated. */
  chess?: ChessSnapshot | null;
  /** Connect Four's server-validated 6×7 board, row-major from the top. */
  board?: string[];
  /** Dash Duel's shared Lagos course and individual verified runs. */
  dash?: DashDuel | null;
}
export interface GamesSnapshot { wins: Record<string, number>; matches: GameMatch[] }
const SNAKE_SETUP_ERROR = 'Snake Duel needs a database update. Check 202610150010_snake_duel.sql after 202610150007_games.sql, and 202610150011_chess.sql for Chess. Run verify-games.sql; see README for repairing an existing Chess project before retrying.';
const CHESS_SETUP_ERROR = 'Chess needs a database update. Apply 202610150011_chess.sql; if Chess is already installed but its start is rejected by the game check, apply 202610150014_restore_chess_tetris_game_check.sql. Run verify-games.sql before retrying.';
const TETRIS_SETUP_ERROR = 'Tetris Duel needs a database update. Apply migration 202610150012_tetris_duel.sql after 202610150011_chess.sql; if Tetris is already installed but its start is rejected by the game check, apply 202610150014_restore_chess_tetris_game_check.sql. Run verify-games.sql before retrying.';
const DASH_SETUP_ERROR = 'Dash Duel needs a database update. Apply supabase/migrations/202610180009_dash_duel.sql after 202610180008_someday_details_order_and_visit_link.sql, then run supabase/verify-games.sql before retrying.';

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await requireSupabase().rpc(name, args);
  if (error) {
    const snakeRequest = name.startsWith('snake_') || (name === 'start_game' && args.p_game === 'snake');
    const tetrisRequest = name.startsWith('tetris_') || name === 'start_tetris';
    const dashRequest = name.startsWith('dash_') || name === 'start_dash' || error.message.includes('dash_');
    // Migration 007's start_game exists, but only accepts the two original games.
    // This is not a missing-RPC error: it rejects a perfectly valid Duel button click.
    const legacySnakeStart = name === 'start_game' && args.p_game === 'snake'
      && [3, 5].includes(Number(args.p_best_of))
      && ((error.code === 'P0001' && error.message === 'Invalid game settings.')
        || (error.code === '23514' && error.message.includes('game_matches_game_check')));
    if (legacySnakeStart) throw new Error(SNAKE_SETUP_ERROR);
    // Chess installed but the game check predates it (an older Snake migration rerun
    // replaced the constraint without 'chess'): start_chess reaches its INSERT and
    // Postgres answers with the raw constraint violation below. Name the repair
    // instead of showing a phone the database's own wording.
    const legacyChessStart = name === 'start_chess'
      && error.code === '23514' && error.message.includes('game_matches_game_check');
    if (legacyChessStart) throw new Error(CHESS_SETUP_ERROR);
    // Same story for Tetris: migration 012's check names 'tetris', but a project whose
    // constraint was last replaced by an older migration rejects start_tetris' INSERT
    // with the same raw violation. Name the repair instead.
    const legacyTetrisStart = name === 'start_tetris'
      && error.code === '23514' && error.message.includes('game_matches_game_check');
    if (legacyTetrisStart) throw new Error(TETRIS_SETUP_ERROR);
    const legacyDashStart = name === 'start_dash'
      && error.code === '23514' && error.message.includes('game_matches_game_check');
    if (legacyDashStart) throw new Error(DASH_SETUP_ERROR);
    if (['PGRST202', '42P01', '42703', '42883'].includes(error.code)) {
      throw new Error(dashRequest
        ? DASH_SETUP_ERROR
        : snakeRequest || error.message.includes('snake_')
        ? SNAKE_SETUP_ERROR
        : tetrisRequest || error.message.includes('tetris_')
          ? TETRIS_SETUP_ERROR
          : name.includes('chess') || error.message.includes('chess_')
            ? CHESS_SETUP_ERROR
            : 'Games needs a database update. Apply migrations 202610150007_games.sql, 202610150010_snake_duel.sql, 202610150011_chess.sql, then 202610150012_tetris_duel.sql.');
    }
    throw new Error(error.message);
  }
  return data as T;
}
export async function fetchGames(): Promise<GamesSnapshot> {
  const data = await rpc<GamesSnapshot>('games_state');
  if (!data || !Array.isArray(data.matches) || !data.wins || typeof data.wins !== 'object') {
    throw new Error('Games returned an incomplete response. Retry the connection; if it persists, run supabase/verify-games.sql.');
  }
  return {
    ...data,
    matches: data.matches.map((match) => match.game === 'dash-duel'
      ? { ...match, dash: dashDuelFromWire(match.dash) }
      : match),
  };
}

function dashCourseEvents(value: unknown): DashCourseEvent[] {
  if (!Array.isArray(value)) return [];
  const events: DashCourseEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const event = item as Record<string, unknown>;
    const tick = Number(event.tick);
    if (!Number.isInteger(tick) || tick < 1 || tick > 900) continue;
    if (event.kind === 'heart') {
      const lane = Number(event.lane);
      if (Number.isInteger(lane) && lane >= 0 && lane <= 2) events.push({ tick, kind: 'heart', lane: lane as 0 | 1 | 2 });
    } else if (event.kind === 'barrier' && Array.isArray(event.lanes)) {
      const lanes = [...new Set(event.lanes.map(Number).filter((lane) => Number.isInteger(lane) && lane >= 0 && lane <= 2))] as (0 | 1 | 2)[];
      if (lanes.length > 0 && lanes.length <= 2) events.push({ tick, kind: 'barrier', lanes, jumpable: event.jumpable === true });
    }
  }
  return events.sort((a, b) => a.tick - b.tick);
}

/** Actions already accepted by the database, as the deterministic core's move list. */
export function dashActions(rows: [number, string][] | undefined): DashAction[] {
  if (!Array.isArray(rows)) return [];
  const actions: DashAction[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) continue;
    const tick = Number(row[0]);
    if (Number.isInteger(tick) && tick >= 0 && isDashAction(row[1])) actions.push({ tick, action: row[1] });
  }
  return actions.sort((a, b) => a.tick - b.tick);
}

export const dashActionRows = (actions: DashAction[]): [number, string][] => actions.map(({ tick, action }) => [tick, action]);

function dashDuelFromWire(value: unknown): DashDuel | null {
  if (!value || typeof value !== 'object') return null;
  const duel = value as Record<string, unknown>;
  const normalizeSide = (raw: unknown, mine: boolean): DashRun | DashSide | null => {
    if (raw === null || raw === undefined) return mine ? null : { status: 'waiting', ended: null };
    if (!raw || typeof raw !== 'object') return mine ? null : { status: 'waiting', ended: null };
    const side = raw as Record<string, unknown>;
    const allowed = ['ready', 'running', 'done', 'crash', 'forfeit'];
    const status = side.status === 'waiting' && !mine
      ? 'waiting' as const
      : allowed.includes(String(side.status)) ? side.status as DashRunStatus : 'ready' as const;
    const distance = Math.max(0, Number.isFinite(Number(side.distance)) ? Number(side.distance) : 0);
    const hearts = Math.max(0, Number.isFinite(Number(side.hearts)) ? Number(side.hearts) : 0);
    const ticks = Math.max(0, Number.isFinite(Number(side.ticks)) ? Number(side.ticks) : 0);
    const base: DashSide = {
      status,
      ended: typeof side.ended === 'string' ? side.ended : null,
      distance,
      hearts,
      ticks,
      last_seen: typeof side.last_seen === 'string' ? side.last_seen : null,
    };
    if (!mine) return base;
    return {
      ...base,
      status,
      distance,
      hearts,
      ticks,
      lane: Math.max(0, Math.min(2, Number(side.lane) || 0)),
      jump_ticks: Math.max(0, Number(side.jump_ticks) || 0),
      actions: dashActions(side.actions as [number, string][] | undefined).map(({ tick, action }) => [tick, action]),
      started_at: typeof side.started_at === 'string' ? side.started_at : undefined,
      ready_at: typeof side.ready_at === 'string' ? side.ready_at : undefined,
      last_seen: typeof side.last_seen === 'string' ? side.last_seen : undefined,
      finished_at: typeof side.finished_at === 'string' ? side.finished_at : undefined,
    };
  };
  const mine = normalizeSide(duel.mine, true) as DashRun | null;
  const partner = normalizeSide(duel.partner, false) as DashSide;
  const mode = duel.mode === 'together' ? 'together' : 'challenge';
  const level = isDashLevel(duel.level) ? duel.level : 'steady';
  return {
    course_version: Number.isInteger(Number(duel.course_version)) ? Number(duel.course_version) : 1,
    course: dashCourseEvents(duel.course),
    mode,
    level,
    created_by: typeof duel.created_by === 'string' ? duel.created_by : null,
    mine,
    partner,
  };
}

/** Start or resume an open Rock Paper Scissors match or Snake Duel. */
export const startGame = (game: GameId, bestOf = 3) => rpc<string>('start_game', { p_game: game, p_best_of: bestOf });
export const playGame = (match: GameMatch, move: string) => rpc<void>('play_game', { p_id: match.id, p_round: match.round, p_move: move });
export const startConnectFour = () => rpc<string>('start_connect_four');
export const playConnectFour = (match: GameMatch, column: number) => rpc<void>('connect_four_move', { p_id: match.id, p_round: match.round, p_column: column });

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


const CHESS_TYPE_FROM_CODE: Record<string, ChessPieceType> = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

/** Rebuild the engine's state from the database's snapshot, so the board, the legal
 *  move highlights and the check marker are the phone's own — while the *result* of
 *  every move is decided by the server's mirror of the same engine. */
export function chessStateFromMatch(match: GameMatch): ChessState | null {
  const snap = match.chess;
  if (!snap) return null;
  const colorOf = (id: string | null): ChessColor | null => (id === null ? null : id === match.player_x ? 'white' : 'black');
  return {
    board: snap.board.map((code, i) => {
      if (!code) return null;
      const color: ChessColor = code[0] === 'w' ? 'white' : 'black';
      const type = CHESS_TYPE_FROM_CODE[code[1]] ?? 'pawn';
      // The hunt counts only the original queen: the server codes her `Q`, promoted
      // queens `Q*`, and the id is what tells them apart here too.
      const id = type === 'queen' && !code.endsWith('*') ? `${color}-queen` : `${color}-${type}-${i}`;
      return { id, type, color };
    }),
    turn: colorOf(match.turn_id) ?? 'white',
    castling: { K: snap.castling.includes('K'), Q: snap.castling.includes('Q'), k: snap.castling.includes('k'), q: snap.castling.includes('q') },
    enPassant: snap.en_passant,
    halfmove: snap.halfmove,
    fullmove: Math.floor(snap.history.length / 2) + 1,
    mode: snap.mode,
    captures: { white: snap.captures.white as ChessPieceType[], black: snap.captures.black as ChessPieceType[] },
    winner: colorOf(match.winner_id),
    endReason: (snap.end_reason as ChessEndReason | null) ?? null,
    drawn: snap.drawn,
    history: snap.history,
    repetitions: {},
  };
}

/* ---------------------------------------------------------------------------
   Chess. The database is the referee (migration 202610150011_chess.sql mirrors
   src/lib/chess.ts): a phone sends only a move in coordinate notation — `e2e4`,
   `e7e8q`, `resign` — and the server validates it, counts the capture and decides
   checkmate, draws and the situational goals. player_x is White.
   --------------------------------------------------------------------------- */

export const startChess = (mode: string) => rpc<string>('start_chess', { p_mode: mode });
export const playChess = (match: GameMatch, move: string) =>
  rpc<ChessSnapshot>('chess_move', { p_id: match.id, p_round: match.round, p_move: move });

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
   supabase/migrations/202610150012_tetris_duel.sql.
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

/**
 * Open (or resume) a Tetris duel in one of the two modes. Its own RPC, the way Chess has
 * `start_chess`: `start_game` is left exactly as it is, so no project ends up with two
 * overloads of it and every other game keeps the call it has always made.
 */
export const startTetris = (mode: TetrisMode) => rpc<string>('start_tetris', { p_mode: mode });
export const startTetrisRun = (id: string) => rpc<TetrisRun>('tetris_start', { p_id: id });
export const beatTetrisRun = (id: string, ticks: number, inputs: TetrisInput[]) =>
  rpc<TetrisRun>('tetris_beat', { p_id: id, p_ticks: ticks, p_inputs: tetrisInputRows(inputs) });
export const finishTetrisRun = (id: string, ticks: number, inputs: TetrisInput[]) =>
  rpc<TetrisRun>('tetris_finish', { p_id: id, p_ticks: ticks, p_inputs: tetrisInputRows(inputs) });
export const forfeitTetrisRun = (id: string) => rpc<TetrisRun>('tetris_forfeit', { p_id: id });

/* ---------------------------------------------------------------------------
   Dash Duel. A ranked attempt is a shared course plus action deltas: SQL replays the
   complete log and returns the canonical distance, hearts and crash reason. The
   `together` mode uses a two-person ready handshake; `challenge` starts either run
   independently, whenever each partner has time. Free play is kept local to the UI.
   --------------------------------------------------------------------------- */

export const startDash = (mode: DashMatchMode, level: DashLevel) =>
  rpc<string>('start_dash', { p_mode: mode, p_level: level });
export const startDashRun = (id: string) => rpc<DashRun>('dash_start', { p_id: id });
export const beatDashRun = (id: string, ticks: number, actions: DashAction[]) =>
  rpc<DashRun>('dash_beat', { p_id: id, p_ticks: ticks, p_actions: dashActionRows(actions) });
export const finishDashRun = (id: string, ticks: number, actions: DashAction[]) =>
  rpc<DashRun>('dash_finish', { p_id: id, p_ticks: ticks, p_actions: dashActionRows(actions) });
export const forfeitDashRun = (id: string) => rpc<DashRun>('dash_forfeit', { p_id: id });
