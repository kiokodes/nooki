import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// Day separators are measured on the reader's own calendar day, so pin the process
// timezone to make "Yesterday" assertions deterministic.
process.env.TZ = 'UTC';

const DAY_MS = 86_400_000;

test('chat helpers: day separators, bubble times and day grouping', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const chatTime = await server.ssrLoadModule('/src/lib/chatTime.ts');
    const now = new Date(2026, 9, 15, 12, 0, 0);

    assert.equal(chatTime.dayKey(new Date(2026, 9, 15, 23, 59)), '2026-10-15');
    assert.equal(chatTime.dayKey(new Date(2026, 0, 2, 0, 1)), '2026-01-02', 'days are zero padded');
    assert.equal(chatTime.dayKey('rubbish'), '', 'an unparsable timestamp has no day');

    assert.equal(chatTime.formatDayLabel('2026-10-15', now), 'Today');
    assert.equal(chatTime.formatDayLabel('2026-10-14', now), 'Yesterday');
    assert.equal(chatTime.formatDayLabel('2026-10-12', now), 'Mon 12 October');
    assert.equal(chatTime.formatDayLabel('2025-12-31', now), 'Wed 31 December 2025', 'another year is spelled out');
    // Day offsets never drift across a month boundary.
    assert.equal(chatTime.dayOffset('2026-09-30', now), 15);
    assert.equal(chatTime.dayOffset('2026-09-15', now), 30);
    assert.equal(chatTime.dayOffset('rubbish', now), null);

    assert.equal(chatTime.formatMessageTime(new Date(2026, 9, 15, 21, 41)), '9:41 PM');
    assert.equal(chatTime.formatMessageTime(new Date(2026, 9, 15, 9, 5)), '9:05 AM');
    assert.equal(chatTime.formatMessageTime('rubbish'), '');

    assert.equal(chatTime.isSameDay(new Date(2026, 9, 15, 0, 5), new Date(2026, 9, 15, 23, 55)), true);
    assert.equal(chatTime.isSameDay(new Date(2026, 9, 15), new Date(2026, 9, 16)), false);

    // A transcript split into days keeps its order and its sequence.
    const groups = chatTime.groupMessagesByDay([
      { id: 'a', created_at: new Date(2026, 9, 14, 20, 0).toISOString() },
      { id: 'b', created_at: new Date(2026, 9, 14, 21, 0).toISOString() },
      { id: 'c', created_at: new Date(2026, 9, 15, 9, 0).toISOString() },
    ], now);
    assert.deepEqual(groups.map((group) => group.label), ['Yesterday', 'Today']);
    assert.deepEqual(groups[0].messages.map((message) => message.id), ['a', 'b']);
    assert.deepEqual(groups[1].messages.map((message) => message.id), ['c']);
    assert.equal(groups[0].key, '2026-10-14');

    // A corrupted timestamp groups into its own bucket instead of breaking the render.
    const odd = chatTime.groupMessagesByDay([{ id: 'x', created_at: 'nonsense' }], now);
    assert.equal(odd.length, 1);
    assert.equal(odd[0].key, '');
  } finally {
    await server.close();
  }
});

