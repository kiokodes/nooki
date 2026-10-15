import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// Dates are compared on the reader's own calendar day, so pin the process timezone.
process.env.TZ = 'UTC';

/** A UserEvent-free touch event: React only reads changedTouches from it. */
function touchEvent(window, type, x, y) {
  const event = new window.Event(type, { bubbles: true, cancelable: true });
  const touch = { clientX: x, clientY: y };
  Object.defineProperty(event, 'changedTouches', { value: [touch] });
  Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [touch] });
  return event;
}

test('calendar helpers: month grid, recurrence rules and upcoming windows', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const cal = await server.ssrLoadModule('/src/lib/calendar.ts');
    const event = (id, title, event_date, repeats_yearly = false) => ({
      id, title, event_date, repeats_yearly, couple_id: 'c1', created_by: null, created_at: '', updated_at: '',
    });

    // --- Month grid: Monday first, padded to whole weeks ---------------------------------
    const feb2024 = cal.getMonthGrid(2024, 2);
    assert.equal(feb2024.every((week) => week.length === 7), true, 'every week has 7 days');
    assert.equal(feb2024[0][0], '2024-01-29', '1 Feb 2024 is a Thursday, so the grid starts on Monday 29 Jan');
    assert.equal(feb2024.flat().includes('2024-02-29'), true, 'leap day is present');
    assert.equal(feb2024.flat().includes('2024-03-05'), false, 'the grid stops at the end of its last week');
    const jan2026 = cal.getMonthGrid(2026, 1);
    assert.equal(jan2026[0][0], '2025-12-29', 'the grid reaches back into the previous month');
    assert.deepEqual(cal.shiftMonth(2026, 1, -1), { year: 2025, month: 12 }, 'January steps back to December');
    assert.deepEqual(cal.shiftMonth(2026, 12, 1), { year: 2027, month: 1 }, 'December steps on to January');
    assert.equal(cal.formatMonthLabel(2026, 10), 'October 2026');
    assert.equal(cal.formatLongDate('2026-10-15'), 'Thursday, 15 October');
    assert.equal(cal.formatShortDate('2026-10-05'), '5 Oct');
    assert.equal(cal.toDateKey(new Date(2026, 9, 5)), '2026-10-05');
    assert.equal(cal.addDaysToKey('2026-10-31', 1), '2026-11-01', 'day arithmetic rolls the month over');
    assert.equal(cal.addDaysToKey('2026-12-31', 1), '2027-01-01', 'and the year');

    // --- Anniversary and monthsaries ---------------------------------------------------
    const anniversary = '2020-02-14';
    const anniversaryDay = cal.getItemsForDate('2026-02-14', [], anniversary);
    assert.equal(anniversaryDay.length, 1);
    assert.equal(anniversaryDay[0].kind, 'anniversary');
    assert.equal(anniversaryDay[0].detail, '6 years together');

    const start = cal.getItemsForDate('2020-02-14', [], anniversary);
    assert.equal(start[0].kind, 'anniversary', 'the very first day is marked');
    assert.equal(start[0].detail, 'the day it all started');

    const monthsary = cal.getItemsForDate('2026-03-14', [], anniversary);
    assert.equal(monthsary.length, 1);
    assert.equal(monthsary[0].kind, 'monthsary');
    assert.equal(monthsary[0].detail, '73 months together');

    assert.deepEqual(cal.getItemsForDate('2026-03-15', [], anniversary), [], 'other days stay clear');
    assert.deepEqual(cal.getItemsForDate('2019-02-14', [], anniversary), [], 'nothing before the anniversary');
    assert.deepEqual(cal.getItemsForDate('2026-02-14', [], null), [], 'an unset anniversary adds nothing');

    // A 31st anniversary borrows the last day of shorter months instead of overflowing.
    const clamped = '2020-01-31';
    assert.equal(cal.getItemsForDate('2020-02-29', [], clamped)[0]?.kind, 'monthsary', '29 Feb is the February monthsary');
    assert.equal(cal.getItemsForDate('2021-02-28', [], clamped)[0]?.detail, '13 months together');
    assert.equal(cal.getItemsForDate('2021-01-31', [], clamped)[0]?.kind, 'anniversary', 'the January anniversary stays on the 31st');
    assert.equal(cal.getItemsForDate('2021-04-30', [], clamped)[0]?.kind, 'monthsary', 'April borrows the 30th');

    // --- Events, including yearly repeats ----------------------------------------------
    const events = [
      event('e1', 'Visit', '2026-12-25'),
      event('e2', 'Birthday', '2026-12-25', true),
      event('e3', 'Leap party', '2024-02-29', true),
    ];
    const both = cal.getItemsForDate('2026-12-25', events, null);
    assert.equal(both.length, 2, 'a one-off and a yearly event can land on the same day');
    assert.equal(both[0].title, 'Visit');
    assert.equal(both[1].detail, 'every year');
    assert.deepEqual(cal.getItemsForDate('2027-12-25', events, null).map((i) => i.title), ['Birthday'],
      'the yearly repeat comes back the next year, the one-off does not');
    assert.deepEqual(cal.getItemsForDate('2025-12-25', events, null), [],
      'a yearly repeat never appears before the date it was set for');
    const leap = cal.getItemsForDate('2025-02-28', events, null);
    assert.equal(leap.length, 1, 'a 29 Feb yearly event borrows 28 Feb in a normal year');
    assert.equal(cal.getItemsForDate('2028-02-29', events, null).length, 1, 'and lands back on 29 Feb in a leap year');

    // Automatic dates and events can share a day.
    const shared = cal.getItemsForDate('2026-02-14', [event('e4', 'Dinner', '2026-02-14', false)], anniversary);
    assert.deepEqual(shared.map((i) => i.kind), ['anniversary', 'event']);

    // --- Month markers, upcoming window and swipe --------------------------------------
    const monthItems = cal.getMonthItems(2026, 12, events, anniversary);
    assert.equal(monthItems.has('2026-12-25'), true, 'the month view knows which days have something on');
    assert.equal(monthItems.get('2026-12-25').length, 2, 'both of that day\'s events are counted');
    assert.equal(monthItems.has('2026-12-14'), true, 'the monthsary is marked too');
    assert.equal(monthItems.size, 2, 'December has the monthsary and the 25th');

    const today = new Date(2026, 9, 15);
    const upcomingEvents = [event('u1', 'Tomorrow thing', '2026-10-16'), event('u2', 'Next week thing', '2026-10-22')];
    const upcoming = cal.getUpcomingGroups(today, 1, upcomingEvents, null);
    assert.equal(upcoming.length, 1, 'only the next day is inside the window');
    assert.equal(upcoming[0].date, '2026-10-16');
    assert.equal(upcoming[0].daysAway, 1);
    assert.deepEqual(cal.getUpcomingGroups(today, 7, upcomingEvents, null).map((g) => g.daysAway), [1, 7]);
    assert.deepEqual(cal.getUpcomingGroups(today, 1, [event('u3', 'Today only', '2026-10-15')], null), [],
      'today itself is not "upcoming"');

    assert.equal(cal.getSwipeDirection(-80, 4), 1, 'swiping left moves forward');
    assert.equal(cal.getSwipeDirection(80, 4), -1, 'swiping right moves back');
    assert.equal(cal.getSwipeDirection(-20, 2), 0, 'a small drag is not a swipe');
    assert.equal(cal.getSwipeDirection(-70, 90), 0, 'a mostly vertical drag is not a month swipe');
  } finally {
    await server.close();
  }
});

