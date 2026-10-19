import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Together's visit planning, Together-time scheduler, private/matched ideas, memories,
// and the book shelf's joint-progress copy are exercised through the real component.
test('Together tab: private wishes reveal together, plans are actionable, and memories/sessions open from one tap', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Event', 'MouseEvent', 'File', 'FileReader']) {
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
  const root = createRoot(document.getElementById('root'));
  try {
    const { TogetherView } = await server.ssrLoadModule('/src/components/together/TogetherView.tsx');
    const calls = [];
    const visit = {
      id: 'v1', couple_id: 'c1', start_date: '2099-01-10', end_date: '2099-01-11',
      location: 'Lagos', timezone: 'Africa/Lagos', is_tentative: false,
      created_by: 'me', created_at: '', updated_at: '',
    };
    const pastVisit = {
      ...visit, id: 'v-old', start_date: '2020-05-01', end_date: '2020-05-02', location: 'Abuja',
    };
    const idea = (id, text, overrides = {}) => ({
      id, couple_id: 'c1', text, details: null, sort_order: 0, visibility: 'open',
      visit_date: null, visit_id: null, wanters: [], completed: false, completed_at: null,
      created_by: 'me', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    });
    const sharedMatch = idea('idea-match', 'Try the night market', { wanters: ['me', 'partner'] });
    const privateIdea = idea('idea-private', 'A surprise for later', { visibility: 'private', wanters: ['me'] });
    const reading = {
      id: 'book-1', couple_id: 'c1', title: 'The Hobbit', file_path: 'books/c1/book-1.epub',
      file_type: 'epub', status: 'reading', uploaded_by: 'me', created_at: '', updated_at: '',
    };
    const state = {
      books: [reading],
      progress: [
        { book_id: reading.id, user_id: 'me', location: 'chapter six', percent: 42, updated_at: '' },
        { book_id: reading.id, user_id: 'partner', location: 'chapter six', percent: 40, updated_at: '' },
      ],
      highlights: [], loading: false, busy: false, error: null,
      upload: async (file) => { calls.push(['upload', file?.name]); return null; },
      continueReading: async () => {}, leave: async () => {}, finish: async () => {},
      remove: async () => {}, addHighlight: async () => { throw new Error('unused'); },
      saveProgress: async () => { throw new Error('unused'); }, clearError: () => {},
    };
    const session = {
      id: 'session-1', couple_id: 'c1', created_by: 'me', activity_type: 'game',
      activity_id: 'word-wheel', activity_name: 'Word Wheel', scheduled_at: '2099-01-10T18:00:00.000Z',
      timezone: 'Africa/Lagos', status: 'scheduled', proposed_by: 'me', agreed_by: 'partner',
      agreed_at: '2026-01-01T00:00:00Z', reminder_sent_at: null, created_at: '', updated_at: '',
    };
    const openReader = (id) => calls.push(['reader', id]);
    const onOpenActivity = (value) => calls.push(['openActivity', value.id]);
    const defaults = {
      state, userId: 'me', userName: 'Alice', partnerId: 'partner', partnerName: 'Ana', timezone: 'Africa/Lagos',
      visit, visits: [visit, pastVisit], onOpenReader: openReader,
      somedayItems: [sharedMatch, privateIdea],
      visitWishes: [{ id: 'wish-me', couple_id: 'c1', visit_id: 'v1', user_id: 'me', wish: 'A private answer', created_at: '', updated_at: '' }],
      visitChecklist: [], togetherTimeSessions: [session], memories: [],
      remindersEnabled: false,
      onPlanVisit: () => calls.push(['planVisit']),
      onSaveVisitWish: async (text) => calls.push(['saveWish', text]),
      onAddVisitChecklistItem: async (text, owner) => calls.push(['addChecklist', text, owner]),
      onUpdateVisitChecklistItem: async (id, update) => calls.push(['updateChecklist', id, update]),
      onDeleteVisitChecklistItem: async (id) => calls.push(['deleteChecklist', id]),
      onAttachSomedayItemToVisit: async (...args) => calls.push(['attach', args[0].id, args[1], args[2] ?? null]),
      onAddSomedayItem: async (...args) => calls.push(['addSomeday', ...args]),
      onUpdateSomedayItem: async (...args) => calls.push(['updateSomeday', args[0].id, args[3]]),
      onToggleSomedayWant: async (item) => calls.push(['want', item.id]),
      onDeleteSomedayItem: async (item) => calls.push(['deleteSomeday', item.id]),
      onProposeTogetherTime: async (input) => calls.push(['propose', input]),
      onAgreeTogetherTime: async (item) => calls.push(['agree', item.id]),
      onSuggestTogetherTime: async (item, scheduledAt, timezone) => calls.push(['suggest', item.id, scheduledAt, timezone]),
      onTalkAboutTogetherTime: async (item) => calls.push(['talk', item.id]),
      onUpdateTogetherTime: async (item, status) => calls.push(['updateSession', item.id, status]),
      onOpenActivity,
      onSaveVisitMemory: async (...args) => calls.push(['memory', ...args]),
      onClearInitialSession: () => calls.push(['clearDeepLink']),
    };
    const render = (overrides = {}) => act(async () => root.render(React.createElement(TogetherView, { ...defaults, ...overrides })));
    const setValue = async (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, 'value').set;
      await act(async () => {
        setter.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
      });
    };
    const click = async (element) => act(async () => element.click());
    const body = () => document.body.textContent.replace(/\u2019/g, "'");

    // The countdown and day-by-day plan sit first; a submitted wish itself is not shown.
    await render();
    assert(document.querySelector('[data-visit-card="upcoming"]'));
    assert(document.querySelector('[data-visit-day="2099-01-10"]'));
    assert(document.querySelector('[data-visit-day="2099-01-11"]'));
    assert(body().includes('Your answer is tucked away'));
    assert(!body().includes('A private answer'), 'an unanswered partner cannot see the submitted text');
    assert(body().includes('Shared checklist'));
    assert(body().includes('Tickets booked'));

    // An open someday idea can be placed on a specific visit day; a private one is never offered.
    const daySelect = document.querySelector('[aria-label="Choose a someday idea for Sun, Jan 10"]')
      || document.querySelector('[aria-label^="Choose a someday idea for"]');
    assert(daySelect);
    assert([...daySelect.options].some((option) => option.textContent === 'Try the night market'));
    assert(![...daySelect.options].some((option) => option.textContent === 'A surprise for later'));
    await setValue(daySelect, 'idea-match');
    const addIdeaButton = document.querySelector('[aria-label^="Add idea to"]');
    await click(addIdeaButton);
    assert.deepEqual(calls.pop(), ['attach', 'idea-match', 'v1', '2099-01-10']);

    // Checklist rows have one owner; both partners can be chosen when adding an item.
    await setValue(document.querySelector('[aria-label="New checklist item"]'), 'Book the train');
    await setValue(document.querySelector('[aria-label="Assign checklist item to"]'), 'partner');
    const checklistForm = document.querySelector('[data-visit-checklist] form');
    await act(async () => checklistForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    assert.deepEqual(calls.pop(), ['addChecklist', 'Book the train', 'partner']);

    // After both wishes exist, both texts are revealed together.
    await render({ visitWishes: [
      ...defaults.visitWishes,
      { id: 'wish-partner', couple_id: 'c1', visit_id: 'v1', user_id: 'partner', wish: 'A quiet breakfast', created_at: '', updated_at: '' },
    ] });
    assert(document.querySelector('[data-wishes-revealed]'));
    assert(body().includes('A private answer'));
    assert(body().includes('A quiet breakfast'));

    // A matched idea is explicit; single-vote ideas do not announce the other person's yes.
    assert.equal(document.querySelectorAll('[data-someday-match]').length, 1);
    assert(document.querySelector('[data-someday-item="idea-private"]'));
    assert.equal(document.querySelector('[data-someday-item="idea-private"]').getAttribute('data-someday-visibility'), 'private');
    await click(document.querySelector('[data-someday-want="idea-match"]'));
    assert.deepEqual(calls.pop(), ['want', 'idea-match']);

    // Read together lives inside Together time and never compares separate percentages.
    const togetherTime = document.querySelector('[data-section="together-time"]');
    assert(togetherTime.querySelector('[data-card="read-together"]'));
    assert(togetherTime.textContent.includes('The Hobbit'));
    assert(togetherTime.textContent.includes('around the middle of the story'));
    assert(!togetherTime.textContent.includes('%'));

    // A locked-in session says both partners agreed, and one tap opens that activity.
    assert(document.querySelector('[data-together-time-locked="session-1"]'));
    assert(body().includes('Locked in'));
    await click(document.querySelector('[data-open-scheduled-activity="session-1"]'));
    assert.deepEqual(calls.pop(), ['openActivity', 'session-1']);
    const typeSelect = document.querySelector('[aria-label="Together time activity type"]');
    await setValue(typeSelect, 'game');
    const activitySelect = document.querySelector('[aria-label="Choose a book or game"]');
    await setValue(activitySelect, 'word-wheel');
    const scheduleForm = document.querySelector('[data-together-time-scheduler] form');
    await act(async () => scheduleForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const scheduled = calls.pop();
    assert.equal(scheduled[0], 'propose');
    assert.equal(scheduled[1].activityType, 'game');
    assert.equal(scheduled[1].activityId, 'word-wheel');
    assert.equal(scheduled[1].activityName, 'Word Wheel');
    assert(new Date(scheduled[1].scheduledAt).getTime() > Date.now());
    assert.equal(scheduled[1].timezone, 'Africa/Lagos');
    const pickedWallClock = document.querySelector('input[type="datetime-local"]').value;
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(scheduled[1].scheduledAt)).map((part) => [part.type, part.value]));
    assert.equal(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`, pickedWallClock,
      'a datetime-local value is interpreted in the profile timezone saved with the reminder');
    assert(body().includes('turn on notifications on both phones'));
    assert(body().includes('This is a suggestion, not a fixed plan'));

    // A suggestion from Ana waits for my yes: I can lock it in, take it to the chat to
    // deliberate, or counter-suggest a time that works better — it is not scheduled yet.
    const partnerSuggestion = {
      ...session, id: 'session-proposal', status: 'proposed', created_by: 'partner',
      proposed_by: 'partner', agreed_by: null, agreed_at: null,
    };
    const mySuggestion = {
      ...session, id: 'session-mine', status: 'proposed', agreed_by: null, agreed_at: null,
    };
    await render({ togetherTimeSessions: [session, partnerSuggestion, mySuggestion] });
    const proposalCard = document.querySelector('[data-together-time-session="session-proposal"]');
    assert(proposalCard);
    assert.equal(proposalCard.getAttribute('data-together-time-status'), 'proposed');
    assert(proposalCard.textContent.includes('Ana suggested this'));
    assert(!proposalCard.querySelector('[data-open-scheduled-activity]'),
      'an un-agreed suggestion does not open the activity as if it were scheduled');
    await click(proposalCard.querySelector('[data-talk-about-together-time="session-proposal"]'));
    assert.deepEqual(calls.pop(), ['talk', 'session-proposal']);
    await click(proposalCard.querySelector('[data-agree-together-time="session-proposal"]'));
    assert.deepEqual(calls.pop(), ['agree', 'session-proposal']);
    await click(proposalCard.querySelector('[data-suggest-together-time="session-proposal"]'));
    const suggestForm = document.querySelector('[data-suggest-time-form="session-proposal"]');
    assert(suggestForm);
    await setValue(suggestForm.querySelector('input[type="datetime-local"]'), '2099-01-12T19:30');
    await act(async () => suggestForm.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
    const suggestion = calls.pop();
    assert.equal(suggestion[0], 'suggest');
    assert.equal(suggestion[1], 'session-proposal');
    assert(new Date(suggestion[2]).getTime() > Date.now());
    assert.equal(suggestion[3], 'Africa/Lagos');

    // My own suggestion only waits: there is no button to agree with myself.
    const myCard = document.querySelector('[data-together-time-session="session-mine"]');
    assert(myCard);
    assert(myCard.textContent.includes('Waiting for Ana to agree'));
    assert(!myCard.querySelector('[data-agree-together-time]'));
    assert(myCard.querySelector('[data-talk-about-together-time="session-mine"]'));

    // Every completed visit prompts for the user's contribution and shows the shared timeline lane.
    const memoriesSection = document.querySelector('[data-section="memories"]');
    assert(memoriesSection.querySelector('[data-visit-memory="v-old"]'));
    assert(memoriesSection.textContent.includes('Add one photo'));
    assert(memoriesSection.textContent.includes('Waiting for Ana'));

    // A cold push can open the precise activity once the shared schedule has loaded.
    calls.length = 0;
    await render({ initialSessionId: 'session-1' });
    assert.deepEqual(calls, [['openActivity', 'session-1'], ['clearDeepLink']]);

    // With no upcoming visit, choosing a date is the dominant empty-state action.
    await render({ visit: null, visitWishes: [], visitChecklist: [] });
    const emptyVisit = document.querySelector('[data-visit-card="empty"]');
    assert(emptyVisit);
    assert(emptyVisit.textContent.includes('Pick your next visit date'));
    await click(emptyVisit.querySelector('[data-action="plan-next-visit"]'));
    assert.deepEqual(calls.pop(), ['planVisit']);
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('chat tab: a shared highlight quotes the passage and jumps back into the book', async () => {
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
    const { ChatView } = await server.ssrLoadModule('/src/components/chat/ChatView.tsx');
    const opened = [];
    const base = {
      couple_id: 'c1',
      type: 'text',
      session_id: null,
      reply_to_id: null,
      created_at: new Date().toISOString(),
      read_at: null,
      edited_at: null,
      delivery: 'read',
    };
    const quote = 'In a hole in the ground there lived a hobbit.';
    const messages = [
      // With no comment the message content IS the quote: the card shows it once.
      { ...base, id: 'm1', sender_id: 'me', content: quote, highlight_id: 'h1' },
      // With a comment, the card quotes and the body carries the words.
      { ...base, id: 'm2', sender_id: 'you', content: 'This line!', highlight_id: 'h2' },
      // The book was deleted: the quote stays, the jump does not.
      { ...base, id: 'm3', sender_id: 'me', content: quote, highlight_id: 'h3' },
    ];
    const highlightById = {
      h1: { quote_text: quote, book_id: 'b1', book_title: 'The Hobbit' },
      h2: { quote_text: 'It is a dangerous business\u2026', book_id: 'b1', book_title: 'The Hobbit' },
      h3: { quote_text: quote, book_id: null, book_title: null },
    };

    await act(async () => root.render(React.createElement(ChatView, {
      messages,
      currentUserId: 'me',
      partnerName: 'Ana',
      partnerOnline: true,
      partnerLastSeenAt: null,
      partnerTyping: false,
      loading: false,
      error: null,
      onSend: async () => {},
      onTyping: () => {},
      onStopTyping: () => {},
      onRetry: () => {},
      onDismissError: () => {},
      highlightById,
      onOpenHighlight: (id) => opened.push(id),
    })));

    const live = document.querySelector('[data-highlight-link="h1"]');
    assert(live, 'the quote card is tappable while the book exists');
    assert(live.textContent.includes('from The Hobbit'));
    assert(live.textContent.includes(quote));
    await act(async () => live.click());
    assert.deepEqual(opened, ['h1'], 'tapping the quote opens the book at the passage');

    const commented = document.querySelector('[data-highlight-link="h2"]');
    assert(commented.textContent.includes('It is a dangerous business'));
    assert(document.body.textContent.includes('This line!'), 'the comment rides below the quote');

    const dead = document.querySelector('[data-highlight-link-dead="h3"]');
    assert(dead, 'a deleted book keeps the quote but loses the jump');
    assert.equal(document.querySelector('[data-highlight-link="h3"]'), null);
    assert(dead.textContent.includes('Book deleted'));
    assert(dead.textContent.includes(quote));
    // With no comment, the quote is not repeated as body text under the card.
    assert.equal(document.body.textContent.split(quote).length - 1, 2,
      'the quote appears once in each surviving card, never doubled in a body');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});