test('messages: couple-scoped RLS, read receipts, immutability and safe re-migration', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  let backend;
  try {
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const chat = await server.ssrLoadModule('/src/lib/chatService.ts');
    // Distinct statements can otherwise share a microsecond and tie on created_at.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

    // Alice and Bob share a couple. Alice writes first.
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    const first = await chat.sendMessage(couple.id, alice.id, '  Hello love  ');
    assert.equal(first.content, 'Hello love', 'the message is trimmed');
    assert.equal(first.type, 'text', "'text' is the everyday message type");
    assert.equal(first.read_at, null, 'a new message starts unread');
    assert.equal(first.couple_id, couple.id);
    assert.equal(first.sender_id, alice.id);

    await settle();
    const paragraphs = await chat.sendMessage(couple.id, alice.id, 'Line one\n\nLine two');
    assert.equal(paragraphs.content, 'Line one\n\nLine two', 'paragraph breaks survive the database');

    // The other three types exist now so the Discuss tab can reuse this log.
    await settle();
    const question = await chat.sendMessage(couple.id, alice.id, 'What is your favourite memory of us?', 'question');
    assert.equal(question.type, 'question');
    await settle();
    await auth.signInWithEmail('bob@example.com', 'password');
    const answer = await chat.sendMessage(couple.id, bob.id, 'The night we met.', 'answer');
    assert.equal(answer.type, 'answer');
    await auth.signInWithEmail('alice@example.com', 'password');
    await settle();
    const note = await chat.sendMessage(couple.id, alice.id, 'Prompt of the day', 'system');
    assert.equal(note.type, 'system');

    const asAlice = await chat.fetchMessages(couple.id);
    assert.equal(asAlice.length, 5);
    assert.equal(asAlice[0].id, first.id, 'the transcript starts with the oldest message');
    assert.equal(asAlice[asAlice.length - 1].id, note.id, 'and ends with the newest');

    // Validation happens before anything is sent.
    await assert.rejects(chat.sendMessage(couple.id, alice.id, '   '), /write a message/);
    await assert.rejects(chat.sendMessage(couple.id, alice.id, `x${'y'.repeat(4000)}`), /4000 characters/);
    await backend.resetRole();
    await assert.rejects(
      backend.query('INSERT INTO public.messages (couple_id, sender_id, content, type) VALUES ($1, $2, $3, $4)',
        [couple.id, alice.id, 'Nope', 'shout']),
      /messages_type_check|check constraint/i,
      'an unknown message type is rejected by the database too',
    );

    // Bob reads the chat: exactly the messages he did not write get a receipt.
    await auth.signInWithEmail('bob@example.com', 'password');
    const stamped = await chat.markMessagesRead(couple.id, bob.id);
    assert.equal(stamped.length, 4, "the reader stamps the partner's messages only");
    assert(stamped.every((row) => row.read_at), 'receipts carry a timestamp');
    const seenByBob = await chat.fetchMessages(couple.id);
    assert.equal(seenByBob.filter((row) => row.sender_id === alice.id).every((row) => row.read_at), true,
      'the sender can see the read receipt');
    assert.equal(seenByBob.find((row) => row.id === answer.id).read_at, null, 'your own message is not stamped by you');
    assert.equal((await chat.markMessagesRead(couple.id, bob.id)).length, 0, 'marking read twice is a no-op');

    // Alice reads Bob's reply.
    await auth.signInWithEmail('alice@example.com', 'password');
    await chat.markMessagesRead(couple.id, alice.id);
    assert.notEqual((await chat.fetchMessages(couple.id)).find((row) => row.id === answer.id).read_at, null);

    // Its type is frozen, and only the recipient ever stamps a receipt — never the sender.
    await backend.resetRole();
    await assert.rejects(
      backend.query('UPDATE public.messages SET type = $1 WHERE id = $2', ['answer', first.id]),
      /frozen|cannot be edited/i,
      'the message type is frozen',
    );
    await assert.rejects(
      backend.query('UPDATE public.messages SET read_at = now() WHERE id = $1', [first.id]),
      /cannot mark your own message as read/i,
      'the sender cannot stamp their own bubble',
    );

    // Unpaired accounts and other couples see nothing, and cannot write into this chat.
    const stranger = (await auth.signUpWithEmail('third@example.com', 'password')).user;
    await auth.saveOnboardingProfile(stranger.id, { name: 'Third', location: null, timezone: 'UTC' });
    assert.deepEqual(await chat.fetchMessages(couple.id), [], 'an unpaired account reads nothing');
    await assert.rejects(chat.sendMessage(couple.id, stranger.id, 'Sneaky'), /row-level security|violates/i);

    const carol = (await auth.signUpWithEmail('carol@example.com', 'password')).user;
    await auth.saveOnboardingProfile(carol.id, { name: 'Carol', location: null, timezone: 'UTC' });
    const dave = (await auth.signUpWithEmail('dave@example.com', 'password')).user;
    await auth.saveOnboardingProfile(dave.id, { name: 'Dave', location: null, timezone: 'UTC' });
    const otherCouple = (await auth.createCouple(dave.id, '2021-01-01')).couple;
    await auth.signInWithEmail('carol@example.com', 'password');
    await auth.joinCoupleWithCode(carol.id, otherCouple.invite_code);
    const carolHello = await chat.sendMessage(otherCouple.id, carol.id, 'Our own chat');
    assert.deepEqual(await chat.fetchMessages(couple.id), [], "another couple's chat is sealed");
    await assert.rejects(chat.sendMessage(couple.id, carol.id, 'Butting in'), /row-level security|violates/i);

    // --- "Say more": a message can point back at one of the couple's own questions ------
    await backend.exec(`INSERT INTO public.questions (id, text, category, seriousness, input_type, options)
                        VALUES ('q-link', 'Beach holiday or city break?', 'fun', 1, 'choice', '["Beach","City"]')`);
    await auth.signInWithEmail('alice@example.com', 'password');
    const { data: aliceAsked } = await supabase.rpc('ask_question', { p_question: 'q-link' });
    const aliceSession = aliceAsked.session_id;
    await auth.signInWithEmail('carol@example.com', 'password');
    const { data: carolAsked } = await supabase.rpc('ask_question', { p_question: 'q-link' });
    const foreignSession = carolAsked.session_id;
    assert.notEqual(foreignSession, aliceSession, 'each couple gets its own session for one question');

    await auth.signInWithEmail('alice@example.com', 'password');
    const linked = await chat.sendMessage(couple.id, alice.id, 'Because the sea air fixes everything.', 'text', aliceSession);
    assert.equal(linked.session_id, aliceSession, 'the message keeps the link to its question');
    await settle();
    const ordinary = await chat.sendMessage(couple.id, alice.id, 'And unrelated: hello again.');
    assert.equal(ordinary.session_id, null, 'an ordinary message has no link');

    // The link may only point at this couple's own question.
    await assert.rejects(
      chat.sendMessage(couple.id, alice.id, 'Sneaky link', 'text', foreignSession),
      /row-level security|violates/i,
      "quoting another couple's question is refused",
    );

    // And once sent, the link is frozen with the rest of the row.
    await backend.resetRole();
    await assert.rejects(
      backend.query('UPDATE public.messages SET session_id = NULL WHERE id = $1', [linked.id]),
      /cannot be edited|frozen/i,
    );

    // --- Swipe-to-reply: a message can quote any earlier one in this chat ---------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const reply = await chat.sendMessage(couple.id, alice.id, 'Back to your note: yes.', 'text', null, answer.id);
    assert.equal(reply.reply_to_id, answer.id, 'the reply keeps the id it answers');
    assert.equal(reply.session_id, null, 'a plain reply quotes no Discuss question');

    // Quoting another couple's message is refused row by row, like a foreign question.
    await assert.rejects(
      chat.sendMessage(couple.id, alice.id, 'Sneaky reply', 'text', null, carolHello.id),
      /row-level security|violates|foreign key/i,
      "quoting another couple's message is refused",
    );

    // What a message answers is frozen with it.
    await backend.resetRole();
    await assert.rejects(
      backend.query('UPDATE public.messages SET reply_to_id = NULL WHERE id = $1', [reply.id]),
      /frozen/i,
    );

    // --- Editing: only the author, only the words, stamped by the server ----------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const bareAgain = (await chat.fetchMessages(couple.id)).find((row) => row.id === first.id);
    assert.equal(bareAgain.edited_at, null, 'a fresh message is not edited');
    const edited = await chat.editMessage(couple.id, alice.id, first.id, 'Hello love ✨');
    assert.equal(edited.content, 'Hello love ✨');
    assert(edited.edited_at, 'editing stamps edited_at');
    assert.notEqual(edited.edited_at, edited.created_at, 'the stamp is the edit, not the birth');

    await assert.rejects(chat.editMessage(couple.id, alice.id, reply.id, '   '), /write a message/);
    await assert.rejects(chat.editMessage(couple.id, alice.id, reply.id, `x${'y'.repeat(4000)}`), /4000 characters/);

    // The partner cannot touch your words: the service finds no row, the database finds no pass.
    await auth.signInWithEmail('bob@example.com', 'password');
    await assert.rejects(
      chat.editMessage(couple.id, bob.id, first.id, 'Not my words.'),
      /only edit your own messages/i,
    );
    const bobAttempt = await supabase.from('messages').update({ content: 'Not my words.' }).eq('id', first.id);
    assert(bobAttempt.error, 'the database refuses too');
    assert.match(bobAttempt.error.message, /only edit your own messages/i);

    // The stamp only moves with the words — nobody can set it by hand.
    await auth.signInWithEmail('alice@example.com', 'password');
    const fakeStamp = await supabase.from('messages').update({ edited_at: new Date().toISOString() }).eq('id', linked.id);
    assert(fakeStamp.error, 'edited_at cannot be forged');
    assert.match(fakeStamp.error.message, /edit stamp/i);

    // A read receipt only travels one way.
    await backend.resetRole();
    await assert.rejects(
      backend.query('UPDATE public.messages SET read_at = NULL WHERE id = $1', [first.id]),
      /read receipt|mark your own/i,
      'a stamped receipt cannot be taken back',
    );

    // The migration is safe to rerun on a populated project.
    const migration = await readFile(new URL('../supabase/migrations/202610150003_messages.sql', import.meta.url), 'utf8');
    const linksMigration = await readFile(new URL('../supabase/migrations/202610150005_discuss_comments_chat_links.sql', import.meta.url), 'utf8');
    const repliesMigration = await readFile(new URL('../supabase/migrations/202610150006_chat_replies_edits.sql', import.meta.url), 'utf8');
    await backend.exec(migration);
    await backend.exec(migration);
    await backend.exec(linksMigration);
    await backend.exec(linksMigration);
    await backend.exec(repliesMigration);
    await backend.exec(repliesMigration);
    await auth.signInWithEmail('alice@example.com', 'password');
    const afterRerun = await chat.fetchMessages(couple.id);
    assert.equal(afterRerun.length, 8, 'rerunning the migration keeps the transcript');
    assert.equal(afterRerun[0].content, 'Hello love ✨', 'and keeps the edit');
    assert(afterRerun[0].edited_at, 'and the edit stamp');
    assert.equal(afterRerun.find((row) => row.id === linked.id).session_id, aliceSession, 'and keeps the question link');
    assert.equal(afterRerun.find((row) => row.id === reply.id).reply_to_id, answer.id, 'and keeps the quoted reply');

    // Ending the couple takes the chat with it.
    await auth.requestOrConfirmBreakup();
    await auth.signInWithEmail('bob@example.com', 'password');
    assert.equal((await auth.requestOrConfirmBreakup()).status, 'ended');
    await backend.resetRole();
    const remaining = await backend.query('SELECT count(*)::int AS count FROM public.messages');
    assert.equal(remaining.rows[0].count, 1, "only the other couple's chat is left");
  } finally {
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
  }
});

