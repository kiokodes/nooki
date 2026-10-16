import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

/**
 * The Tetris core is the single source of truth for how a run plays out, and it has to
 * agree with the database tick for tick (see `tetris-database.test.mjs`). So it is worth
 * hammering on its own: the shapes, the rotation about the piece's first cell, the way a
 * clear collapses the well, the two ways a run ends, and the way a logged run replays to
 * exactly the board that was played.
 */
test('tetris core: pieces, rotation, clears, top-out, replay and catch-up', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const {
      TETRIS_COLS, TETRIS_ROWS, TETRIS_RUN_TICKS, TETRIS_TICK_MS, TETRIS_RUN_SECONDS,
      TETRIS_LINE_SCORE, TETRIS_GRAVITY, TETRIS_SHAPES, TETRIS_MAX_LEVEL,
      createTetrisState, stepTetris, queueTetrisAction, advanceTetrisTo, replayTetris,
      tetrisTickBudget, tetrisCollides, tetrisGhostCells, tetrisLevel, tetrisGravityTicks,
      tetrisSpawnCells, tetrisCellId, tetrisNextKind, tetrisDecide,
    } = await server.ssrLoadModule('/src/lib/tetris.ts');

    const minY = (cells) => Math.min(...cells.map((cell) => cell.y));
    const play = (pieces, taps) => {
      let state = createTetrisState(pieces);
      const applied = [];
      for (const tap of taps) {
        state = queueTetrisAction(state, tap);
        const step = stepTetris(state);
        applied.push(...step.applied);
        state = step.state;
      }
      return { state, applied };
    };

    // --- The shape of the thing -------------------------------------------------------
    assert.equal(TETRIS_COLS, 10);
    assert.equal(TETRIS_ROWS, 16);
    assert.equal(TETRIS_TICK_MS, 50);
    assert.equal(TETRIS_RUN_SECONDS, 300);
    assert.equal(TETRIS_RUN_TICKS, 6000, 'five minutes at 50ms a tick');
    assert.equal(TETRIS_SHAPES.length, 7, 'the reference repo’s seven tetrominoes');
    assert.deepEqual(TETRIS_LINE_SCORE, [0, 100, 300, 700, 1500], 'the reference repo’s table');
    assert.equal(TETRIS_GRAVITY.length, TETRIS_MAX_LEVEL + 1);
    assert.deepEqual(tetrisSpawnCells(0), [{ x: 4, y: 1 }, { x: 3, y: 1 }, { x: 5, y: 1 }, { x: 6, y: 1 }],
      'the I piece arrives across the middle');
    assert.deepEqual(tetrisSpawnCells(1), [{ x: 5, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1 }, { x: 5, y: 1 }],
      'and the square sits at the top of the well');

    const start = createTetrisState([0, 1, 2, 3, 4, 5, 6]);
    assert.equal(start.ticks, 0);
    assert.equal(start.score, 0);
    assert.equal(start.kind, 0);
    assert.equal(start.piece, 0);
    assert.equal(start.ended, null);
    assert.equal(start.field.length, TETRIS_COLS * TETRIS_ROWS);
    assert.equal(tetrisNextKind(start), 1, 'the next piece is known, as it must be to draw it');
    assert.equal(createTetrisState([]).ended, 'cap', 'nothing dealt is nothing played');

    // --- Speed: the level climbs with the lines, and then stops -------------------------
    assert.equal(tetrisLevel(0), 0);
    assert.equal(tetrisLevel(9), 0);
    assert.equal(tetrisLevel(10), 1);
    assert.equal(tetrisLevel(100), TETRIS_MAX_LEVEL);
    assert.equal(tetrisLevel(4000), TETRIS_MAX_LEVEL, 'the curve stops at ten');
    assert.equal(tetrisGravityTicks(0), 15, '0.75s a row to begin with');
    assert.equal(tetrisGravityTicks(100), 3, '0.15s a row at the top of the curve');

    // --- Rotation turns about the piece's first cell, which never moves -----------------
    // The reference repo's rule, kept as it is: the pivot is the piece's first cell, so a
    // piece can sidle a cell as it turns, and four turns is a full circle. That is the
    // whole reason the shape after four turns is compared rather than the cells.
    const shapeOf = (cells) => {
      const mx = Math.min(...cells.map((cell) => cell.x));
      const my = Math.min(...cells.map((cell) => cell.y));
      return cells.map((cell) => `${cell.x - mx}:${cell.y - my}`).sort().join(' ');
    };
    const beforeTurn = start.cells;
    const turned = play([0, 1], ['rotate']).state;
    assert.deepEqual(turned.cells[0], beforeTurn[0], 'the pivot holds its ground');
    assert.deepEqual(turned.cells, [{ x: 4, y: 1 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 4, y: 3 }],
      'the I piece stands up where it lay');
    // Out of the top two rows, where a turn has room, four of them close the circle — for
    // every one of the seven pieces.
    for (let kind = 0; kind < TETRIS_SHAPES.length; kind += 1) {
      const lowered = advanceTetrisTo(createTetrisState([kind, 0]), 60).state;
      let spinning = lowered;
      for (let turn = 0; turn < 4; turn += 1) spinning = stepTetris(queueTetrisAction(spinning, 'rotate')).state;
      assert.equal(shapeOf(spinning.cells), shapeOf(lowered.cells), `four turns closes the circle for piece ${kind}`);
      if (kind !== 1) {
        assert.notEqual(shapeOf(stepTetris(queueTetrisAction(lowered, 'rotate')).state.cells), shapeOf(lowered.cells),
          `and one turn really does turn piece ${kind}`);
      }
    }
    // A square is a square, however you turn it.
    const spunSquare = play([1, 1], ['rotate']).state;
    assert.deepEqual(spunSquare.cells, tetrisSpawnCells(1), 'the square turns in place');

    // --- A tap that cannot be carried out is ignored, and still reported ----------------
    const atTheWall = createTetrisState([0]);
    const pinned = { ...atTheWall, cells: atTheWall.cells.map((cell) => ({ x: cell.x - 4, y: cell.y })) };
    const nudged = play([0], ['left']).state;
    assert.notDeepEqual(nudged.cells, pinned.cells, 'the run started in the middle');
    const shoved = queueTetrisAction(pinned, 'left');
    const shoveStep = stepTetris(shoved);
    assert.deepEqual(shoveStep.state.cells, pinned.cells, 'the wall holds');
    assert.deepEqual(shoveStep.applied, [{ tick: 0, action: 'left' }], 'and the tap is still in the log');

    // --- Gravity: on its own the piece falls one row every fifteen ticks ----------------
    const falling = createTetrisState([0]);
    const afterFourteen = advanceTetrisTo(falling, 14).state;
    assert.equal(minY(afterFourteen.cells), 1, 'not yet');
    const afterFifteen = advanceTetrisTo(falling, 15).state;
    assert.equal(minY(afterFifteen.cells), 2, 'on the fifteenth tick it drops a row');

    // --- Soft drop rests the clock; hard drop ends the piece there and then -------------
    const soft = play([0], ['down']).state;
    assert.equal(minY(soft.cells), 2, 'a soft drop is one row');
    // Dropped on the very tick gravity was about to fire, it still only moves one row: the
    // soft drop gives the piece the whole interval again rather than a second free fall.
    const aboutToFall = advanceTetrisTo(createTetrisState([0]), 14).state;
    const rescued = stepTetris(queueTetrisAction(aboutToFall, 'down')).state;
    assert.equal(minY(rescued.cells), 2, 'one row, not two');
    assert.equal(rescued.fall, 1, 'and the clock starts again from the top');
    const hard = play([0], ['drop']).state;
    assert.equal(hard.locks, 1, 'a hard drop comes to rest at once');
    assert.equal(hard.piece, 1, 'and the next piece takes over');

    // --- One piece comes to rest per tick, however many taps arrive ----------------------
    const crammed = play([0, 0], ['drop']).state;
    const twoDrops = (() => {
      let state = createTetrisState([0, 0]);
      state = queueTetrisAction(queueTetrisAction(state, 'drop'), 'drop');
      return stepTetris(state).state;
    })();
    assert.equal(twoDrops.locks, 1, 'the second tap in the tick finds no piece to drop');
    assert.equal(crammed.locks, 1);

    // --- A clear collapses the well and scores the reference's table ---------------------
    // Five squares across the floor fill the bottom two rows: two rows, three hundred.
    const squares = new Array(20).fill(1);
    const stacking = play(squares, [
      'left', 'left', 'left', 'left', 'drop',
      'left', 'left', 'drop',
      'drop',
      'right', 'right', 'drop',
      'right', 'right', 'right', 'right', 'drop',
    ]);
    assert.equal(stacking.state.score, 300, 'two rows at once is worth three hundred');
    assert.equal(stacking.state.lines, 2);
    assert.equal(stacking.state.locks, 5);
    // Everything that was above the clear has come down, and the well is otherwise empty.
    const filled = stacking.state.field.filter(Boolean).length;
    assert.equal(filled, 0, 'the two rows went, and nothing was left behind');
    // One row is a hundred: two bars across the floor, and a square to close the gap.
    const single = play([0, 0, 1], [
      'left', 'left', 'left', 'drop',
      'right', 'right', 'right', 'drop',
      'drop',
    ]);
    assert.equal(single.state.score, 100, 'a single row is worth a hundred');
    assert.equal(single.state.lines, 1);
    assert.equal(single.state.field.filter(Boolean).length, 2, 'the square’s top half drops into the clear');

    // Four rows at once is the big one: ten bars stood on end, one per column.
    const tetris = [];
    for (let col = 0; col < TETRIS_COLS; col += 1) {
      tetris.push('rotate');
      for (let move = 0; move < Math.abs(col - 4); move += 1) tetris.push(col < 4 ? 'left' : 'right');
      tetris.push('drop');
    }
    const fourRows = play(new Array(TETRIS_COLS).fill(0), tetris);
    assert.equal(fourRows.state.score, 1500, 'a Tetris is worth fifteen hundred');
    assert.equal(fourRows.state.lines, 4);
    assert.equal(fourRows.state.field.filter(Boolean).length, 0, 'and the well comes back empty');

    // --- The well filling up ends the run ------------------------------------------------
    const buried = (() => {
      let state = createTetrisState(new Array(400).fill(6));
      // Drop every piece straight down the same column: it cannot take many.
      while (!state.ended && state.ticks < TETRIS_RUN_TICKS) {
        state = stepTetris(queueTetrisAction(state, 'drop')).state;
      }
      return state;
    })();
    assert.equal(buried.ended, 'top', 'stacking in one place buries you');
    assert.ok(buried.ticks < TETRIS_RUN_TICKS, 'well before the five minutes are up');

    // --- Five minutes ends the run, however well it is going -----------------------------
    // Ten bars stood on end clear four rows and leave the well empty, so this run can go
    // on clearing for as long as the clock allows — which is exactly what it does.
    const marathoned = (() => {
      let state = createTetrisState(new Array(600).fill(0));
      let at = 0;
      while (!state.ended && state.ticks < TETRIS_RUN_TICKS + 500) {
        const queued = queueTetrisAction(state, tetris[at % tetris.length]);
        if (queued !== state) at += 1;
        state = stepTetris(queued).state;
      }
      return state;
    })();
    assert.equal(marathoned.ticks, TETRIS_RUN_TICKS, 'the cap is never passed');
    assert.equal(marathoned.ended, 'cap', 'and the run is over at the cap');
    assert.ok(marathoned.score >= 1500 * 10, 'having cleared a great many Tetrises on the way');

    // --- A ghost that shows where the piece would land -----------------------------------
    const ghosted = createTetrisState([0]);
    const ghost = tetrisGhostCells(ghosted);
    assert.equal(Math.max(...ghost.map((cell) => cell.y)), TETRIS_ROWS - 1, 'the floor');
    assert.equal(tetrisCollides(ghosted, ghost.map((cell) => ({ x: cell.x, y: cell.y + 1 }))), true,
      'and one row further is where it stops');

    // --- A logged run replays to the very same well ---------------------------------------
    const script = [];
    for (let piece = 0; piece < 40; piece += 1) {
      const target = (piece % 5) * 2;
      for (let move = 0; move < Math.abs(4 - target); move += 1) script.push(target < 4 ? 'left' : 'right');
      script.push(piece % 3 === 0 ? 'rotate' : 'drop');
    }
    const runner = (pieces) => {
      let state = createTetrisState(pieces);
      const log = [];
      let at = 0;
      while (!state.ended && state.ticks < 900) {
        const tap = script[at];
        if (tap) {
          const queued = queueTetrisAction(state, tap);
          if (queued !== state) at += 1;
          const step = stepTetris(queued);
          log.push(...step.applied);
          state = step.state;
        } else {
          state = stepTetris(state).state;
        }
      }
      return { state, log };
    };
    const sequence = Array.from({ length: 200 }, (_, i) => (i * 3) % 7);
    const live = runner(sequence);
    assert.ok(live.log.length > 40, 'the run was played, not idled');
    assert.equal(live.state.ended, 'top', 'forty pieces into one well is a burial');
    const replayed = replayTetris(sequence, live.state.ticks, live.log);
    assert.deepEqual(replayed.field, live.state.field, 'the replay lands on the very same well');
    assert.equal(replayed.score, live.state.score);
    assert.equal(replayed.lines, live.state.lines);
    assert.equal(replayed.ticks, live.state.ticks);
    assert.equal(replayed.ended, live.state.ended);
    assert.equal(replayed.piece, live.state.piece);
    // Replaying fewer ticks stops short, it does not invent a board.
    const shortened = replayTetris(sequence, 100, live.log);
    assert.equal(shortened.ticks, 100);
    // A log with a tap the phone could not have made is ignored, not obeyed.
    const tampered = replayTetris(sequence, live.state.ticks, [...live.log, { tick: 0, action: 'sideways' }]);
    assert.deepEqual(tampered.field, live.state.field);

    // --- Time away keeps stacking; it never pauses ----------------------------------------
    // Left alone, a piece falls a row every fifteen ticks and comes to rest at the floor:
    // eight hundred ticks of an unattended phone is three pieces buried in the same column.
    const away = advanceTetrisTo(createTetrisState(new Array(80).fill(1)), 800);
    assert.equal(away.state.ticks, 800, 'the missing ticks were all walked forward');
    assert.deepEqual(away.applied, [], 'nobody was steering, so nothing was logged');
    assert.ok(away.state.locks >= 3, 'and the pieces kept coming');

    // --- The tick ceiling the server enforces ----------------------------------------------
    assert.equal(tetrisTickBudget(0), 0);
    assert.equal(tetrisTickBudget(49), 0);
    assert.equal(tetrisTickBudget(50), 1);
    assert.equal(tetrisTickBudget(50 * 100), 100);
    assert.equal(tetrisTickBudget(TETRIS_TICK_MS * (TETRIS_RUN_TICKS + 500)), TETRIS_RUN_TICKS, 'the cap holds');
    assert.equal(tetrisTickBudget(-5), 0);

    // --- The two ways a duel is settled ----------------------------------------------------
    const side = (status, score, ticks) => ({ status, score, ticks });
    assert.equal(tetrisDecide('sprint', side('done', 300, 6000), side('done', 500, 6000)), 'theirs');
    assert.equal(tetrisDecide('sprint', side('done', 500, 100), side('done', 300, 6000)), 'mine',
      'in a sprint the score is all that counts, not how long it took');
    assert.equal(tetrisDecide('sprint', side('done', 300, 6000), side('done', 300, 6000)), 'draw');
    assert.equal(tetrisDecide('survival', side('done', 300, 6000), side('done', 900, 400)), 'mine',
      'in survival the longer run wins whatever it scored');
    assert.equal(tetrisDecide('survival', side('done', 900, 400), side('done', 300, 6000)), 'theirs');
    assert.equal(tetrisDecide('survival', side('done', 900, 6000), side('done', 300, 6000)), 'mine',
      'the score only separates two runs that lasted the same');
    assert.equal(tetrisDecide('survival', side('done', 300, 6000), side('done', 300, 6000)), 'draw');
    assert.equal(tetrisDecide('sprint', side('forfeit', 0, 10), side('done', 0, 10)), 'theirs', 'leaving loses');
    assert.equal(tetrisDecide('sprint', side('forfeit', 0, 10), side('forfeit', 0, 10)), 'draw');
    assert.equal(tetrisDecide('sprint', side('done', 300, 6000), side('running', 0, 10)), null, 'not yet');
    assert.equal(tetrisDecide('sprint', null, side('done', 0, 10)), null);

    // --- Cells are numbered the way the database numbers them --------------------------------
    assert.equal(tetrisCellId({ x: 0, y: 0 }), 0);
    assert.equal(tetrisCellId({ x: 9, y: 15 }), TETRIS_COLS * TETRIS_ROWS - 1);
  } finally {
    await server.close();
  }
});