test('couple_events: CRUD, RLS isolation, cascade and safe re-migration', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
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

    // Two couples, plus an unpaired account in between.
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, 'Alice', 'Africa/Lagos');
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, 'Bob', 'Europe/London');
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    // Alice adds events; both partners see them, ordered by date.
    await auth.createCoupleEvent(couple.id, alice.id, { title: '  Movie night  ', date: '2026-12-24', repeatsYearly: false });
    const birthday = await auth.createCoupleEvent(couple.id, alice.id, { title: 'Sam’s birthday', date: '2026-03-02', repeatsYearly: true });
    assert.equal(birthday.title, 'Sam’s birthday');
    assert.equal(birthday.repeats_yearly, true);
    assert.equal(birthday.created_by, alice.id, 'the row records who added it');

    const aliceView = await auth.fetchCoupleEvents(couple.id);
    assert.deepEqual(aliceView.map((event) => event.event_date), ['2026-03-02', '2026-12-24'], 'sorted by date');
    assert.equal(aliceView[0].title, 'Sam’s birthday');
    assert.equal(aliceView[1].title, 'Movie night', 'the title was trimmed');
    await auth.signInWithEmail('bob@example.com', 'password');
    const bobView = await auth.fetchCoupleEvents(couple.id);
    assert.equal(bobView.length, 2, 'the other partner sees the same calendar');

    // Editing is shared, and the trigger moves updated_at.
    await auth.updateCoupleEvent(birthday.id, { title: 'Ana’s birthday', date: '2026-03-02', repeatsYearly: true });
    assert.equal((await auth.fetchCoupleEvents(couple.id))[0].title, 'Ana’s birthday');

    // Validation happens before anything is sent.
    await assert.rejects(auth.createCoupleEvent(couple.id, bob.id, { title: '   ', date: '2026-01-01', repeatsYearly: false }), /give this event a name/);
    await assert.rejects(auth.createCoupleEvent(couple.id, bob.id, { title: 'x'.repeat(121), date: '2026-01-01', repeatsYearly: false }), /120 characters/);
    await assert.rejects(auth.createCoupleEvent(couple.id, bob.id, { title: 'Party', date: '2026-02-30', repeatsYearly: false }), /valid date/);

    // A live project that has not run the calendar migration gets an owner-facing message,
    // not a raw Postgres error.
    const originalFrom = supabase.from;
    supabase.from = () => ({
      select: () => ({ eq: () => ({ order: async () => ({ data: null, error: { code: '42P01', message: 'relation "public.couple_events" does not exist' } }) }) }),
    });
    await assert.rejects(auth.fetchCoupleEvents(couple.id), /apply the Supabase migrations/);
    supabase.from = originalFrom;

    // A third account that is not in this couple can neither read nor change anything.
    await auth.signInWithEmail('alice@example.com', 'password');
    const intruder = (await auth.signUpWithEmail('third@example.com', 'password')).user;
    await auth.saveOnboardingProfile(intruder.id, 'Third', 'UTC');
    assert.deepEqual(await auth.fetchCoupleEvents(couple.id), [], 'an unpaired account sees no events');
    await assert.rejects(auth.createCoupleEvent(couple.id, intruder.id, { title: 'Sneaky', date: '2026-01-01', repeatsYearly: false }),
      /row-level security|violates/i);
    // RLS makes the update match nothing, so the row is untouched and the client reports a failure.
    await assert.rejects(auth.updateCoupleEvent(birthday.id, { title: 'Hijacked', date: '2026-03-02', repeatsYearly: true }),
      /could not be updated|row-level security|violates|no rows/i);
    await auth.deleteCoupleEvent(birthday.id);
    // Checked from inside the couple: the outside delete changed nothing.
    await auth.signInWithEmail('alice@example.com', 'password');
    assert.equal((await auth.fetchCoupleEvents(couple.id)).length, 2,
      'a delete outside the couple changes nothing');

    // Deleting an event the couple owns works for either partner.
    const [first] = await auth.fetchCoupleEvents(couple.id);
    await auth.deleteCoupleEvent(first.id);
    assert.equal((await auth.fetchCoupleEvents(couple.id)).length, 1);

    // The calendar migration is safe to rerun on a populated project.
    const dbModule = await import('node:fs/promises');
    const migration = await dbModule.readFile(new URL('../supabase/migrations/202610150002_couple_events.sql', import.meta.url), 'utf8');
    const before = (await auth.fetchCoupleEvents(couple.id)).length;
    await backend.exec(migration);
    await backend.exec(migration);
    await auth.signInWithEmail('alice@example.com', 'password');
    assert.equal((await auth.fetchCoupleEvents(couple.id)).length, before, 'rerunning the migration keeps the events');

    // Ending the couple takes its calendar with it.
    await auth.requestOrConfirmBreakup();
    await auth.signInWithEmail('bob@example.com', 'password');
    const ending = await auth.requestOrConfirmBreakup();
    assert.equal(ending.status, 'ended');
    assert.deepEqual(await auth.fetchCoupleEvents(couple.id), [], 'events cascade away with the couple');
  } finally {
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});

