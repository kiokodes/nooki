/**
 * The Snake duel's one hard rule, end to end, in the real App against a real Postgres.
 *
 * A run cannot be paused, so walking out of the Games tab while one is live is a forfeit.
 * The app asks first — over the board, which keeps moving — and only then does the tab
 * change. Bob's half is played by signing in as him and reading the same state, so the
 * win only lands on his side if the forfeit really happened.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('snake tab: a live run asks before a tab change, and leaving forfeits it', async () => {
  // pretendToBeVisual keeps the page "visible": the games hook only re-reads the table
  // while the document is on screen, so a hidden page would never see its own state.
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  const root = createRoot(document.getElementById('root'));
  let backend;
  try {
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const games = await server.ssrLoadModule('/src/lib/gamesService.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, 'Alice', 'Africa/Lagos');
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, 'Bob', 'Pacific/Auckland');
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    // The partner's half: the same services, signed in as Bob.
    const asBob = async (work) => {
      await auth.signInWithEmail('bob@example.com', 'password');
      try { return await work(); } finally { await auth.signInWithEmail('alice@example.com', 'password'); }
    };
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if (await predicate()) return;
        await settle(25);
      }
      assert.fail(message);
    };
    const click = async (selector) => {
      const element = document.querySelector(selector);
      assert(element, `the "${selector}" control should be on screen`);
      await act(async () => { element.click(); });
    };
    const clickText = async (text) => {
      const element = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
      assert(element, `the "${text}" button should be on screen`);
      await act(async () => { element.click(); });
    };

    // Bob opens the duel, so it is waiting on Alice — and her Games tab says so.
    const duel = await asBob(() => games.startGame('snake', false, 3));

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => document.body.textContent.includes('Together for'), 'the unlocked app should render');
    await waitFor(() => document.querySelector('[data-nav-tab="games"]'), 'the navigation should render');
    await waitFor(() => document.querySelector('[data-nav-badge="games"]')?.textContent.trim() === '1', 'an unplayed duel badges the Games tab');
    assert.equal(document.querySelector('[data-nav-tab="games"]')?.getAttribute('aria-label'), 'Games, 1 game waiting for you');

    // Into the duel, and into the run: the gate is what a live run starts from.
    await click('[data-nav-tab="games"]');
    await waitFor(() => document.querySelector('.game-resume'), 'the duel is listed to resume');
    await act(async () => {
      const card = [...document.querySelectorAll('.game-resume')].find((item) => item.textContent.includes('Snake Duel'));
      assert(card, 'the Snake Duel should be listed');
      card.click();
    });
    await waitFor(() => document.querySelector('[data-snake-gate]'), 'the gate should open');
    await click('[data-action="start-my-run"]');
    await waitFor(() => document.querySelector('.snake-board'), 'the board should open');
    await waitFor(() => document.querySelector('.snake-head'), 'the snake should be on it');
    const beforeMove = document.querySelector('.snake-head').style.left;
    await settle(400);
    assert.notEqual(document.querySelector('.snake-head')?.style.left, beforeMove, 'the run is moving on its own');

    // --- Changing tabs is a forfeit, and the app asks first --------------------------
    await click('[data-nav-tab="chat"]');
    await waitFor(() => document.querySelector('.snake-leave'), 'leaving asks first');
    assert(document.querySelector('.snake-board'), 'the board is still running behind the question');
    assert(document.querySelector('[data-nav-tab="games"]'), 'the tabs are still there');
    assert.equal(document.querySelector('textarea[placeholder="Message Bob…"]'), null, 'the chat has not opened');

    // Keeping the run: nothing happened, and the run is still live.
    await clickText('Keep playing');
    await waitFor(() => document.querySelector('.snake-leave') === null, 'the question closes');
    const kept = (await games.fetchGames()).matches.find((item) => item.id === duel);
    assert.equal(kept.finished, false, 'keeping the run forfeits nothing');
    assert.equal(kept.snake.mine.status, 'running', 'and the run is still live');

    // Leaving for real: the tab changes, and Bob takes the duel.
    await click('[data-nav-tab="chat"]');
    await waitFor(() => document.querySelector('.snake-leave'), 'the question comes back');
    await click('.snake-leave-danger');
    await waitFor(() => document.querySelector('textarea[placeholder="Message Bob…"]'), 'the chat tab opens once the run is given up');
    await waitFor(async () => {
      const state = (await games.fetchGames()).matches.find((item) => item.id === duel);
      return state?.finished === true;
    }, 'the duel should be finished by the forfeit');
    const finished = (await games.fetchGames()).matches.find((item) => item.id === duel);
    assert.equal(finished.winner_id, bob.id, 'the partner who stayed takes the duel');
    assert.equal(finished.snake.mine.status, 'forfeit');
    await waitFor(() => document.querySelector('[data-nav-badge="games"]') === null, 'and the badge clears');
    const bobSees = await asBob(async () => (await games.fetchGames()).matches.find((item) => item.id === duel));
    assert.equal(bobSees.winner_id, bob.id, 'Bob sees the win on his own phone');
    assert.equal(bobSees.snake.partner.status, 'forfeit', 'and that Alice left the run');
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