test('chat tab: live bubbles, receipts, typing, unread badge and day grouping', async () => {
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
    const chat = await server.ssrLoadModule('/src/lib/chatService.ts');
    const chatTime = await server.ssrLoadModule('/src/lib/chatTime.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    // A realtime stand-in: one fake socket per topic, recording what the app sends and
    // replaying whatever the test hands it, the way the live server would.
    const realtime = { topics: new Map(), sent: [], removed: 0 };
    const makeChannel = (topic, options) => {
      const handlers = [];
      const channel = {
        topic,
        options,
        handlers,
        presenceState: () => ({}),
        on(type, filter, handler) {
          handlers.push({ type, event: filter.event, handler });
          return channel;
        },
        subscribe(callback) {
          callback?.('SUBSCRIBED');
          return channel;
        },
        async track() { return 'ok'; },
        async send(message) { realtime.sent.push({ topic, ...message }); return 'ok'; },
        async unsubscribe() { return 'ok'; },
      };
      realtime.topics.set(topic, channel);
      return channel;
    };
    supabase.channel = (topic, options) => makeChannel(topic, options);
    supabase.removeChannel = async () => { realtime.removed += 1; return 'ok'; };

    const body = () => document.body.textContent.replace(/\u2019/g, "'");
    // Labels are not unique across the document (the Chat screen and its tab share one),
    // so tab and control lookups are always scoped to what they are.
    const button = (label) => [...document.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === label);
    const field = (label) => document.querySelector(`[aria-label="${label}"]`);
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (await predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };
    const pushMessage = async (row, event = 'INSERT') => {
      const channel = realtime.topics.get(chat.chatTopic(couple.id));
      assert(channel, 'the chat channel is subscribed');
      await act(async () => {
        for (const entry of channel.handlers.filter((item) => item.event === event)) entry.handler({ new: row });
      });
    };
    const pushTyping = async (payload) => {
      const channel = realtime.topics.get(chat.chatTopic(couple.id));
      await act(async () => {
        for (const entry of channel.handlers.filter((item) => item.type === 'broadcast')) entry.handler({ payload });
      });
    };
    // Test-side writes happen as Bob, then hand the phone back to Alice, the way a
    // second device would behave.
    const asBob = async (work) => {
      await auth.signInWithEmail('bob@example.com', 'password');
      const result = await work();
      await auth.signInWithEmail('alice@example.com', 'password');
      return result;
    };

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => body().includes('Together for'), 'the unlocked app should render');

    // Bob is on the couple channel: the global header says so.
    const presenceChannel = realtime.topics.get(`nooki-couple-${couple.id}`);
    assert(presenceChannel, 'the presence channel is subscribed');
    assert.equal(presenceChannel.options?.config?.presence?.key, alice.id, 'presence is keyed by account');
    presenceChannel.presenceState = () => ({ [bob.id]: [{ user_id: bob.id }] });
    await act(async () => {
      for (const entry of presenceChannel.handlers.filter((item) => item.event === 'sync')) entry.handler({ event: 'sync' });
    });

    // --- Opening the Chat tab ----------------------------------------------------------
    await act(async () => { button('Chat').click(); });
    assert(document.querySelector('[data-screen="chat"]'), 'the Chat tab is a real screen now');
    assert.equal(document.querySelector('[data-nav-badge="chat"]'), null, 'nothing unread yet');
    const chatHeader = document.querySelector('[data-chat-header]');
    assert(chatHeader, 'the conversation bar renders');
    assert.equal(document.querySelector('[data-partner-name]').textContent, 'Bob', "the header shows the partner's name");
    assert.equal(document.querySelector('[data-partner-status]').dataset.status, 'online', 'the header shows they are online');
    assert(chatHeader.textContent.includes('Online'), 'the status reads as a word, not a colour');
    assert(button('Voice call'), 'the phone button is in the header');
    assert(button('Video call'), 'the video button is in the header');
    await waitFor(() => document.querySelector('[data-chat-empty]'), 'the empty state should show');
    assert(body().includes('Say hi to Bob'), 'the empty state invites the first message');
    assert.equal(button('Send message').disabled, true, 'there is nothing to send yet');

    // --- Typing says so, and Enter sends -------------------------------------------------
    const setTextareaValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    const fill = async (value) => act(() => {
      setTextareaValue.call(field('Message'), value);
      field('Message').dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await fill('Hi Bob');
    const typingPings = realtime.sent.filter((message) => message.event === 'typing');
    assert.equal(typingPings.length, 1, 'typing is announced to the partner');
    assert.equal(typingPings[0].payload.user_id, alice.id);
    assert.equal(typingPings[0].payload.typing, true);

    // Shift+Enter is the paragraph break: it must never send.
    await act(async () => {
      field('Message').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.equal(field('Message').value, 'Hi Bob', 'Shift+Enter left the draft alone');
    assert.equal((await chat.fetchMessages(couple.id)).length, 0, 'Shift+Enter did not send anything');
    assert.equal(document.querySelectorAll('[data-mine="true"]').length, 0, 'and no bubble appeared');

    // Enter sends, the way it does on a laptop keyboard.
    await act(async () => {
      field('Message').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitFor(() => document.querySelectorAll('[data-mine="true"]').length === 1, 'Enter sent the message');
    const sentBubble = () => document.querySelector('[data-mine="true"]');
    assert.equal(sentBubble().dataset.messageType, 'text');
    assert.equal(sentBubble().textContent.includes('Hi Bob'), true, 'the bubble shows the message');
    assert.match(sentBubble().style.backgroundColor, /249,\s*168,\s*212/, "your bubble is Nooki's pink");
    assert.equal(field('Message').value, '', 'the composer empties after sending');
    assert.equal(button('Send message').disabled, true, 'and the send button goes quiet again');
    await waitFor(() => sentBubble().querySelector('[data-receipt="sent"]'), 'a delivered message gets one check');

    // --- Sending with the send button ---------------------------------------------------
    await fill('Hi Bob\nHow was your day?');
    await act(async () => { button('Send message').click(); });
    await waitFor(() => document.querySelectorAll('[data-mine="true"]').length === 2, 'the message should appear at once');
    assert.equal(document.querySelectorAll('[data-mine="true"]')[1].textContent.includes('How was your day?'), true,
      'the bubble shows the message');
    assert.equal(field('Message').value, '', 'the composer empties after sending');
    assert.equal(button('Send message').disabled, true, 'and the send button goes quiet again');

    const stored = await chat.fetchMessages(couple.id);
    assert.equal(stored.length, 2, 'both messages reached the database');
    assert.equal(stored[0].content, 'Hi Bob', 'the one sent with Enter arrived as typed');
    assert.equal(stored[1].content, 'Hi Bob\nHow was your day?', 'paragraph breaks are kept');
    assert.equal(stored[0].read_at, null, 'nobody has read it yet');

    // --- Bob replies: instant delivery, day separators and the unread badge -------------
    await act(async () => { button('Home').click(); });
    assert(document.querySelector('[data-card="today"]'), 'back on the Home tab');
    const yesterday = new Date(Date.now() - DAY_MS);
    const bobYesterday = await asBob(async () => {
      const { data } = await supabase.from('messages').insert({
        couple_id: couple.id,
        sender_id: bob.id,
        content: 'Slept badly, thinking of you.',
        type: 'text',
        created_at: yesterday.toISOString(),
      }).select('*').single();
      return data;
    });
    assert(bobYesterday, "the partner's message was stored");
    await pushMessage(bobYesterday);
    await waitFor(() => document.querySelector('[data-nav-badge="chat"]'), 'the unread badge appears while on Home');
    assert.equal(document.querySelector('[data-nav-badge="chat"]').textContent, '1');
    assert(button('Chat, 1 unread message'), 'the chat tab announces one unread message');

    const bobToday = await asBob(() => chat.sendMessage(couple.id, bob.id, 'Can I call you tonight?'));
    await pushMessage(bobToday);
    await waitFor(
      () => document.querySelector('[data-nav-badge="chat"]')?.textContent === '2',
      'the badge counts every unread message',
    );

    // --- Reading it: badge clears, receipts are stamped ---------------------------------
    await act(async () => { button('Chat, 2 unread messages').click(); });
    assert.equal(document.querySelector('[data-nav-badge="chat"]'), null, 'opening the chat clears the badge');
    await waitFor(() => document.querySelectorAll('[data-mine="false"]').length === 2, 'both replies are on screen');
    const partnerBubbles = () => [...document.querySelectorAll('[data-mine="false"]')];
    assert.equal(partnerBubbles()[0].textContent.includes('thinking of you'), true, 'the older reply is first');
    assert.equal(partnerBubbles()[1].textContent.includes('Can I call you tonight?'), true);

    const dividers = [...document.querySelectorAll('[data-day-divider]')].map((node) => node.textContent);
    assert.deepEqual(dividers, ['Yesterday', 'Today'], 'the transcript is grouped by day');
    assert.equal(document.querySelector('[data-day-divider]').dataset.dayDivider, chatTime.dayKey(bobYesterday.created_at),
      'the separator names the day it groups');

    await waitFor(
      async () => (await chat.fetchMessages(couple.id)).filter((row) => row.sender_id === bob.id).every((row) => row.read_at),
      'opening the chat stamps the read receipts in the database',
    );
    const afterReading = await chat.fetchMessages(couple.id);
    assert.equal(afterReading.find((row) => row.sender_id === alice.id).read_at, null, 'and never your own messages');

    // Bob reads Alice's message: her bubble turns into a double check, live.
    const readRow = await asBob(async () => {
      await chat.markMessagesRead(couple.id, bob.id);
      return (await chat.fetchMessages(couple.id)).find((row) => row.id === stored[0].id);
    });
    assert(readRow.read_at, "Bob's receipt was stored");
    await pushMessage(readRow, 'UPDATE');
    await waitFor(() => sentBubble().querySelector('[data-receipt="read"]'), 'the sender sees two checks once it is read');

    // --- Typing indicator ----------------------------------------------------------------
    await pushTyping({ user_id: bob.id, typing: true });
    assert(document.querySelector('[data-typing-indicator]'), 'the typing bubble shows');
    assert.equal(document.querySelector('[data-partner-status]').dataset.status, 'typing');
    assert(document.querySelector('[data-partner-status]').textContent.includes('typing'), 'the header says so too');
    await pushTyping({ user_id: bob.id, typing: false });
    assert.equal(document.querySelector('[data-typing-indicator]'), null, 'and it goes away when they stop');
    await pushTyping({ user_id: alice.id, typing: true });
    assert.equal(document.querySelector('[data-typing-indicator]'), null, 'our own keystrokes never show as theirs');

    // --- Auto-scroll --------------------------------------------------------------------
    const list = document.querySelector('[data-chat-messages]');
    Object.defineProperty(list, 'scrollHeight', { value: 640, configurable: true });
    list.scrollTop = 0;
    const bobAgain = await asBob(() => chat.sendMessage(couple.id, bob.id, 'Still here 💕'));
    await pushMessage(bobAgain);
    await waitFor(() => list.scrollTop === 640, 'the list pins itself to the newest message');

    // --- A failed send can be retried ----------------------------------------------------
    const originalFrom = supabase.from;
    supabase.from = (table) => (table === 'messages'
      ? { insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: 'Network blip', code: '08006' } }) }) }) }
      : originalFrom(table));
    await fill('This one fails');
    await act(async () => { button('Send message').click(); });
    await waitFor(() => document.querySelector('[data-retry-message]'), 'a failed message offers a retry');
    assert(document.querySelector('[data-chat-error]'), 'the reason is shown');
    await act(async () => { button('Dismiss error').click(); });
    assert.equal(document.querySelector('[data-chat-error]'), null, 'the reason can be dismissed');
    supabase.from = originalFrom;
    assert.equal((await chat.fetchMessages(couple.id)).some((row) => row.content === 'This one fails'), false,
      'nothing was stored');
    await act(async () => { document.querySelector('[data-retry-message]').click(); });
    await waitFor(() => document.querySelector('[data-retry-message]') === null, 'the retry clears the failure');
    await waitFor(
      async () => (await chat.fetchMessages(couple.id)).some((row) => row.content === 'This one fails'),
      'the retry delivers the message',
    );

    // --- Swipe-to-reply: drag a message toward the transcript ------------------------------
    // A pointer drag on a delivered bubble: down, sideways past the trigger, up.
    const firePointer = async (target, type, x, y) => act(() => {
      target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    });
    const bobRow = () => document.querySelector(`[data-message-row="${bobAgain.id}"]`);
    assert(bobRow(), "the partner's bubble is on screen");

    await firePointer(bobRow(), 'pointerdown', 300, 120);
    await firePointer(bobRow(), 'pointermove', 372, 122);
    await firePointer(bobRow(), 'pointerup', 372, 122);
    await waitFor(() => document.querySelector('[data-reply-context]'), 'the swipe opens the reply bar');
    assert(document.querySelector('[data-reply-context]').textContent.includes('Replying to Bob'),
      'the bar says who you are answering');
    assert(document.querySelector('[data-reply-context]').textContent.includes('Still here'),
      'and quotes their message');

    // It can be dismissed before anything is typed.
    await act(async () => { button('Clear reply').click(); });
    assert.equal(document.querySelector('[data-reply-context]'), null, 'clearing drops the reply');

    // Swiping again, this time the message actually goes.
    await firePointer(bobRow(), 'pointerdown', 300, 120);
    await firePointer(bobRow(), 'pointermove', 372, 122);
    await firePointer(bobRow(), 'pointerup', 372, 122);
    await waitFor(() => document.querySelector('[data-reply-context]'), 'the reply bar is back');
    await fill('Always. 💛');
    await act(async () => { button('Send message').click(); });
    await waitFor(async () => (await chat.fetchMessages(couple.id)).some((row) => row.reply_to_id === bobAgain.id),
      'the reply was stored with its quote');
    assert.equal(document.querySelector('[data-reply-context]'), null, 'sending clears the reply bar');
    await waitFor(() => document.querySelector(`[data-reply-quote="${bobAgain.id}"]`), 'the bubble quotes it too');
    assert(document.querySelector(`[data-reply-quote="${bobAgain.id}"]`).textContent.includes('Still here'),
      'the quote shows the original words');
    assert(document.querySelector(`[data-reply-quote="${bobAgain.id}"]`).textContent.includes('Bob'),
      'and who wrote them');

    // Tapping the quote walks back to the original bubble.
    await act(async () => { document.querySelector(`[data-reply-quote="${bobAgain.id}"]`).click(); });
    assert.equal(
      document.querySelector(`[data-message-id="${bobAgain.id}"]`)?.getAttribute('data-highlighted'),
      'true',
      'the original bubble lights up',
    );

    // --- The action menu: long press (or right click), Reply for all, Edit for yours ------
    // The second of your own messages — the one with the paragraph break in it.
    const ownRow = () => document.querySelector(`[data-message-row="${stored[1].id}"]`);
    await act(() => {
      bobRow().dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => document.querySelector('[data-message-actions]'), 'the menu opens');
    assert(button('Reply'), 'every message can be answered');
    assert(!button('Edit'), "but the partner's words are not yours to edit");
    await act(async () => { button('Close menu').click(); });
    assert.equal(document.querySelector('[data-message-actions]'), null, 'the menu closes');

    await act(() => {
      ownRow().dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => document.querySelector('[data-message-actions]'), 'the menu opens on your bubble');
    assert(button('Reply'), 'you can answer your own message');
    assert(button('Edit'), 'and fix your own words');

    // --- Edit: the box starts with the original words and Save is the send button --------
    await act(async () => { button('Edit').click(); });
    await waitFor(() => document.querySelector('[data-edit-context]'), 'the edit bar opens');
    assert(document.querySelector('[data-edit-context]').textContent.includes('Editing message'));
    await waitFor(() => field('Message').value === 'Hi Bob\nHow was your day?', 'the box starts with the original words');
    assert(!button('Send message'), 'sending is saving while you edit');
    assert(button('Save edit'), 'under a new name');
    await fill('Hi Bob\nHow was your day? ❤️');
    await act(async () => { button('Save edit').click(); });
    await waitFor(async () => {
      const row = (await chat.fetchMessages(couple.id)).find((item) => item.id === stored[1].id);
      return row?.content === 'Hi Bob\nHow was your day? ❤️' && row.edited_at;
    }, 'the edit was stored with its stamp');
    assert.equal(document.querySelector('[data-edit-context]'), null, 'saving closes the edit bar');
    assert.equal(field('Message').value, '', 'and the composer is a blank new message again');
    await waitFor(() => ownRow()?.querySelector('[data-edited="true"]'), 'the bubble is marked as edited');

    // --- The call buttons only say "coming soon" ------------------------------------------
    await act(async () => { button('Voice call').click(); });
    assert(document.querySelector('[data-toast]'), 'the phone button shows a toast');
    assert.match(document.querySelector('[data-toast]').textContent, /coming soon/i);
    assert.match(document.querySelector('[data-toast]').textContent, /voice/i);
    await act(async () => { button('Video call').click(); });
    assert.match(document.querySelector('[data-toast]').textContent, /coming soon/i, 'so does the video button');
    assert.match(document.querySelector('[data-toast]').textContent, /video/i, 'and it names the video call');
    assert.equal(realtime.removed, 0, 'nothing tore the chat channel down while the tab was open');

    // --- Leaving the tab keeps the chat alive ---------------------------------------------
    await act(async () => { button('Home').click(); });
    assert.equal(document.querySelector('[data-screen="chat"]'), null, 'the chat screen unmounts');
    assert(document.querySelector('[data-card="today"]'), 'and Home comes back');
    assert.equal(realtime.removed, 0, 'the live subscription is owned by the app, not the tab');
  } finally {
    await act(() => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});

test('design preview: the sample chat works without a backend', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const button = (label) => [...document.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label') === label);
    const chatTab = () => [...document.querySelectorAll('button')]
      .find((item) => item.getAttribute('aria-label')?.startsWith('Chat'));
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (await predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };

    const { AppPreview } = await server.ssrLoadModule('/src/preview/AppPreview.tsx');
    await act(async () => { root.render(React.createElement(AppPreview)); });
    assert(document.querySelector('[data-screen="splash"]'), 'the preview opens on the splash screen');
    await waitFor(() => document.querySelector('[data-card="today"]'), 'the sample Home tab should render');
    assert.equal(document.querySelector('[data-couple-initials]').getAttribute('aria-label'), 'Sam and Ana',
      'the preview uses the sample couple');

    // The Chat tab carries the sample conversation and its unread badge.
    assert.equal(chatTab().getAttribute('aria-label'), 'Chat, 3 unread messages',
      'the sample conversation starts with three unread messages from Ana');
    await act(async () => { chatTab().click(); });
    assert(document.querySelector('[data-screen="chat"]'), 'the preview shows the real chat');
    assert.equal(document.querySelector('[data-nav-badge="chat"]'), null, 'opening the chat clears the badge');
    const dividers = [...document.querySelectorAll('[data-day-divider]')].map((node) => node.textContent);
    assert.deepEqual(dividers, ['Yesterday', 'Today'], 'the sample transcript is grouped by day');
    assert.equal(document.querySelectorAll('[data-mine="false"]').length >= 2, true, "Ana's messages are on the left");

    // Typing, sending and the receipt sequence are all driven in memory.
    await act(async () => {
      [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Make Ana type')).click();
    });
    assert(document.querySelector('[data-typing-indicator]'), 'the typing indicator shows');
    await act(async () => {
      [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Ana is typing')).click();
    });
    assert.equal(document.querySelector('[data-typing-indicator]'), null, 'and stops again');

    const textarea = document.querySelector('[aria-label="Message"]');
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
    await act(() => {
      setValue.call(textarea, 'Paragraph one\n\nParagraph two');
      textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await act(async () => { button('Send message').click(); });
    const mine = () => [...document.querySelectorAll('[data-mine="true"]')].pop();
    assert.equal(mine().textContent.includes('Paragraph two'), true, 'the message shows straight away');
    assert(mine().querySelector('[data-receipt="sending"]'), 'as a pending bubble');
    await waitFor(() => mine().querySelector('[data-receipt="sent"]'), 'then it is delivered');
    await waitFor(() => mine().querySelector('[data-receipt="read"]'), 'and then read');

    // The partner's side is simulated from the control bar.
    await act(async () => {
      [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Ana sends a message')).click();
    });
    assert.equal(document.querySelectorAll('[data-mine="false"]').length, 5, "Ana's new message arrived while the chat is open");
    assert.equal(document.querySelector('[data-nav-badge="chat"]'), null, 'and it reads as read, because the chat was open');

    // Switching to Home and receiving one shows the unread badge, like the app.
    await act(async () => { button('Home').click(); });
    await act(async () => {
      [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Ana sends a message')).click();
    });
    assert.equal(document.querySelector('[data-nav-badge="chat"]').textContent, '1', 'the badge shows on the Home tab');
    assert(button('Chat, 1 unread message'), 'and the tab announces it');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
