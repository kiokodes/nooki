export type ConnectFourCell = 'X' | 'O' | '';
export type ConnectFourBoard = ConnectFourCell[];
export const emptyConnectFourBoard = (): ConnectFourBoard => Array(42).fill('');

/** Drop a checker into a column. Returns null when the column is full/invalid. */
export function dropChecker(board: ConnectFourBoard, column: number, mark: Exclude<ConnectFourCell, ''>): ConnectFourBoard | null {
  if (!Number.isInteger(column) || column < 0 || column > 6 || board.length !== 42) return null;
  const next = [...board];
  for (let row = 5; row >= 0; row--) {
    const index = row * 7 + column;
    if (!next[index]) { next[index] = mark; return next; }
  }
  return null;
}

export function connectFourWinner(board: ConnectFourBoard): ConnectFourCell {
  if (board.length !== 42) return '';
  for (let row = 0; row < 6; row++) for (let col = 0; col < 7; col++) {
    const mark = board[row * 7 + col];
    if (!mark) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      if (Array.from({ length: 4 }, (_, n) => [row + dr * n, col + dc * n]).every(([r, c]) => r >= 0 && r < 6 && c >= 0 && c < 7 && board[r * 7 + c] === mark)) return mark;
    }
  }
  return '';
}

export const connectFourDrawn = (board: ConnectFourBoard) => board.length === 42 && board.every(Boolean) && !connectFourWinner(board);
