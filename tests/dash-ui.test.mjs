import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Dash Duel offers async, presence-gated live and local free modes with accessible controls', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'PointerEvent', 'KeyboardEvent']) {
    if (dom.window[key]) globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { GamesView } = await server.ssrLoadModule('/src/components/games/GamesView.tsx');
    const { DashDuel } = await server.ssrLoadModule('/src/components/games/DashDuel.tsx');
    const calls = [];
    const games = {
      data: { matches: [], wins: {} }, error: null, busy: false, match: undefined,
      select: (id) => calls.push(['select', id]),
      start: (...args) => calls.push(['start', ...args]),
      startDashDuel: (...args) => calls.push(['startDashDuel', ...args]),
      startDash: (...args) => calls.push(['startDash', ...args]),
      beatDash: (...args) => calls.push(['beatDash', ...args]),
      finishDash: (...args) => calls.push(['finishDash', ...args]),
      forfeitDash: (...args) => { calls.push(['forfeitDash', ...args]); return Promise.resolve(); },
      refresh: () => {},
    };
    const render = (partnerOnline = false) => act(async () => root.render(React.createElement(GamesView, {
      games, userId: 'a', partnerName: 'Bisi', partnerOnline,
    })));
    const button = (name) => [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === name);

    await render(false);
    assert(document.querySelector('[data-game="dash-duel"]'));
    assert.equal(button('Play together · online →'), undefined, 'the live choice is absent while the partner is offline');
    assert(button('Set a challenge →'));
    assert(button('Free run · just for fun'));
    await act(async () => button('Easy route').click());
    await act(async () => button('Set a challenge →').click());
    assert.deepEqual(calls.pop(), ['startDashDuel', 'challenge', 'easy'], 'the first challenger chooses the course difficulty');
    await act(async () => button('Free run · just for fun').click());
    assert(document.querySelector('[data-dash-run="free"]'), 'free play opens the real runner board');
    assert(document.querySelector('[data-dash-stage]') || document.querySelector('.dash-stage'));
    assert(document.body.textContent.includes('Not counted'), 'free play is explicitly unranked');
    assert.equal(calls.length, 0, 'free play makes no game RPC');
    await act(async () => button('← All games').click());

    await render(true);
    assert(button('Play together · online →'), 'presence makes the live option appear');

    const match = {
      id: 'dash-1', game: 'dash-duel', player_x: 'a', player_o: 'b', turn_id: 'a', best_of: 3,
      round: 1, score_x: 0, score_o: 0, my_pick: null, partner_locked: false, finished: false,
      winner_id: null, rounds: [],
      dash: {
        course_version: 1,
        course: [{ tick: 30, kind: 'barrier', lanes: [0], jumpable: true }],
        mode: 'together', level: 'easy', created_by: 'a', mine: null,
        partner: { status: 'waiting', ended: null },
      },
    };
    const renderGate = (online) => act(async () => root.render(React.createElement(DashDuel, {
      match, userId: 'a', partnerName: 'Bisi', partnerOnline: online, games,
      onExit: () => calls.push(['exit']),
    })));
    await renderGate(false);
    assert.equal(button('I’m ready to race'), undefined, 'the live start action is absent while the partner is offline');
    await renderGate(true);
    assert.equal(button('I’m ready to race').disabled, false);
    await act(async () => button('I’m ready to race').click());
    assert.deepEqual(calls.pop(), ['startDash', 'dash-1']);
    assert.equal(document.querySelectorAll('.dash-lane').length, 0, 'the ready gate has not started a fake local run');
    calls.length = 0;

    match.dash.mine = {
      status: 'running', ended: null, distance: 0, hearts: 0, ticks: 0, lane: 1, jump_ticks: 0,
      actions: [], started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
    };
    match.dash.partner = { status: 'running', ended: null, distance: 12, hearts: 1, ticks: 12, last_seen: new Date().toISOString() };
    await renderGate(true);
    assert.equal(document.querySelectorAll('.dash-lane').length, 3);
    assert(document.querySelector('.dash-progress-partner .dash-chibi-mini'), 'the shared progress marker is the partner’s distinct chibi runner');
    assert.equal(document.querySelectorAll('.dash-chibi').length, 2, 'both partners have characters on the shared track');
    await act(async () => button('Leave run').click());
    assert(document.querySelector('.dash-leave'), 'the running board owns its own leave confirmation');
    await act(async () => button('Leave and forfeit').click());
    assert.deepEqual(calls, [['forfeitDash', 'dash-1'], ['exit']], 'the wrapper delegates the confirmed exit to the board');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
