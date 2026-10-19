import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Together's next-visit countdown, Together-time scheduler and private/matched ideas
// are exercised through the real component.
test('Together tab: the countdown leads, ideas match quietly, and sessions open from one tap', async () => {
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
    const idea = (id, text, overrides = {}) => ({
      id, couple_id: 'c1', text, details: null, sort_order: 0, visibility: 'open',
      visit_date: null, visit_id: null, wanters: [], completed: false, completed_at: null,
      created_by: 'me', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    });
    const sharedMatch = idea('idea-match', 'Try the night market', { wanters: ['me', 'partner'] });
    const privateIdea = idea('idea-private', 'A surprise for later', { visibility: 'private', wanters: ['me'] });
    const session = {
      id: 'session-1', couple_id: 'c1', created_by: 'me', activity_type: 'game',
      activity_id: 'word-wheel', activity_name: 'Word Wheel', scheduled_at: '2099-01-10T18:00:00.000Z',
      timezone: 'Africa/Lagos', status: 'scheduled', proposed_by: 'me', agreed_by: 'partner',
      agreed_at: '2026-01-01T00:00:00Z', reminder_sent_at: null, created_at: '', updated_at: '',
    };
    const onOpenActivity = (value) => calls.push(['openActivity', value.id]);
    const defaults = {
      userId: 'me', partnerName: 'Ana', timezone: 'Africa/Lagos',
      visit,
      somedayItems: [sharedMatch, privateIdea],
      togetherTimeSessions: [session],
      remindersEnabled: false,
      onPlanVisit: () => calls.push(['planVisit']),
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

    // The countdown sits first. The retired sections — visit wishes, the day-by-day
    // plan, the shared checklist and memories — are gone from the tab.
    await render();
    assert(document.querySelector('[data-visit-card="upcoming"]'));
    assert(!document.querySelector('[data-visit-wishes]'));
    assert(!document.querySelector('[data-visit-itinerary]'));
    assert(!document.querySelector('[data-visit-checklist]'));
    assert(!document.querySelector('[data-section="memories"]'));
    assert(!body().includes('One thing I want from this visit'));
    assert(!body().includes('Plan by day'));
    assert(!body().includes('Shared checklist'));

    // A matched idea is explicit; single-vote ideas do not announce the other person's yes.
    assert.equal(document.querySelectorAll('[data-someday-match]').length, 1);
    assert(document.querySelector('[data-someday-item="idea-private"]'));
    assert.equal(document.querySelector('[data-someday-item="idea-private"]').getAttribute('data-someday-visibility'), 'private');
    await click(document.querySelector('[data-someday-want="idea-match"]'));
    assert.deepEqual(calls.pop(), ['want', 'idea-match']);

    // Read together is gone. Together time only schedules a game.
    const togetherTime = document.querySelector('[data-section="together-time"]');
    assert(togetherTime);
    assert.equal(togetherTime.querySelector('[data-card="read-together"]'), null);
    assert.equal(togetherTime.querySelector('[data-upload-book]'), null);
    assert(!togetherTime.textContent.includes('Read together'));
    assert(!togetherTime.textContent.includes('Read a book'));

    // A locked-in session says both partners agreed, and one tap opens that activity.
    assert(document.querySelector('[data-together-time-locked="session-1"]'));
    assert(body().includes('Locked in'));
    await click(document.querySelector('[data-open-scheduled-activity="session-1"]'));
    assert.deepEqual(calls.pop(), ['openActivity', 'session-1']);
    assert.equal(document.querySelector('[aria-label="Together time activity type"]'), null);
    const activitySelect = document.querySelector('[aria-label="Choose a game"]');
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

    // A cold push can open the precise activity once the shared schedule has loaded.
    calls.length = 0;
    await render({ initialSessionId: 'session-1' });
    assert.deepEqual(calls, [['openActivity', 'session-1'], ['clearDeepLink']]);

    // With no upcoming visit, choosing a date is the dominant empty-state action.
    await render({ visit: null });
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
