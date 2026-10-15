/** Sudoku game core: pure, deterministic-ish, shared by phone and (eventually) the database. */

export type SudokuDifficulty = 'easy' | 'medium' | 'hard';

export const SUDOKU_SIZE = 9;
export const SUDOKU_BOX = 3;
export const SUDOKU_CELLS = SUDOKU_SIZE * SUDOKU_SIZE;

/** How many clues (givens) each difficulty leaves on the board. */
export const SUDOKU_CLUES: Record<SudokuDifficulty, number> = {
  easy: 40,
  medium: 32,
  hard: 24,
};

/** Maximum mistakes allowed before a run is lost. */
export const SUDOKU_MAX_MISTAKES = 3;

export type SudokuBoard = number[]; // 81 cells, 0 = empty

export function emptyBoard(): SudokuBoard {
  return new Array(SUDOKU_CELLS).fill(0);
}

export function rowOf(i: number): number { return Math.floor(i / SUDOKU_SIZE); }
export function colOf(i: number): number { return i % SUDOKU_SIZE; }
export function boxOf(i: number): number {
  return Math.floor(rowOf(i) / SUDOKU_BOX) * SUDOKU_BOX + Math.floor(colOf(i) / SUDOKU_BOX);
}

/** Cells that share a row, column or 3x3 box with `i` (excluding i). */
export function peers(i: number): number[] {
  const r = rowOf(i), c = colOf(i);
  const out: number[] = [];
  for (let k = 0; k < SUDOKU_SIZE; k++) {
    out.push(r * SUDOKU_SIZE + k);
    out.push(k * SUDOKU_SIZE + c);
  }
  const br = Math.floor(r / SUDOKU_BOX) * SUDOKU_BOX;
  const bc = Math.floor(c / SUDOKU_BOX) * SUDOKU_BOX;
  for (let rr = br; rr < br + SUDOKU_BOX; rr++)
    for (let cc = bc; cc < bc + SUDOKU_BOX; cc++) out.push(rr * SUDOKU_SIZE + cc);
  return Array.from(new Set(out)).filter((x) => x !== i);
}

export function isValidPlacement(board: SudokuBoard, index: number, value: number): boolean {
  if (value === 0) return true;
  for (const p of peers(index)) if (board[p] === value) return false;
  return true;
}

/** Backtracking solver. Mutates board in place; returns true if solvable. */
export function solve(board: SudokuBoard): boolean {
  // find empty cell with fewest candidates (MRV)
  let best = -1, bestCount = 10;
  for (let i = 0; i < SUDOKU_CELLS; i++) {
    if (board[i] !== 0) continue;
    let count = 0;
    for (let v = 1; v <= 9; v++) if (isValidPlacement(board, i, v)) count++;
    if (count < bestCount) { bestCount = count; best = i; if (count === 0) break; if (count === 1) break; }
  }
  if (best === -1) return true; // solved
  if (bestCount === 0) return false;
  for (let v = 1; v <= 9; v++) {
    if (!isValidPlacement(board, best, v)) continue;
    board[best] = v;
    if (solve(board)) return true;
    board[best] = 0;
  }
  return false;
}

export function countSolutions(board: SudokuBoard, limit = 2): number {
  // returns number of solutions up to limit
  let count = 0;
  function rec(b: SudokuBoard): void {
    if (count >= limit) return;
    let best = -1, bestCount = 10;
    for (let i = 0; i < SUDOKU_CELLS; i++) {
      if (b[i] !== 0) continue;
      let c = 0;
      for (let v = 1; v <= 9; v++) if (isValidPlacement(b, i, v)) c++;
      if (c < bestCount) { bestCount = c; best = i; if (c === 0) break; if (c === 1) break; }
    }
    if (best === -1) { count++; return; }
    if (bestCount === 0) return;
    for (let v = 1; v <= 9; v++) {
      if (!isValidPlacement(b, best, v)) continue;
      const nb = b.slice();
      nb[best] = v;
      rec(nb);
      if (count >= limit) return;
    }
  }
  rec(board.slice());
  return count;
}

export function isComplete(board: SudokuBoard): boolean {
  if (board.some((v) => v === 0)) return false;
  for (let i = 0; i < SUDOKU_CELLS; i++) {
    if (!isValidPlacement(board, i, board[i])) return false;
  }
  return true;
}

/** Cells whose current value conflicts with a peer. */
export function conflictingCells(board: SudokuBoard): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i < SUDOKU_CELLS; i++) {
    if (board[i] === 0) continue;
    for (const p of peers(i)) {
      if (board[p] === board[i]) { out.add(i); out.add(p); }
    }
  }
  return out;
}

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Generate a full solved board. */
export function generateSolution(): SudokuBoard {
  const board = emptyBoard();
  // fill diagonal boxes first for speed
  for (let b = 0; b < SUDOKU_SIZE; b += SUDOKU_BOX) {
    const nums = shuffle([1,2,3,4,5,6,7,8,9]);
    let k = 0;
    for (let r = b; r < b + SUDOKU_BOX; r++)
      for (let c = b; c < b + SUDOKU_BOX; c++) board[r * SUDOKU_SIZE + c] = nums[k++];
  }
  solve(board);
  return board;
}

export interface SudokuPuzzle {
  puzzle: SudokuBoard;
  solution: SudokuBoard;
  difficulty: SudokuDifficulty;
}

export function generatePuzzle(difficulty: SudokuDifficulty = 'medium'): SudokuPuzzle {
  const solution = generateSolution();
  const puzzle = solution.slice();
  const clues = SUDOKU_CLUES[difficulty];
  const toRemove = SUDOKU_CELLS - clues;
  const indices = shuffle(Array.from({ length: SUDOKU_CELLS }, (_, i) => i));
  let removed = 0;
  for (const idx of indices) {
    if (removed >= toRemove) break;
    const backup = puzzle[idx];
    puzzle[idx] = 0;
    // ensure unique solution
    if (countSolutions(puzzle, 2) !== 1) {
      puzzle[idx] = backup;
    } else {
      removed++;
    }
  }
  return { puzzle, solution, difficulty };
}

export function formatTime(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
