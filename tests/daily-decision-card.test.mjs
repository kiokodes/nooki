import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('Today’s decision card mirrors Our day: title, status line and glow until decided', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<div id="root"></div>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const root = createRoot(document.getElementById('root'));
  try {
    const { DailyDecisionCard } = await server.ssrLoadModule('/src/components/home/DailyDecisionCard.tsx');

    const question = { id: 7, question: 'What should we plan together?', options: ['Cook dinner', 'Watch a film', 'Take a walk'] };
    const base = {
      question, my_choice: null, partner_responded: false,
      both_answered: false, agreed: false, loading: false, error: null,
    };
    let opens = 0;
    const render = async (props) => {
      await act(async () => {
        root.render(React.createElement(DailyDecisionCard, { onPlay: () => { opens += 1; }, partnerName: 'Bob', ...props }));
      });
      const card = document.querySelector('[data-card="daily-decision"]');
      assert(card, 'the decision card renders');
      return card;
    };
    const copy = (card) => card.textContent.replace(/\u2019/g, "'");

    // Haven't decided: the whole card is the button (like Our day), the little title
    // sits at Our day's size, and the status line asks for the decision — glowing,
    // pulsing and badged, because the move is this phone's.
    let card = await render({ state: { ...base } });
    assert.equal(card.tagName, 'BUTTON', 'the whole card opens the decision, like Our day');
    assert.equal(card.dataset.action, 'play-daily-decision');
    assert.equal(card.dataset.decisionState, 'undecided');
    assert.equal(card.dataset.decisionAttention, 'action');
    assert(card.classList.contains('nooki-decision-card--action'), 'my unmade decision pulses');
    assert.match(card.style.boxShadow, /236,\s*72,\s*153/, 'the glow carries the pink alert ring');
    assert(card.querySelector('[data-decision-alert]'), 'my unmade decision carries the alert badge');
    assert.match(copy(card), /Today's decision/);
    assert.match(copy(card), /Make a decision/);
    assert.doesNotMatch(copy(card), /Play/, 'the old Play pill is gone');
    // The Our day card's chrome, value for value (everydayStatus.css .our-day-card).
    assert.equal(card.style.minHeight, '82px');
    assert.equal(card.style.padding, '12px');
    assert.equal(card.style.borderRadius, '16px');
    assert.equal(card.style.backgroundColor, 'rgb(255, 251, 242)');
    assert.equal(card.style.textAlign, 'left');
    const title = card.querySelector('span');
    assert.equal(title.style.fontSize, '0.62rem', 'the title matches Our day’s size');
    assert.equal(title.style.fontWeight, '800');
    assert.equal(title.style.textTransform, 'uppercase');
    await act(async () => { card.click(); });
    assert.equal(opens, 1, 'tapping anywhere on the card opens the decision');

    // Partner answered first: still my decision to make.
    card = await render({ state: { ...base, partner_responded: true } });
    assert.equal(card.dataset.decisionState, 'undecided');
    assert.match(copy(card), /Make a decision/);

    // An error beside a loaded question (a refused save) keeps the choice status,
    // exactly as the decision sheet keeps showing the question.
    card = await render({ state: { ...base, error: 'The connection was interrupted.' } });
    assert.equal(card.dataset.decisionState, 'undecided');

    // I've decided, partner hasn't: waiting on them by name, still glowing but
    // steadily — no pulse, no badge, because the move isn't mine to clear.
    card = await render({ state: { ...base, my_choice: 2 } });
    assert.equal(card.dataset.decisionState, 'waiting');
    assert.equal(card.dataset.decisionAttention, 'waiting');
    assert.match(copy(card), /Waiting for Bob's decision/);
    assert.match(card.style.boxShadow, /249,\s*168,\s*212/, 'waiting keeps the soft pink glow');
    assert.equal(card.classList.contains('nooki-decision-card--action'), false, 'waiting does not pulse');
    assert.equal(card.querySelector('[data-decision-alert]'), null, 'waiting carries no alert badge');

    // The waiting line names whoever the partner is, possessive and all.
    card = await render({ state: { ...base, my_choice: 2 }, partnerName: 'Jayo' });
    assert.match(copy(card), /Waiting for Jayo's decision/);
    card = await render({ state: { ...base, my_choice: 2 }, partnerName: 'James' });
    assert.match(copy(card), /Waiting for James' decision/);
    card = await render({ state: { ...base, my_choice: 2 }, partnerName: '  ' });
    assert.match(copy(card), /Waiting for your partner's decision/, 'a blank name falls back kindly');

    // Different decisions: talk it out — unresolved, so the alert is back.
    card = await render({ state: { ...base, my_choice: 1, partner_responded: true, both_answered: true } });
    assert.equal(card.dataset.decisionState, 'talk-it-out');
    assert.equal(card.dataset.decisionAttention, 'action');
    assert.match(copy(card), /Talk it out/);
    assert(card.querySelector('[data-decision-alert]'), 'different decisions carry the alert badge');
    assert(card.classList.contains('nooki-decision-card--action'), 'different decisions pulse');

    // Same decision: settled and calm.
    card = await render({ state: { ...base, my_choice: 1, partner_responded: true, both_answered: true, agreed: true } });
    assert.equal(card.dataset.decisionState, 'decided');
    assert.equal(card.dataset.decisionAttention, 'none');
    assert.match(copy(card), /Decided/);
    assert.equal(card.querySelector('[data-decision-alert]'), null);
    assert.equal(card.classList.contains('nooki-decision-card--action'), false);
    assert.doesNotMatch(card.style.boxShadow, /236,\s*72,\s*153|249,\s*168,\s*212/, 'a made decision does not glow');

    // Nothing is claimed before the first load lands: no glow on a guess.
    card = await render({ state: { ...base, question: null, loading: true } });
    assert.equal(card.dataset.decisionState, 'loading');
    assert.equal(card.dataset.decisionAttention, 'none');
    assert.match(copy(card), /Loading today's decision/);
    assert.doesNotMatch(copy(card), /Make a decision/);

    card = await render({ state: { ...base, question: null, error: 'Could not load.' } });
    assert.equal(card.dataset.decisionState, 'unavailable');
    assert.equal(card.dataset.decisionAttention, 'none');
    assert.match(copy(card), /Decision unavailable/);

    card = await render({ state: { ...base, question: null } });
    assert.equal(card.dataset.decisionState, 'empty');
    assert.equal(card.dataset.decisionAttention, 'none');
    assert.match(copy(card), /No decision today/);

    // No state at all (the preview): the card simply invites.
    card = await render({});
    assert.equal(card.dataset.decisionState, 'undecided');
    assert.match(copy(card), /Make a decision/);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