test('verify.sql spots a live project that is missing the calendar migration', async () => {
  // Two projects, identical except for the migration, so the preflight check has to be
  // the thing that tells them apart.
  const authRoles = `
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE anon NOLOGIN;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
    $$;
    CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT current_user::TEXT; $$;
  `;
  const grants = `
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.couples TO authenticated;
  `;
  const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  const pairingMigration = await readFile(new URL('../supabase/migrations/202610150001_pairing_flow.sql', import.meta.url), 'utf8');
  const calendarMigration = await readFile(new URL('../supabase/migrations/202610150002_couple_events.sql', import.meta.url), 'utf8');
  const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');

  const db = new PGlite();
  try {
    await db.exec(authRoles);
    // A project that predates the calendar feature: schema without the couple_events section.
    await db.exec(schema.split('-- 11. Couple events')[0]);
    await db.exec(pairingMigration);
    await db.exec(grants);

    await assert.rejects(db.exec(verification), /couple_events/,
      'the preflight must send the owner to the calendar migration');

    try { await db.exec('ROLLBACK'); } catch { /* the failed script already rolled back */ }
    await db.exec(calendarMigration);
    const results = await db.exec(verification);
    assert(JSON.stringify(results).includes('PASS'), 'verify.sql passes once the migration is applied');
  } finally {
    await db.close();
  }
});

