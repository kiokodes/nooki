import test from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../src/lib/connectFour.ts', import.meta.url), 'utf8');
const js = ts.transpile(source, { module: ts.ModuleKind.CommonJS });
const module = { exports: {} };
vm.runInNewContext(js, { module, exports: module.exports });
const { emptyConnectFourBoard, dropChecker, connectFourWinner, connectFourDrawn } = module.exports;

test('checker falls to the lowest available row and leaves source board unchanged', () => {
  const board = emptyConnectFourBoard();
  const first = dropChecker(board, 2, 'X');
  assert.equal(first[5 * 7 + 2], 'X');
  const second = dropChecker(first, 2, 'O');
  assert.equal(second[4 * 7 + 2], 'O');
  assert.equal(board.every((cell) => cell === ''), true);
});

test('rejects full columns and invalid inputs', () => {
  let board = emptyConnectFourBoard();
  for (let i = 0; i < 6; i++) board = dropChecker(board, 0, i % 2 ? 'O' : 'X');
  assert.equal(dropChecker(board, 0, 'X'), null);
  assert.equal(dropChecker(board, 7, 'X'), null);
  assert.equal(dropChecker(board, 1.2, 'X'), null);
});

test('recognizes horizontal, vertical and both diagonal wins', () => {
  const make = (positions) => { const board = emptyConnectFourBoard(); for (const [r,c] of positions) board[r*7+c]='X'; return board; };
  assert.equal(connectFourWinner(make([[5,0],[5,1],[5,2],[5,3]])), 'X');
  assert.equal(connectFourWinner(make([[2,4],[3,4],[4,4],[5,4]])), 'X');
  assert.equal(connectFourWinner(make([[2,1],[3,2],[4,3],[5,4]])), 'X');
  assert.equal(connectFourWinner(make([[2,5],[3,4],[4,3],[5,2]])), 'X');
});

test('detects a full-board draw only when there is no winner', () => {
  const shifts = [0, 0, 0, 1, 0, 0];
  const board = Array.from({ length: 42 }, (_, i) => (Math.floor(i / 7) + i % 7 + shifts[Math.floor(i / 7)]) % 2 ? 'X' : 'O');
  assert.equal(connectFourDrawn(board), true);
  assert.equal(connectFourDrawn(emptyConnectFourBoard()), false);
});
