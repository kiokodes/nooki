/**
 * The Discuss tab end to end, in the real App component against a real Postgres.
 *
 * Everything on screen here comes from the `questions` table: the library is imported the
 * way the owner's CSV would be, and the tab is driven through its categories, question
 * card, answer composer, reveal and comment box — and on through "Say more" into the
 * chat and back. The partner's half is played by signing in as Bob and calling the same
 * services, then nudging Alice over the fake realtime channel — so a reveal only happens
 * if row-level security actually lets it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// One question per input type, imported with the messy spellings a real CSV arrives with.
const LIBRARY = `
INSERT INTO public.questions (id, text, category, seriousness, input_type, options, is_adult) VALUES
  ('q-beach', 'Beach holiday or city break?', 'fun', 1, 'choice', '["Beach","City"]', false),
  ('q-laugh', 'What made you laugh this week?', 'fun', 2, 'text', NULL, false),
  ('q-sunday', 'Rank your perfect Sunday', 'home_life', 3, 'ranking', '["Sleep in","Brunch","Walk","Film"]', false),
  ('q-chores', 'Chores you would rather skip', 'home_life', 2, 'multi_choice', '["Dishes","Bins","Laundry"]', false),
  ('q-save', 'How much of our income should we save?', 'money', 4, 'slider', NULL, false),
  ('q-fear', 'What are you quietly afraid of?', 'deep', 5, 'text', NULL, false),
  ('q-touch', 'What should we try tonight?', 'intimacy', 5, 'choice', '["Talking","Touch"]', false);
`;

test('discuss tab: browse the library, ask, answer privately, reveal together, comment and say more in chat', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
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
    const discuss = await server.ssrLoadModule('/src/lib/discussService.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, 'Alice', 'Africa/Lagos');
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, 'Bob', 'Pacific/Auckland');
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    await backend.exec(LIBRARY);

    // A realtime stand-in: one fake socket per topic, replaying whatever the test hands
    // it the way the live server would. The Discuss hook treats every event as "something
    // changed, re-read" and never trusts the payload, so table and event are all it needs.
    const realtime = { topics: new Map(), removed: 0 };
    const makeChannel = (topic, options) => {
      const handlers = [];
      const channel = {
        topic,
        options,
        handlers,
        presenceState: () => ({}),
        on(type, filter, handler) {
          handlers.push({ type, table: filter.table, event: filter.event, handler });
          return channel;
        },
        subscribe(callback) {
          callback?.('SUBSCRIBED');
          return channel;
        },
        async track() { return 'ok'; },
        async send() { return 'ok'; },
        async unsubscribe() { return 'ok'; },
      };
      realtime.topics.set(topic, channel);
      return channel;
    };
    supabase.channel = (topic, options) => makeChannel(topic, options);
    supabase.removeChannel = async () => { realtime.removed += 1; return 'ok'; };

    const body = () => document.body.textContent.replace(/\u2019/g, "'");
    const button = (label) => [...document.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === label);
    // Accepts an accessible label, a selector, or the element itself.
    const click = async (target) => {
      const looksLikeSelector = typeof target === 'string' && /^[#.[]/.test(target);
      const element = typeof target === 'string'
        ? (looksLikeSelector ? document.querySelector(target) : button(target))
        : target;
      assert(element, `the "${target}" control should be on screen`);
      await act(async () => { element.click(); });
    };
    const type = async (element, value) => {
      const prototype = element.tagName === 'TEXTAREA'
        ? dom.window.HTMLTextAreaElement.prototype
        : dom.window.HTMLInputElement.prototype;
      await act(async () => {
        Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 260; attempt += 1) {
        if (await predicate()) return;
        await settle(10);
      }
      assert.fail(message);
    };
    const pushDiscuss = async (table, event, row = {}) => {
      const channel = realtime.topics.get(discuss.discussTopic(couple.id));
      assert(channel, 'the discuss channel is subscribed');
      await act(async () => {
        for (const entry of channel.handlers.filter((item) => item.table === table && item.event === event)) {
          entry.handler({ new: row });
        }
      });
    };
    const asBob = async (work) => {
      await auth.signInWithEmail('bob@example.com', 'password');
      try {
        return await work();
      } finally {
        await auth.signInWithEmail('alice@example.com', 'password');
      }
    };
    // What is really stored, read as the table owner so row-level security is not in the way.
    const rows = async (sql, params = []) => (await backend.query(sql, params)).rows;
    const answersOf = (sessionId) => rows(
      'SELECT user_id, answer FROM public.answers WHERE session_id = $1 ORDER BY user_id',
      [sessionId],
    );
    // What the composer just sealed, once it has reached the table.
    const waitForStoredAnswer = async (questionId) => {
      let stored = null;
      await waitFor(async () => {
        const found = await rows(
          `SELECT a.session_id, a.answer
             FROM public.answers a
               JOIN public.question_sessions s ON s.id = a.session_id
            WHERE s.couple_id = $1 AND s.question_id = $2 AND a.user_id = $3`,
          [couple.id, questionId, alice.id],
        );
        stored = found[0] ?? null;
        return Boolean(stored);
      }, `an answer for ${questionId} should be stored`);
      return stored;
    };

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => body().includes('Together for'), 'the unlocked app should render');

    // --- 1. Browse: every category the library holds, with what is left in each --------
    await click('Discuss');
    await waitFor(() => document.querySelector('[data-discuss-browse]'), 'the Discuss tab should show the categories');
    assert(button('Fun, 2 left'), 'Fun counts the two imported questions');
    assert(button('Home Life, 2 left'), '"home_life" in the CSV is shown as Home Life');
    assert(button('Money, 1 left'), 'Money is listed from its own row');
    assert(button('Deep, 1 left'), 'Deep is listed from its own row');
    assert(!button('Silently, 0 left') && !document.querySelector('[data-category="Games"]'), 'unused categories stay out of the list');

    // The 18+ shelf is a lock, not a category, until both partners agree.
    const locked = document.querySelector('[data-category="Intimacy"]');
    assert.equal(locked?.getAttribute('data-adult-locked'), 'true', 'Intimacy starts locked');
    assert(body().includes('18+ · hidden until you and Bob both turn it on'), 'the lock explains what unlocks it');
    assert(!body().includes('What should we try tonight?'), 'the adult question text is never sent to a phone that has not unlocked it');

    // --- 2. Category then depth, then the question card --------------------------------
    await click('Fun, 2 left');
    await waitFor(() => document.querySelector('[data-seriousness-picker]'), 'a category should open its depth picker');
    assert(button('Light, level 1, 1 left'), 'levels are labelled and counted');
    assert(document.querySelector('[data-seriousness="3"]')?.disabled, 'a depth with nothing left in it cannot be tapped');
    assert(button('Any level'), 'the couple can skip the depth choice');

    await click('[data-seriousness="1"]');
    await waitFor(() => document.querySelector('[data-discuss-question]'), 'a depth should produce a question card');
    assert.equal(document.querySelector('[data-question-text]')?.textContent, 'Beach holiday or city break?');
    const privacy = document.querySelector('[data-question-privacy]')?.textContent ?? '';
    assert(privacy.includes('You answer privately, Bob answers privately'), 'the card names both answers');
    assert(privacy.includes('nothing is shown until you both have'), 'and promises the seal before it is asked');

    // --- 3. Ask, answer privately, and stay sealed --------------------------------------
    await click('Ask my partner');
    await waitFor(() => document.querySelector('[data-session-screen="composer"]'), 'asking should open the answer composer');
    assert.equal(document.querySelector('[data-answer-input]')?.getAttribute('data-answer-input'), 'choice');
    const send = button('Send my answer');
    assert(send.disabled, 'an empty choice cannot be sent');
    assert(!document.querySelector('[data-comment-input]'), 'comments belong to the reveal, not the composer');

    await click(document.querySelector('[data-option="Beach"]'));
    assert.equal(document.querySelector('[data-option="Beach"]')?.getAttribute('data-selected'), 'true');
    assert(!button('Send my answer').disabled, 'picking an option arms sending');
    await click('Send my answer');

    await waitFor(() => document.querySelector('[data-session-screen="waiting"]'), 'answering should seal the session');
    assert(body().includes('Waiting for Bob'), 'the sealed state names who is missing');
    assert(body().includes('Beach'), 'Alice still sees her own answer');
    assert(!body().includes('City'), 'nothing from the partner may appear while the session is sealed');

    const [first] = await rows(
      'SELECT id, question_id, started_by FROM public.question_sessions WHERE couple_id = $1',
      [couple.id],
    );
    assert.equal(first.question_id, 'q-beach', 'the session belongs to the question that was asked');
    assert.equal(first.started_by, alice.id, 'Alice asked it');
    const sealed = await answersOf(first.id);
    assert.equal(sealed.length, 1, 'only Alice has answered');

    // A stray event must not make the app invent a reveal: it re-reads, and the read is
    // still one answer deep, so the screen stays sealed.
    await pushDiscuss('answers', 'INSERT', { id: 'not-a-real-answer' });
    await settle(700);
    assert(document.querySelector('[data-session-screen="waiting"]'), 'a nudge cannot reveal a session that is not complete');
    assert(!body().includes('City'), 're-reading while sealed still hides the partner');

    // --- 4. Bob answers on his own phone; the reveal arrives over realtime --------------
    await asBob(() => discuss.submitAnswer(first.id, bob.id, 'City'));
    assert.equal((await answersOf(first.id)).length, 2, 'both answers are stored');

    await pushDiscuss('answers', 'INSERT');
    await pushDiscuss('question_sessions', 'UPDATE');
    await waitFor(() => document.querySelector('[data-session-screen="revealed"]'), 'the reveal should land once both have answered');

    const mine = document.querySelector('[data-reveal-card="mine"]');
    const partner = document.querySelector('[data-reveal-card="partner"]');
    assert(mine?.textContent.includes('Beach'), 'Alice sees her own answer first');
    assert(partner?.textContent.includes('City'), 'and Bob’s beside it');
    assert(mine?.className.includes('nooki-reveal-card'), 'both cards carry the reveal animation class');
    assert(partner?.className.includes('nooki-reveal-card'), 'both cards carry the reveal animation class');
    assert(body().includes('You both answered'), 'the reveal says so');

    // --- 5. One comment under the reveal — anything more moves to the chat -------------
    assert(!document.querySelector('[data-reaction]'), 'there is no emoji row any more');
    assert(button('Send comment').disabled, 'an empty comment cannot be sent');
    await type(document.querySelector('[aria-label="Say something about it"]'), 'Same, honestly.');
    assert(!button('Send comment').disabled, 'a written comment can be sent');
    await click('Send comment');
    await waitFor(async () => (await rows(
      'SELECT comment FROM public.answer_comments WHERE session_id = $1 AND user_id = $2',
      [first.id, alice.id],
    ))[0]?.comment === 'Same, honestly.', 'the comment should be stored');

    await waitFor(() => document.querySelector('[data-my-comment]')?.textContent.includes('Same, honestly.'), 'Alice sees her own comment');
    assert.equal(document.querySelector('[aria-label="Say something about it"]'), null, 'one comment is all the reveal takes');
    assert(!document.querySelector('[data-partner-comment]'), 'Bob has not commented yet');
    assert(document.querySelector('[data-partner-quiet]')?.textContent.includes("hasn't said anything yet"), 'and the screen says so');
    assert(button('Say more in chat'), 'a second thought gets the chat instead');

    await asBob(() => discuss.saveComment(first.id, bob.id, 'Obviously the beach.'));
    await pushDiscuss('answer_comments', 'INSERT');
    await waitFor(() => document.querySelector('[data-partner-comment]')?.textContent.includes('Obviously the beach.'), 'Bob’s comment should arrive');

    // --- 5b. "Say more" opens the chat with the question attached -----------------------
    await click('Say more in chat');
    await waitFor(() => document.querySelector('[data-screen="chat"]'), 'the Chat tab should open');
    assert(document.querySelector('[data-chat-question-context]')?.textContent.includes('Beach holiday or city break?'), 'the composer carries the question');

    await type(document.querySelector('[aria-label="Message"]'), 'Because the sea air fixes everything.');
    await click('Send message');
    await waitFor(async () => (await rows(
      'SELECT session_id FROM public.messages WHERE couple_id = $1 AND session_id IS NOT NULL',
      [couple.id],
    )).length === 1, 'the message should be stored with its question link');
    assert.equal(document.querySelector('[data-chat-question-context]'), null, 'sending clears the attachment');
    await waitFor(() => document.querySelector(`[data-question-link="${first.id}"]`), 'the bubble quotes its question');
    assert(document.querySelector(`[data-question-link="${first.id}"]`)?.textContent.includes('Beach holiday or city break?'), 'and the quote is the question text');

    // --- 5c. Tapping the quote walks back to the revealed answers -----------------------
    await click('Open this question');
    await waitFor(() => document.querySelector('[data-session-screen="revealed"]'), 'the question reopens on its reveal');
    assert.equal(document.querySelector('[data-question-text]')?.textContent, 'Beach holiday or city break?');
    assert(document.querySelector('[data-reveal-card="mine"]')?.textContent.includes('Beach'), 'her answer is right there');
    assert(document.querySelector('[data-reveal-card="partner"]')?.textContent.includes('City'), 'and his beside it');

    // --- 6. A question asked from the other phone badges this one -----------------------
    await click('Home');
    const asked = await asBob(() => discuss.askPartner('q-sunday'));
    await pushDiscuss('question_sessions', 'INSERT', { id: asked.sessionId, couple_id: couple.id });
    await waitFor(() => document.querySelector('[data-nav-badge="discuss"]')?.textContent.trim() === '1', 'an unanswered question badges the tab');
    assert.equal(button('Discuss, 1 question waiting')?.getAttribute('aria-label'), 'Discuss, 1 question waiting');

    // --- 7. Ranking: drag order is what gets stored -------------------------------------
    await click('[data-nav-tab="discuss"]');
    await waitFor(() => document.querySelector('[data-discuss-pending]')?.textContent.trim() === '1', 'the tab repeats the count in its header');
    await click('Question history');
    await waitFor(() => document.querySelector('[data-discuss-history]'), 'history should list the sessions');
    const historyRows = [...document.querySelectorAll('[data-history-item]')];
    assert.equal(historyRows.length, 2, 'both sessions are in the history');
    const sundayRow = document.querySelector(`[data-history-item="${asked.sessionId}"]`);
    assert.equal(sundayRow?.getAttribute('data-history-state'), 'your-turn', 'the one Alice has not answered says so');
    assert(!sundayRow?.textContent.includes('Beach'), 'history leaks no answers');

    // --- 6b. The filter narrows the history to one category ------------------------------
    assert.equal(document.querySelector('[data-history-filter-label]')?.textContent, 'Filter', 'the filter starts wide open');
    await click('[data-history-filter]');
    await waitFor(() => document.querySelector('[data-history-filter-menu]'), 'the filter opens a menu');
    const filterOptions = [...document.querySelectorAll('[data-history-filter-option]')]
      .map((item) => item.getAttribute('data-history-filter-option'));
    assert(filterOptions.includes('Fun'), 'the menu holds the library categories');
    assert(filterOptions.includes('Home Life'), 'every category is offered, not just the asked ones');
    await click('[data-history-filter-option="Home Life"]');
    await waitFor(() => document.querySelectorAll('[data-history-item]').length === 1, 'the list narrows to that category');
    assert(document.querySelector('[data-history-item]')?.textContent.includes('Rank your perfect Sunday'), 'and keeps the right question');
    assert.equal(document.querySelector('[data-history-filter-label]')?.textContent, 'Home Life', 'the button says what is chosen');
    assert.equal(document.querySelector('[data-history-filter]')?.getAttribute('data-filter-active'), 'true', 'the chosen filter is marked');

    await click('[data-history-filter]');
    await waitFor(() => document.querySelector('[data-history-filter-menu]'), 'the menu opens again');
    await click('[data-history-filter-option="Money"]');
    await waitFor(() => document.querySelector('[data-history-empty]'), 'a category with nothing asked says so');
    assert(document.querySelector('[data-history-empty]')?.textContent.includes('Money'), 'and names the category');

    await click('[data-history-filter]');
    await waitFor(() => document.querySelector('[data-history-filter-menu]'), 'the menu opens once more');
    await click('[data-history-filter-option="all"]');
    await waitFor(() => document.querySelectorAll('[data-history-item]').length === 2, 'all categories brings the whole history back');
    assert.equal(document.querySelector('[data-history-filter-label]')?.textContent, 'Filter', 'and the filter is wide open again');

    await click(document.querySelector(`[data-history-item="${asked.sessionId}"]`));
    await waitFor(() => document.querySelector('[data-answer-input="ranking"]'), 'opening it should show the ranking input');
    assert.equal(document.querySelector('[data-question-text]')?.textContent, 'Rank your perfect Sunday');
    const ranks = () => [...document.querySelectorAll('[data-ranking-item]')]
      .map((item) => `${item.getAttribute('data-ranking-item')}=${item.getAttribute('data-rank')}`);
    assert.deepEqual(ranks(), ['Sleep in=1', 'Brunch=2', 'Walk=3', 'Film=4'], 'it starts in the imported order');
    assert(document.querySelector('[data-ranking-item="Film"]')?.getAttribute('draggable') === 'true', 'the list can be dragged');
    await click('Move Film up');
    assert.deepEqual(ranks(), ['Sleep in=1', 'Brunch=2', 'Film=3', 'Walk=4'], 'the buttons reorder without a pointer');
    assert(button('Move Sleep in up').disabled, 'the first item cannot move up');
    await click('Send my answer');
    await waitFor(() => document.querySelector('[data-session-screen="waiting"]'), 'ranking should seal the same way');
    await waitFor(async () => {
      const stored = await answersOf(asked.sessionId);
      return stored.length === 1 && JSON.stringify(stored[0].answer) === JSON.stringify(['Sleep in', 'Brunch', 'Film', 'Walk']);
    }, 'the reordered list is what the database stores');

    // --- 8. The other three input types -------------------------------------------------
    await click('Back to categories');
    await click('Home Life, 1 left');
    await click('[data-seriousness="2"]');
    await waitFor(() => document.querySelector('[data-discuss-question]'), 'Home Life level 2 is the chores question');
    assert.equal(document.querySelector('[data-question-text]')?.textContent, 'Chores you would rather skip');
    await click('Ask my partner');
    await waitFor(() => document.querySelector('[data-answer-input="multi_choice"]'), 'a multi_choice question ticks boxes');
    assert(button('Send my answer').disabled, 'at least one tick is required');
    await click(document.querySelector('[data-option="Dishes"]'));
    await click(document.querySelector('[data-option="Laundry"]'));
    assert(body().includes('2 selected'), 'the picker counts what is ticked');
    await click(document.querySelector('[data-option="Dishes"]'));
    assert(body().includes('1 selected'), 'tapping a tick again unticks it');
    await click(document.querySelector('[data-option="Dishes"]'));
    await click('Send my answer');
    const chores = await waitForStoredAnswer('q-chores');
    assert.deepEqual(chores.answer, ['Dishes', 'Laundry'], 'every ticked option is stored');

    await click('Back to categories');
    await click('Money, 1 left');
    await click('[data-seriousness="4"]');
    await waitFor(() => document.querySelector('[data-discuss-question]'), 'Money level 4 is the savings question');
    await click('Ask my partner');
    await waitFor(() => document.querySelector('[data-answer-input="slider"]'), 'a slider question gets a scale');
    assert.equal(document.querySelector('[data-slider-value]')?.textContent, '–', 'the scale starts unset');
    assert(button('Send my answer').disabled, 'an untouched slider cannot be sent');
    await type(document.querySelector('[aria-label="Your answer from 1 to 10"]'), '7');
    assert.equal(document.querySelector('[data-slider-value]')?.textContent, '7', 'the scale shows its value');
    await click('Send my answer');
    const savings = await waitForStoredAnswer('q-save');
    assert.equal(savings.answer, 7, 'the slider stores a number');

    await click('Back to categories');
    await click('Deep, 1 left');
    await click('[data-seriousness="5"]');
    await waitFor(() => document.querySelector('[data-discuss-question]'), 'Deep level 5 is the fear question');
    await click('Ask my partner');
    await waitFor(() => document.querySelector('[data-answer-input="text"]'), 'a text question gets a free-typing box');
    assert(body().includes('0/4000'), 'the box counts what has been written');
    await type(document.querySelector('[aria-label="Your answer"]'), 'That we run out of things to say.');
    assert(body().includes('33/4000'), 'the counter follows the typing');
    await click('Send my answer');
    const fear = await waitForStoredAnswer('q-fear');
    assert.equal(fear.answer, 'That we run out of things to say.', 'free typing is stored as written');

    // --- 9. Editing an answer before the partner replies --------------------------------
    await click('Edit my answer');
    await waitFor(() => document.querySelector('[data-session-screen="composer"]'), 'a sealed answer can still be edited');
    assert.equal(button('Save my new answer')?.textContent, 'Save my new answer');
    await type(document.querySelector('[aria-label="Your answer"]'), 'That we run out of things to say, and stop asking.');
    await click('Save my new answer');
    await waitFor(async () => (await answersOf(fear.session_id))[0].answer === 'That we run out of things to say, and stop asking.', 'the edit replaces the answer, it does not add one');
    assert.equal((await answersOf(fear.session_id)).length, 1, 'still exactly one answer from Alice');

    // --- 10. The 18+ gate needs both partners -------------------------------------------
    await click('Back to categories');
    const lockTile = document.querySelector('[data-category="Intimacy"]');
    assert.equal(lockTile?.getAttribute('data-adult-locked'), 'true', 'Intimacy is still locked while Bob has not agreed');
    await click('Turn on Intimacy questions in settings');
    await waitFor(() => document.querySelector('[data-adult-settings]'), 'the lock opens settings');
    assert(body().includes('Hidden until Bob agrees too'), 'the setting is honest about needing both');
    assert.equal(document.querySelector('[data-adult-status]')?.textContent, 'You: offBob: off');
    await click('Turn on Intimacy questions');
    await waitFor(() => document.querySelector('[data-adult-status]')?.textContent === 'You: onBob: off', 'the switch writes Alice’s row');
    assert.equal((await rows(
      'SELECT adult_questions_enabled FROM public.couple_settings WHERE couple_id = $1 AND user_id = $2',
      [couple.id, alice.id],
    ))[0].adult_questions_enabled, true, 'Alice opted in');
    assert.equal(document.querySelector('[role="switch"]')?.getAttribute('aria-label'), 'Turn off Intimacy questions');

    await click('Close settings');
    await waitFor(() => document.querySelector('[data-discuss-browse]'), 'closing settings returns to the categories');
    assert.equal(document.querySelector('[data-category="Intimacy"]')?.getAttribute('data-adult-locked'), 'true', 'one opt-in is not enough');

    await asBob(() => discuss.saveAdultPreference(couple.id, bob.id, true));
    await pushDiscuss('couple_settings', 'INSERT', { couple_id: couple.id, user_id: bob.id });
    await waitFor(() => document.querySelector('[data-category="Intimacy"][data-adult-locked]') === null, 'both opting in unlocks the shelf');
    await click('Intimacy, 1 left');
    await click('[data-seriousness="5"]');
    await waitFor(() => document.querySelector('[data-discuss-question]'), 'the unlocked shelf asks its question');
    assert.equal(document.querySelector('[data-question-text]')?.textContent, 'What should we try tonight?');
    assert(body().includes('18+'), 'the adult question is badged as such');

    // --- 11. Nothing is bundled: an empty library says to import the CSV -----------------
    await backend.exec(`
      DELETE FROM public.messages;
      DELETE FROM public.answer_comments;
      DELETE FROM public.answers;
      DELETE FROM public.question_sessions;
      DELETE FROM public.questions;
    `);
    await act(async () => { root.unmount(); });
    assert(realtime.removed > 0, 'leaving the tab closes its channels');
    const fresh = document.createElement('div');
    document.body.appendChild(fresh);
    const secondRoot = createRoot(fresh);
    await act(async () => { secondRoot.render(React.createElement(App)); });
    await waitFor(() => body().includes('Together for'), 'the app should mount again');
    await click('[data-nav-tab="discuss"]');
    await waitFor(() => document.querySelector('[data-discuss-empty]'), 'an empty library shows its own card');
    assert(body().includes('The question library is empty'), 'and says what to do about it');
    assert(body().includes('questions'), 'pointing at the table to import into');
    for (const text of ['Beach holiday or city break?', 'Rank your perfect Sunday', 'What should we try tonight?']) {
      assert(!body().includes(text), `"${text}" is only ever in the database, never in the bundle`);
    }

    await act(async () => { secondRoot.unmount(); });
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    await server.close();
    await backend?.close();
    dom.window.close();
  }
});
