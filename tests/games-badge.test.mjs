/**
 * The Games tab badge, end to end, in the real App component against a real Postgres.
 *
 * A match that is waiting on this phone — your turn in tic-tac-toe, or your pick in
 * rock-paper-scissors — announces itself on the tab, the way unread messages do on
 * Chat. The partner's half is played by signing in as Bob and calling the same
 * services, so the badge only appears if the turn really is this phone's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('games tab: a match waiting on this phone badges the tab and clears once it is played', async () => {
  // pretendToBeVisual keeps the page "visible": the games hook only re-reads the
  // table while the document is on screen, so a hidden page would never badge.
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
      try {
        return await work();
      } finally {
        await auth.signInWithEmail('alice@example.com', 'password');
      }
    };
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    // The games hook re-reads the table every couple of seconds, so give it room.
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (await predicate()) return;
        await settle(10);
      }
      assert.fail(message);
    };
    const badge = () => document.querySelector('[data-nav-badge="games"]');
    const gamesTab = () => document.querySelector('[data-nav-tab="games"]');
    const click = async (selector) => {
      const element = document.querySelector(selector);
      assert(element, `the "${selector}" control should be on screen`);
      await act(async () => { element.click(); });
    };

    // Bob starts a game of tic-tac-toe, so the first move is his.
    const ttt = await asBob(() => games.startGame('tic-tac-toe', false, 3));

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => document.body.textContent.includes('Together for'), 'the unlocked app should render');
    await waitFor(() => gamesTab(), 'the navigation should render');
    assert.equal(badge(), null, "the partner's turn does not badge this phone");

    // --- Bob moves, so the board is now waiting on Alice ------------------------------
    await asBob(async () => {
      const match = (await games.fetchGames()).matches.find((m) => m.id === ttt);
      await games.playGame(match, '0');
    });
    await waitFor(() => badge()?.textContent.trim() === '1', 'your turn badges the Games tab');
    assert.equal(gamesTab()?.getAttribute('aria-label'), 'Games, 1 game waiting for you', 'the tab says what is waiting');

    // --- The Games tab itself points at the match that needs you ----------------------
    await click('[data-nav-tab="games"]');
    await waitFor(() => document.querySelector('.game-resume'), 'the games list should show the match');
    assert(document.querySelector('.game-resume')?.textContent.includes('Your turn'), 'the match says it is waiting on you');

    // --- Alice plays, so the turn goes back to Bob and the badge clears --------------
    await act(async () => { document.querySelector('.game-resume').click(); });
    await waitFor(() => document.querySelector('.ttt-board button'), 'the board should open');
    await act(async () => {
      const square = document.querySelector('[aria-label="Row 1, column 2: empty"]');
      assert(square, 'an empty square should be on the board');
      square.click();
    });
    await waitFor(() => badge() === null, 'the badge clears once you have played');

    // --- Rock-paper-scissors: it is your pick until you lock one in ------------------
    const rps = await asBob(() => games.startGame('rock-paper-scissors', false, 3));
    await waitFor(() => badge()?.textContent.trim() === '1', 'a match waiting for your pick badges the tab');
    await act(async () => { document.querySelector('.game-back').click(); });
    await waitFor(() => document.querySelector('.game-resume'), 'the games list should show both matches');
    await act(async () => {
      const card = [...document.querySelectorAll('.game-resume')].find((item) => item.textContent.includes('Rock Paper Scissors'));
      assert(card, 'the rock-paper-scissors match should be in the list');
      card.click();
    });
    await waitFor(() => document.querySelector('.rps-picks'), 'the rock-paper-scissors card should open');
    await act(async () => {
      const pick = [...document.querySelectorAll('.rps-picks button')].find((b) => b.textContent.includes('rock'));
      pick.click();
    });
    await waitFor(() => badge() === null, 'the badge clears once your pick is locked in');

    // The partner still has to pick, so the match is not finished for either of them.
    const waiting = (await games.fetchGames()).matches.find((m) => m.id === rps);
    assert.equal(waiting.finished, false, 'the match is still open');
    assert.equal(waiting.my_pick, 'rock', 'the pick is sealed, not revealed');
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