test('today card and calendar modal: browse, add, edit, delete without leaving Home', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
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
    supabase.channel = () => ({ on() { return this; }, subscribe() { return this; }, async track() { return 'ok'; }, presenceState: () => ({}) });
    supabase.removeChannel = async () => 'ok';
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const cal = await server.ssrLoadModule('/src/lib/calendar.ts');

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, 'Alice', 'Africa/Lagos');
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, 'Bob', 'Europe/London');
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    // Two dates: something today, and something a week out (outside the card's window).
    const todayKey = cal.toDateKey(new Date());
    const inAWeek = cal.addDaysToKey(todayKey, 7);
    await auth.createCoupleEvent(couple.id, alice.id, { title: 'Call Bob tonight', date: todayKey, repeatsYearly: false });
    await auth.createCoupleEvent(couple.id, alice.id, { title: 'Trip together', date: inAWeek, repeatsYearly: false });
    await auth.signInWithEmail('alice@example.com', 'password');

    const body = () => document.body.textContent.replace(/\u2019/g, "'");
    const waitFor = async (predicate, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      assert.fail(message);
    };
    const click = async (target) => act(async () => { target.click(); });
    const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    const fill = async (input, value) => act(() => {
      setValue.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const byLabel = (label) => document.querySelector(`[aria-label="${label}"]`);
    const modal = () => document.querySelector('[data-modal="calendar"]');

    const { default: App } = await server.ssrLoadModule('/src/App.tsx');
    await act(async () => { root.render(React.createElement(App)); });
    await waitFor(() => document.querySelector('[data-card="today"]'), 'the Today card should render');

    // --- Today card -------------------------------------------------------------------
    const card = () => document.querySelector('[data-card="today"]');
    assert(card().textContent.includes(cal.formatLongDate(todayKey)), "today's date is on the card");
    const todayItems = document.querySelector('[data-today-items]');
    assert(todayItems && todayItems.textContent.includes('Call Bob tonight'), "today's event is listed");
    assert.equal(card().textContent.includes('Trip together'), false, 'events beyond the window stay off the card');
    if (document.querySelector('[data-upcoming]')) {
      assert.equal(document.querySelector('[data-upcoming]').textContent.includes('Trip together'), false,
        'the upcoming block only covers its window');
    }

    // --- Opening the modal ------------------------------------------------------------
    await click(byLabel('View calendar'));
    assert(modal(), 'the calendar opens as a modal');
    assert(document.querySelector('[data-screen="home"]'), 'the Home tab stays mounted behind the modal');
    assert(modal().textContent.includes(cal.formatMonthLabel(new Date().getFullYear(), new Date().getMonth() + 1)),
      'the modal opens on the current month');
    // The anniversary recurs on its own day-of-month, so the 14th of every month is marked
    // automatically — no user event involved.
    const thisMonth14 = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-14`;
    assert(document.querySelector(`[data-day="${thisMonth14}"] [data-dot]`), 'an automatic date is marked in the grid');
    await click(document.querySelector(`[data-day="${thisMonth14}"]`));
    assert(/Monthsary|Anniversary/.test(modal().textContent), 'the automatic date is listed for that day');
    assert(document.querySelector('[data-selected-label]').textContent.includes('14'), 'the selected day follows the click');
    await click(document.querySelector(`[data-day="${todayKey}"]`));
    assert(document.querySelector(`[data-day="${todayKey}"]`).textContent === String(new Date().getDate()),
      "today's cell is in the grid");
    assert(document.querySelector(`[data-dot="${todayKey}"]`), 'days with something on show a marker');
    assert(modal().textContent.includes('Call Bob tonight'), 'the selected day lists its events');

    // --- Month navigation --------------------------------------------------------------
    const now = new Date();
    const nextMonth = cal.shiftMonth(now.getFullYear(), now.getMonth() + 1, 1);
    await click(byLabel('Next month'));
    assert(modal().textContent.includes(cal.formatMonthLabel(nextMonth.year, nextMonth.month)), 'next month works');
    await click(byLabel('Previous month'));
    await click(byLabel('Previous month'));
    const previousMonth = cal.shiftMonth(now.getFullYear(), now.getMonth() + 1, -1);
    assert(modal().textContent.includes(cal.formatMonthLabel(previousMonth.year, previousMonth.month)), 'previous month works');

    // The month/year picker jumps straight to a month a year back.
    await click(byLabel('Choose month and year'));
    assert(document.querySelector('[data-modal-picker]'), 'the picker opens');
    await click(byLabel('Previous year'));
    const pickMonth = previousMonth.month;
    const pickYear = previousMonth.year - 1;
    const monthButton = [...document.querySelectorAll('[data-modal-picker] button')]
      .find((button) => button.textContent === cal.formatMonthShort(pickMonth));
    await click(monthButton);
    assert(modal().textContent.includes(cal.formatMonthLabel(pickYear, pickMonth)), 'picking a month jumps there');
    assert.equal(document.querySelector('[data-modal-picker]'), null, 'the picker closes after choosing');
    await click([...document.querySelectorAll('button')].find((button) => button.textContent.includes('Back to today')));

    // --- Swipe between months ----------------------------------------------------------
    const grid = document.querySelector('[data-modal-grid]');
    const swipe = async (fromX, toX) => act(async () => {
      grid.dispatchEvent(touchEvent(dom.window, 'touchstart', fromX, 300));
      grid.dispatchEvent(touchEvent(dom.window, 'touchend', toX, 302));
    });
    const labelNow = () => modal().textContent.includes(cal.formatMonthLabel(now.getFullYear(), now.getMonth() + 1));
    await swipe(300, 120);
    assert(modal().textContent.includes(cal.formatMonthLabel(nextMonth.year, nextMonth.month)), 'swiping left goes forward a month');
    await swipe(120, 300);
    assert(labelNow(), 'swiping right comes back');
    await swipe(120, 300);
    assert(modal().textContent.includes(cal.formatMonthLabel(previousMonth.year, previousMonth.month)), 'and back again');
    await swipe(120, 300);
    await swipe(300, 120);

    // --- Adding an event ---------------------------------------------------------------
    assert.equal(document.querySelector('[data-event-form]'), null, 'the form is closed until asked for');
    await click([...document.querySelectorAll('button')].find((button) => button.textContent.includes('Back to today')));
    assert(modal().textContent.includes(cal.formatMonthLabel(now.getFullYear(), now.getMonth() + 1)),
      '"Back to today" returns to the current month');
    await click([...document.querySelectorAll('button')].find((button) => button.textContent.includes('Add event')));
    const form = document.querySelector('[data-event-form]');
    assert(form, 'the add form opens');
    assert.equal(document.querySelector('input[aria-label="Event date"]').value, todayKey, 'the form opens on the selected day');
    await fill(document.querySelector('input[aria-label="Event name"]'), 'Anniversary dinner');
    await act(async () => { document.querySelector('input[type="checkbox"]').click(); });
    await act(async () => {
      form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => modal().textContent.includes('Anniversary dinner'), 'the new event shows in the modal');
    await waitFor(() => !document.querySelector('[data-event-form]'), 'the form closes after saving');
    assert(document.querySelector(`[data-day="${todayKey}"] [data-dot]`), 'the day is marked in the grid');
    const saved = (await auth.fetchCoupleEvents(couple.id)).find((event) => event.title === 'Anniversary dinner');
    assert(saved, 'the event reached the database');
    assert.equal(saved.repeats_yearly, true, 'the yearly switch was saved');
    assert.equal(saved.event_date, todayKey);

    // --- Editing it --------------------------------------------------------------------
    await click(byLabel('Edit Anniversary dinner'));
    await waitFor(() => document.querySelector('[data-event-form]'), 'the edit form opens');
    assert.equal(document.querySelector('input[aria-label="Event name"]').value, 'Anniversary dinner', 'the form is prefilled');
    await fill(document.querySelector('input[aria-label="Event name"]'), 'Dinner + call');
    await act(async () => {
      document.querySelector('[data-event-form]').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    });
    await waitFor(() => modal().textContent.includes('Dinner + call'), 'the edit shows up');
    assert(!modal().textContent.includes('Anniversary dinner'), 'the old title is gone');
    assert((await auth.fetchCoupleEvents(couple.id)).some((event) => event.title === 'Dinner + call'), 'the edit persisted');

    // --- Deleting it, with the confirm guard ---------------------------------------------
    dom.window.confirm = () => false;
    await click(byLabel('Delete Dinner + call'));
    assert(modal().textContent.includes('Dinner + call'), 'declining the confirm keeps the event');
    dom.window.confirm = () => true;
    await click(byLabel('Delete Dinner + call'));
    await waitFor(() => !modal().textContent.includes('Dinner + call'), 'confirming removes the event');
    assert(!(await auth.fetchCoupleEvents(couple.id)).some((event) => event.title === 'Dinner + call'), 'the delete persisted');

    // --- Closing the modal returns to Home -----------------------------------------------
    await click(byLabel('Close calendar'));
    assert.equal(modal(), null, 'the modal closes');
    assert(document.querySelector('[data-card="today"]'), 'the Today card is still there');
    assert(body().includes('Call Bob tonight'), "the card still shows today's event");

    // Escape also closes it.
    await click(byLabel('View calendar'));
    assert(modal(), 'the modal reopens');
    await act(async () => {
      document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.equal(modal(), null, 'Escape closes the modal');
  } finally {
    await act(() => root.unmount());
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
    dom.window.close();
  }
});
