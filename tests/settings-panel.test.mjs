import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// Couple Settings is the one surface that keeps growing: sign-out, the 18+ gate, the
// notification card, the danger zone, and whatever comes next. It is a sheet pinned inside
// the phone frame, so the only thing that may get longer is the block between its header and
// its bottom edge. jsdom lays nothing out, so this guards the scaffolding the scrolling
// depends on: a capped column, a pinned header, and one scrollable body holding every
// section. Without the cap the panel simply grows past the frame and the bottom of the list
// — the breakup button, at the moment — becomes unreachable.

const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('couple settings: the sheet is capped by the frame and only its body scrolls', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://nooki.test/' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false }, define: {
    'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
    'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
  } });
  const root = createRoot(document.getElementById('root'));
  // The settings modal imports authService, which starts the Supabase auth client's own
  // refresh timer; it has to be disposed or the test process never exits.
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  let closed = 0;
  try {
    const { DangerSettingsModal } = await server.ssrLoadModule('/src/components/common/DangerSettingsModal.tsx');
    await act(async () => {
      root.render(React.createElement(DangerSettingsModal, {
        userId: 'user-a',
        couple: { id: 'couple-1', invite_code: 'ABC123', anniversary_date: '2020-01-01', created_at: '2020-01-01T00:00:00Z', breakup_requested_by: null, breakup_requested_at: null },
        profile: { id: 'user-a', couple_id: 'couple-1', name: 'Ana', timezone: 'Africa/Lagos', country_code: 'NG', country_name: 'Nigeria', state_code: 'RI', state_name: 'Rivers', city_name: 'Port Harcourt', city_key: 'ng/ri/port-harcourt', location_updated_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' },
        partner: { id: 'user-b', couple_id: 'couple-1', name: 'Ben', timezone: 'Europe/London', country_code: 'GB', country_name: 'United Kingdom', state_code: 'ENG', state_name: 'England', city_name: 'London', city_key: 'gb/eng/london', location_updated_at: '2026-01-01T00:00:00Z', last_seen_at: '2026-01-01T00:00:00Z', created_at: '2020-01-01T00:00:00Z' },
        onLocationSaved: () => {},
        adultQuestionsEnabled: false,
        partnerAdultQuestionsEnabled: false,
        adultQuestionsSaving: false,
        onToggleAdultQuestions: async () => {},
        pushNotifications: {
          support: 'ready',
          enabled: false,
          busy: false,
          error: null,
          configurationError: null,
          enable: async () => {},
          disable: async () => {},
          clearError: () => {},
        },
        onClose: () => { closed += 1; },
        onCoupleEnded: () => {},
        onSignOut: () => {},
      }));
    });

    // --- The overlay stays inside the phone frame and never scrolls itself ----------------
    const overlay = document.querySelector('[data-settings]');
    assert(overlay, 'the settings overlay renders');
    assert.equal(overlay.getAttribute('role'), 'dialog', 'it is announced as a dialog');
    assert.equal(overlay.style.overflow, 'hidden', 'the backdrop clips: the app behind it is never dragged or scrolled');
    assert.equal(overlay.style.padding, '16px', 'and the padding it centres the sheet with is what caps the sheet');

    // --- The sheet is a column that cannot grow past the frame ---------------------------
    const sheet = document.querySelector('[data-settings-sheet]');
    assert(sheet, 'the sheet renders');
    assert.equal(sheet.style.maxHeight, '100%', 'the sheet is capped by the height it is placed in, not by a pixel guess');
    assert.equal(sheet.style.overflow, 'hidden', 'and it clips, so only its body can scroll');
    assert.equal(sheet.style.display, 'flex');
    assert.equal(sheet.style.flexDirection, 'column', 'header and body are stacked, not flowed');
    assert.equal(sheet.style.padding, '', 'the sheet itself no longer carries the content padding — the scrolling body does');

    // --- The header is pinned: the close button is always reachable ----------------------
    const header = document.querySelector('[data-settings-header]');
    const scroll = document.querySelector('[data-settings-scroll]');
    assert(header, 'the header renders');
    assert(scroll, 'the scrolling body renders');
    assert.equal(header.style.flexShrink, '0', 'the header never shrinks, so the title and the X stay on screen');
    assert.match(header.textContent, /Couple Settings/);
    const closeButton = header.querySelector('[aria-label="Close settings"]');
    assert(closeButton, 'the close button lives in the pinned header');
    assert(!scroll.contains(closeButton), 'and not in the scrolling body, which would let it be scrolled away');

    // --- One scrollable body holds every section ----------------------------------------
    assert.equal(scroll.style.overflowY, 'auto', 'the body is the scroll container');
    assert.equal(scroll.style.flexGrow, '1', 'and it takes the height the header leaves');
    assert.equal(scroll.style.minHeight, '0px', 'with the min-height that actually lets a flex child shrink and scroll');
    assert.equal(scroll.classList.contains('nooki-settings-scroll'), true, 'it carries the class the scroll details live in');
    assert.equal(scroll.style.gap, '16px', 'sections keep their spacing once stacked in here');

    const sectionSelectors = [
      '[data-location-card]',
      '[data-adult-settings]',
      '[data-push-card]',
      '[data-adult-status]',
    ];
    for (const selector of sectionSelectors) {
      const section = document.querySelector(selector);
      assert(section, `${selector} is rendered`);
      assert(scroll.contains(section), `${selector} is inside the scrolling body, not beside it`);
    }
    const sections = [...scroll.children].filter((child) => child.tagName === 'DIV');
    assert(sections.length >= 5, 'all five sections (sign out, location, 18+, notifications, danger zone) are in the one scrolling body');
    // The location card is the newest section and the reason this test exists: the panel
    // only ever gets longer, so what keeps the breakup button reachable is the cap.
    assert.match(scroll.textContent, /Where you both are/);
    assert.match(scroll.textContent, /Port Harcourt, Rivers, Nigeria/);
    assert.match(scroll.textContent, /Danger Zone: End Couple/, 'including the section that used to fall off the bottom');

    // --- Closing still works from the pinned header --------------------------------------
    await act(async () => {
      closeButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
    assert.equal(closed, 1, 'the X closes the sheet through the same callback as before');
  } finally {
    await act(() => root.unmount());
    await supabase.auth.dispose();
    await server.close();
    dom.window.close();
  }
});

test('couple settings: the scrolling body keeps its drag inside the sheet', () => {
  const css = readSource('../src/index.css');
  const rule = css.match(/\.nooki-settings-scroll\s*\{([^}]*)\}/);
  assert(rule, '.nooki-settings-scroll is defined in the app stylesheet');

  // Reaching the end of the settings list must not hand the drag to the tab behind the
  // modal (or to the browser's pull-to-refresh on a phone).
  assert.match(rule[1], /overscroll-behavior:\s*contain/, 'the sheet contains its own overscroll');
  assert.match(rule[1], /-webkit-overflow-scrolling:\s*touch/, 'and scrolls with the momentum a phone expects');
  assert.match(rule[1], /scrollbar-width:\s*thin/, 'the bar is a hint, not a stripe down the panel');
  assert.match(css, /\.nooki-settings-scroll::-webkit-scrollbar\s*\{/, 'the WebKit scrollbar is styled too');
  assert.match(css, /\.nooki-settings-scroll::-webkit-scrollbar-thumb\s*\{[^}]*background-color:/, 'including its thumb');
});
