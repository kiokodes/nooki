import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

test('Together tab: a simple shared notebook uses numbered lines and saved arrow ordering', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent']) globalThis[key] = dom.window[key];
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
    const makeItem = (id, text, sort_order) => ({
      id, couple_id: 'c1', text, details: null, sort_order, visit_date: null, visit_id: null,
      completed: false, completed_at: null, created_by: 'me', created_at: '', updated_at: '',
    });
    const render = (items = [makeItem('one', 'Visit the night market', 0), makeItem('two', 'Watch the sunset', 1)]) => act(async () => {
      root.render(React.createElement(TogetherView, {
        somedayItems: items,
        onAddSomedayItem: async (text) => calls.push(['add', text]),
        onDeleteSomedayItem: async (item) => calls.push(['delete', item.id]),
        onToggleSomedayItem: async (item) => calls.push(['toggle', item.id]),
        onReorderSomedayItems: async (ids) => calls.push(['reorder', ids]),
      }));
    });
    await render();

    const notebook = document.querySelector('.someday-notebook');
    assert.equal(notebook.tagName, 'OL', 'the list is a numbered notebook, not a stack of cards');
    assert.equal(document.querySelectorAll('[data-someday-item]').length, 2);
    assert.equal(document.querySelector('[data-someday-item="one"]').dataset.somedayOrder, '1');
    assert(document.querySelector('.someday-notebook').classList.contains('someday-notebook'));
    assert.equal(document.querySelector('[data-section="together-time"]'), null, 'Together time is removed');
    assert.equal(document.querySelector('[aria-label="Who can see this idea"]'), null, 'there is no private/share switch');
    assert.equal(document.querySelector('[data-someday-want]'), null, 'there is no vote to want an item');
    assert.equal(document.querySelector('textarea'), null, 'tasks have no context/notes editor');

    await act(async () => document.querySelector('[aria-label="Move Visit the night market down"]').click());
    assert.deepEqual(calls.pop(), ['reorder', ['two', 'one']]);
    await render([makeItem('two', 'Watch the sunset', 0), makeItem('one', 'Visit the night market', 1)]);
    assert(document.querySelector('[aria-label="Move Visit the night market up"]'));
    assert.equal(document.querySelector('[aria-label="Move Visit the night market up"]').disabled, false);

    const input = document.querySelector('[aria-label="Add a task to the shared list"]');
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => { setter.call(input, 'Cook dinner together'); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); });
    await act(async () => document.querySelector('[aria-label="Add task"]').click());
    assert.deepEqual(calls.pop(), ['add', 'Cook dinner together']);
    await act(async () => document.querySelector('[aria-label="Delete Visit the night market"]').click());
    assert.deepEqual(calls.pop(), ['delete', 'one']);
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
