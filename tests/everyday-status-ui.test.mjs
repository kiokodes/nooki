import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('Home check-ins render snapshots, acknowledge, edit, clear and open existing chat', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window; globalThis.document = dom.window.document;
  const root = createRoot(document.getElementById('root'));
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    // No network channel in this unit test; reads/writes still use real PostgreSQL.
    supabase.channel = () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; };
    supabase.removeChannel = async () => {};
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const service = await server.ssrLoadModule('/src/lib/everydayStatusService.ts');
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'UTC' });
    const { couple } = await auth.createCouple(alice.id, '2020-02-14');
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'UTC' });
    await auth.joinCoupleWithCode(bob.id, couple.invite_code);
    await service.saveEverydayStatus('Calm', 'Working', 'Looking forward to our call', 12);
    await auth.signInWithEmail('alice@example.com', 'password');
    await service.saveEverydayStatus('Happy', '', 'My little moment', 4);
    const { EverydayStatusCards } = await server.ssrLoadModule('/src/components/home/EverydayStatusCards.tsx');
    let messages = 0;
    await act(async () => { root.render(React.createElement(EverydayStatusCards, { coupleId: couple.id, userId: alice.id, partnerId: bob.id, partnerName: 'Bob', onMessage: () => messages++ })); });
    // Flush the initial database read.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    const button = label => [...document.querySelectorAll('button')].find(el => el.textContent === label);
    assert.equal(document.querySelector('[role="dialog"]'), null, 'Home stays compact until opened');
    assert.match(document.body.textContent, /Bob left a message/);
    const ourDay = () => document.querySelector('[data-card="our-day"]');
    await act(async () => { ourDay().focus(); ourDay().click(); });
    assert(document.querySelector('[role="dialog"][aria-modal="true"]'));
    assert.match(document.body.textContent, /Calm · Working/);
    assert.match(document.body.textContent, /Looking forward to our call/);
    await act(async () => { button('Message').click(); });
    assert.equal(messages, 1);
    assert.equal(document.querySelector('[role="dialog"]'), null, 'Message closes the modal before navigating');
    await act(async () => { ourDay().focus(); ourDay().click(); });
    await act(async () => { button('💛 Thinking of you').click(); await new Promise(resolve => setTimeout(resolve, 50)); });
    assert(button('💛 Sent with love').disabled);
    await act(async () => { button('Update my day').click(); });
    assert.equal(document.querySelector('textarea').value, 'My little moment');
    assert.equal(document.querySelector('textarea').maxLength, 120);
    assert.equal(document.querySelectorAll('select')[2].value, '12');
    await act(async () => { button('Cancel').click(); });
    assert.equal(document.querySelector('form'), null);
    await act(async () => { button('Clear').click(); await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.doesNotMatch(document.body.textContent, /My little moment/);
    assert.match(document.body.textContent, /Looking forward to our call/);
    await act(async () => { document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, ourDay(), 'closing returns focus to the compact card');
    await backend.query('DELETE FROM public.everyday_status WHERE user_id=$1', [bob.id]);
    await auth.signInWithEmail('alice@example.com', 'password');
    await act(async () => { ourDay().click(); await new Promise(resolve => setTimeout(resolve, 50)); });
    assert.match(ourDay().textContent, /Update Bob on your day/);
    await act(async () => { document.querySelector('[aria-label="Close Our day"]').click(); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally {
    await act(async () => root.unmount());
    await backend?.close(); await server.close(); dom.window.close();
  }
});
