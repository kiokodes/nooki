import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The Together tab's someday list as the couple uses it: the stored order, the detail
// sheet with room for context, deleting, and the bridge into the next visit. The
// database rules behind these actions are covered in someday-database.test.mjs.
test('together tab: reorder the someday list, add context, delete, and move ideas into a visit', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'SVGElement']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    const { TogetherView } = await server.ssrLoadModule('/src/components/together/TogetherView.tsx');

    const visit = {
      id: 'v1',
      couple_id: 'c1',
      start_date: '2099-01-10',
      end_date: null,
      location: 'Lagos',
      timezone: 'Africa/Lagos',
      is_tentative: false,
      created_by: 'me',
      created_at: '',
      updated_at: '',
    };
    const item = (id, text, sort_order, overrides = {}) => ({
      id,
      couple_id: 'c1',
      text,
      details: null,
      sort_order,
      visit_id: null,
      completed: false,
      completed_at: null,
      created_by: 'me',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ...overrides,
    });

    const items = [
      item('a', 'Try that restaurant', 0, { details: 'Ask about the window table.' }),
      item('b', 'Sunset at the beach', 1, { visit_id: 'v1' }),
      item('c', 'Walk the Sunday market', 2, { visit_id: 'past-visit' }),
    ];

    const state = {
      books: [],
      progress: [],
      highlights: [],
      loading: false,
      busy: false,
      error: null,
      upload: async () => null,
      continueReading: async () => {},
      leave: async () => {},
      finish: async () => {},
      remove: async () => {},
      addHighlight: async () => { throw new Error('unused'); },
      saveProgress: async () => { throw new Error('unused'); },
      clearError: () => {},
    };

    const calls = [];
    const handlers = {
      onAddSomedayItem: async (text, details) => { calls.push(['add', text, details]); },
      onUpdateSomedayItem: async (target, text, details) => { calls.push(['update', target.id, text, details]); },
      onToggleSomedayItem: async (target) => { calls.push(['toggle', target.id]); },
      onDeleteSomedayItem: async (target) => { calls.push(['delete', target.id]); },
      onReorderSomedayItems: async (ids) => { calls.push(['reorder', ids]); },
      onAddSomedayItemToVisit: async (target) => { calls.push(['addToVisit', target.id]); },
      onRemoveSomedayItemFromVisit: async (target) => { calls.push(['removeFromVisit', target.id]); },
      onPlanSomedayItemVisit: (target) => { calls.push(['planForItem', target.id]); },
    };

    const render = (overrides = {}) => act(async () => root.render(React.createElement(TogetherView, {
      state,
      userId: 'me',
      userName: 'Alice',
      partnerName: 'Ana',
      onOpenReader: () => {},
      visit,
      onPlanVisit: () => { calls.push(['planVisit']); },
      onViewVisitPlans: () => {},
      somedayItems: items,
      ...handlers,
      ...overrides,
    })));

    const section = () => document.querySelector('[data-section="someday-list"]');
    const rows = () => [...section().querySelectorAll('[data-someday-item]')].map((row) => row.getAttribute('data-someday-item'));
    const button = (text) => [...document.querySelectorAll('button')].find((entry) => entry.textContent.includes(text));
    const click = async (element) => { await act(async () => element.click()); };
    const setTextarea = async (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
      await act(async () => {
        setter.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    const setInput = async (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      await act(async () => {
        setter.call(element, value);
        element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    const closeSheet = async () => {
      const close = document.querySelector('[data-someday-sheet] button[aria-label="Close"]');
      if (close) await click(close);
    };

    // --- The saved order is painted as stored, with notes and the visit marker ------
    await render();
    assert.deepEqual(rows(), ['a', 'b', 'c']);
    assert(section().textContent.includes('3 to do'));
    assert(section().textContent.includes('Ask about the window table.'), 'a note preview shows on the row');
    assert(section().textContent.includes('Drag the dots'), 'the reorder hint is visible');

    // The same idea appears on the next visit's card.
    const visitCard = document.querySelector('[data-visit-card="upcoming"]');
    assert(visitCard, 'the upcoming visit card renders');
    assert(visitCard.textContent.includes("What we'll do"));
    assert.ok(visitCard.querySelector('[data-visit-idea="b"]'), 'the pinned idea is on the visit card');
    assert.ok(section().querySelector('[data-someday-item="b"] [data-someday-pinned]'), 'the row is marked Next visit');

    // --- Keyboard reordering saves the whole new order -----------------------------
    const gripFor = (id) => section().querySelector(`[data-someday-item="${id}"] [data-someday-grip]`);
    await act(async () => {
      gripFor('a').dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.deepEqual(calls.pop(), ['reorder', ['b', 'a', 'c']], 'ArrowDown moves the idea one slot');
    assert.match(document.querySelector('[role="status"]').textContent, /position 2 of 3/);

    // --- The truth of the list still comes from the stored items -------------------
    assert.deepEqual(rows(), ['a', 'b', 'c'], 'the component never invents an order the database has not saved');

    // --- Opening an idea: context up to 1,000 characters, save, delete -------------
    await click(section().querySelector('[data-someday-open="a"]'));
    const sheet = document.querySelector('[data-someday-sheet="a"]');
    assert(sheet, 'the detail sheet opens');
    assert(sheet.textContent.includes('A someday thing'));
    assert.equal(sheet.querySelector('#someday-text').value, 'Try that restaurant');
    assert.equal(sheet.querySelector('#someday-text').maxLength, 500);
    const details = sheet.querySelector('#someday-details');
    assert.equal(details.maxLength, 1000, 'the notes tab holds at least 500 characters');
    assert(sheet.textContent.includes('/1000'));

    const longNote = 'x'.repeat(500);
    await setTextarea(details, longNote);
    assert(sheet.querySelector('[data-someday-details-count]').textContent.includes('500/1000'));
    await click(sheet.querySelector('[data-someday-save]'));
    const saved = calls.pop();
    assert.deepEqual(saved, ['update', 'a', 'Try that restaurant', longNote]);
    assert.equal(document.querySelector('[data-someday-sheet="a"]'), null, 'saving closes the sheet');

    // Adding to the next visit goes through the app so it can refresh the visit card.
    await click(section().querySelector('[data-someday-open="a"]'));
    await click(document.querySelector('[data-someday-sheet="a"] [data-someday-add-to-visit]'));
    assert.deepEqual(calls.pop(), ['addToVisit', 'a']);
    await closeSheet();

    // The idea already on the visit offers to come back off it.
    await click(section().querySelector('[data-someday-open="b"]'));
    const visitButton = document.querySelector('[data-someday-sheet="b"] [data-someday-add-to-visit]');
    assert(visitButton.textContent.includes('Remove from this visit'));
    await click(visitButton);
    assert.deepEqual(calls.pop(), ['removeFromVisit', 'b']);

    // Deleting asks first, then removes it from both partners' list.
    let confirmations = [];
    dom.window.confirm = (message) => { confirmations.push(message); return true; };
    await click(document.querySelector('[data-someday-sheet="b"] [data-someday-delete]'));
    assert.equal(confirmations.length, 1);
    assert(confirmations[0].includes('Sunset at the beach'));
    assert.deepEqual(calls.pop(), ['delete', 'b']);
    assert.equal(document.querySelector('[data-someday-sheet="b"]'), null, 'deleting closes the sheet');

    // An idea left on an older visit can still be taken off it.
    await click(section().querySelector('[data-someday-open="c"]'));
    const pastSheet = document.querySelector('[data-someday-sheet="c"]');
    assert(pastSheet.textContent.includes('On one of our visit plans'));
    await click(pastSheet.querySelector('[data-someday-remove-visit]'));
    assert.deepEqual(calls.pop(), ['removeFromVisit', 'c']);
    await closeSheet();

    // --- Quick add keeps the input open for the next idea --------------------------
    await click(button('Add to our list'));
    const newIdea = section().querySelector('[aria-label="A new someday idea"]');
    await setInput(newIdea, 'See the lighthouse');
    await act(async () => {
      newIdea.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }));
    });
    assert.deepEqual(calls.pop(), ['add', 'See the lighthouse', null]);
    assert.equal(section().querySelector('[aria-label="A new someday idea"]'), null, 'the quick-add form closes after adding');

    // --- With no visit yet, the sheet offers to plan one for this idea -------------
    calls.length = 0;
    await render({ visit: null });
    assert.equal(document.querySelector('[data-visit-card="empty"]') !== null, true);
    await click(section().querySelector('[data-someday-open="a"]'));
    const planButton = document.querySelector('[data-someday-sheet="a"] [data-someday-add-to-visit]');
    assert(planButton.textContent.includes('Plan our next visit'));
    await click(planButton);
    assert.deepEqual(calls.pop(), ['planForItem', 'a']);

    // --- Completing an idea moves it into the collapsed "completed" group ----------
    await closeSheet();
    await click(section().querySelector('[data-someday-item="a"] button[aria-label="Mark as complete"]'));
    assert.deepEqual(calls.pop(), ['toggle', 'a']);
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
