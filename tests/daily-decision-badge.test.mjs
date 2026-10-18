import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

test('Home decision badge: no pool, partner response, failed save and persisted completion', async () => {
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
    const decisions = await server.ssrLoadModule('/src/lib/dailyDecisionService.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
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
    // Allow the splash and asynchronous database reads to settle.
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (await predicate()) return;
        await settle(10);
      }
      assert.fail(message);
    };
    const click = async (selector) => {
      const element = document.querySelector(selector);
      assert(element, `the "${selector}" control should be on screen`);
      await act(async () => { element.click(); });
    };

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => document.querySelector('[data-nav-tab="home"]'), 'Home navigation loads');
    const homeBadge = () => document.querySelector('[data-nav-badge="home"]');
    const refresh = async () => {
      await act(async () => { window.dispatchEvent(new window.Event('focus')); });
      await settle(100);
    };
    await refresh();
    assert.equal(homeBadge(), null, 'an empty pool never creates a pending reminder');

    await backend.query(
      `INSERT INTO public.daily_decision_questions (question, option_a, option_b, option_c)
       VALUES ($1, $2, $3, $4)`,
      ['What should we plan together?', 'Cook dinner', 'Watch a film', 'Take a walk'],
    );
    await refresh();
    await waitFor(() => homeBadge(), 'an available unanswered question creates the reminder');

    // The other partner answering cannot clear this account's reminder.
    await asBob(() => decisions.submitDailyDecisionChoice(2));
    await refresh();
    assert(homeBadge(), 'the reminder is scoped to my answer, not the partner response');
    await click('[data-action="play-daily-decision"]');
    await waitFor(() => document.querySelector('[data-decision-option="2"]'), 'the question opens');
    await click('[data-decision-option="2"] input');

    const rpc = supabase.rpc;
    supabase.rpc = async (name, args) => name === 'submit_daily_decision_choice'
      ? { data: null, error: { message: 'The connection was interrupted.' } }
      : rpc(name, args);
    await click('[data-action="submit-daily-decision"]');
    assert(homeBadge(), 'a refused save leaves the pending reminder in place');
    supabase.rpc = rpc;
    await click('[data-action="submit-daily-decision"]');
    await waitFor(() => homeBadge() === null, 'a successful save removes the reminder');
    await refresh();
    assert.equal(homeBadge(), null, 'a foreground refresh does not restore an answered reminder');

    // Reloading the app reads the persisted choice rather than showing a fresh badge.
    await act(async () => { root.render(null); });
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => document.querySelector('[data-nav-tab="home"]'), 'Home returns on reload');
    await refresh();
    assert.equal(homeBadge(), null, 'the saved answer keeps the reminder cleared after reload');
  } finally {
    await act(async () => root.unmount());
    await backend?.close();
    await server.close();
    dom.window.close();
  }
});
