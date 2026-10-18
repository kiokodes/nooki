import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

/**
 * The report bookkeeping under a run that ends while a heartbeat is still on the wire.
 *
 * Progress reports and the final finish both draw from the same queue of unreported taps.
 * The queue used to be peeked at beat time and trimmed only when the beat came back — so a
 * run that ended mid-beat handed the same taps to both reports. The referee logs the
 * beat's taps first and then refuses the finish as "out of order", and the retry resends
 * the same poisoned payload forever: the run is never marked done, the duel never
 * settles, and it stands in the couple's ongoing games after both partners have played.
 *
 * The queue now leaves with each report the moment it is made; a report that fails hands
 * its taps back (into the pending finish if the run has already ended). Nothing is sent
 * twice, and nothing is lost.
 */
test('tetris board: a finish never repeats the taps of a heartbeat still on the wire', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { TetrisBoard } = await server.ssrLoadModule('/src/components/games/TetrisBoard.tsx');

    /** Beats wait on a promise this test decides the fate of — that is the wire. */
    const beats = [];
    const finishes = [];
    const onBeat = (ticks, inputs) => {
      const record = { ticks, inputs, settled: false };
      beats.push(record);
      return new Promise((resolve, reject) => {
        record.resolve = () => { record.settled = true; resolve({ status: 'running' }); };
        record.reject = () => { record.settled = true; reject(new Error('connection reset')); };
      });
    };
    const onFinish = (ticks, inputs) => {
      finishes.push({ ticks, inputs });
      return new Promise(() => {}); // the wire never answers: the retry must carry the run
    };
    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const press = (key) => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key }));
    const waitFor = async (predicate, message, timeoutMs = 8000) => {
      for (let at = 0; at < timeoutMs; at += 20) {
        if (predicate()) return;
        await settle(20);
      }
      assert.fail(message);
    };

    await act(async () => {
      root.render(React.createElement(TetrisBoard, {
        pieces: new Array(600).fill(1), // 2×2 pieces: stacking one column buries the well
        live: true,
        onBeat,
        onFinish,
        onExit: () => {},
      }));
    });

    // Two taps early on — these are the ones the first heartbeat will carry.
    await settle(120);
    await act(async () => press(' '));
    await settle(80);
    await act(async () => press(' '));

    // The heartbeat goes out with those taps and never gets its answer.
    await waitFor(() => beats.length >= 1, 'the first heartbeat should go out');
    const inFlight = beats[0].inputs;
    assert.ok(inFlight.length >= 1, 'the early taps travelled with the heartbeat');

    // The run plays on and tops out while that heartbeat is still on the wire.
    await waitFor(() => beats.length >= 1 && beats[0].settled === false, 'the heartbeat stays on the wire');
    for (let i = 0; i < 24 && finishes.length === 0; i += 1) {
      await act(async () => press(' '));
      await settle(70);
    }
    await waitFor(() => finishes.length >= 1, 'the run should top out and report its finish');

    // THE FIX: the finish carries only taps the heartbeat never saw.
    const first = finishes[0];
    for (const tap of inFlight) {
      const repeated = first.inputs.some((other) => other.tick === tap.tick && other.action === tap.action);
      assert.equal(repeated, false, `tap ${tap.tick}/${tap.action} was already on the wire and must not be sent again`);
    }
    assert.ok(first.inputs.length > 0, 'the finish still carries the taps made after the heartbeat');

    // The heartbeat fails. Its taps join the retrying finish — sorted by tick, in play
    // order — so the report the referee eventually logs is the run as it was played.
    await act(async () => beats[0].reject());
    await waitFor(() => finishes.length >= 2, 'the finish keeps retrying');
    const merged = finishes[finishes.length - 1];
    for (const tap of inFlight) {
      assert.ok(
        merged.inputs.some((other) => other.tick === tap.tick && other.action === tap.action),
        `tap ${tap.tick}/${tap.action} from the failed heartbeat is carried by the retry`,
      );
    }
    const ticks = merged.inputs.map((tap) => tap.tick);
    assert.deepEqual(ticks, [...ticks].sort((a, b) => a - b), 'and the merged taps stay in the order they were played');
    assert.equal(new Set(merged.inputs.map((tap) => `${tap.tick}:${tap.action}`)).size, merged.inputs.length, 'with no tap twice');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
