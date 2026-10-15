import { test } from 'node:test';
import assert from 'node:assert/strict';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('NookiPair: expression fallback, accessibility semantics, and 1:1 aspect ratio', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;

  const root = createRoot(dom.window.document.getElementById('root'));

  try {
    const { NookiPair } = await server.ssrLoadModule('/src/components/common/NookiPair.tsx');

    // 1. Default expression is happy, decorative by default
    await act(async () => {
      root.render(React.createElement(NookiPair));
    });

    const img = dom.window.document.querySelector('img[data-nooki-pair]');
    assert(img, 'NookiPair renders an img element');
    assert.equal(img.getAttribute('data-expression'), 'happy', 'defaults to happy expression');
    assert.equal(img.getAttribute('alt'), '', 'decorative image has empty alt');
    assert.equal(img.getAttribute('role'), 'presentation', 'decorative image has role="presentation"');
    assert.equal(img.getAttribute('aria-hidden'), 'true', 'decorative image has aria-hidden="true"');
    assert.equal(img.style.aspectRatio, '1 / 1', 'enforces 1:1 aspect ratio');
    assert.equal(img.style.objectFit, 'contain', 'enforces object-fit: contain');
    assert.equal(img.style.pointerEvents, 'none', 'decorative image is excluded from pointer events');
    assert(img.getAttribute('src')?.includes('pair-happy.png'), 'points to happy pair PNG');

    // 2. All 5 expressions supported
    const expressions = ['happy', 'laughing', 'shy', 'surprised', 'affectionate'];
    for (const expr of expressions) {
      await act(async () => {
        root.render(React.createElement(NookiPair, { expression: expr }));
      });
      const exprImg = dom.window.document.querySelector('img[data-nooki-pair]');
      assert.equal(exprImg?.getAttribute('data-expression'), expr, `supports ${expr} expression`);
      assert(exprImg?.getAttribute('src')?.includes(`pair-${expr}.png`), `points to pair-${expr}.png asset`);
    }

    // 3. Fallback for invalid expression
    await act(async () => {
      root.render(React.createElement(NookiPair, { expression: 'unknown_expression' }));
    });
    const fallbackImg = dom.window.document.querySelector('img[data-nooki-pair]');
    assert.equal(fallbackImg?.getAttribute('data-expression'), 'happy', 'falls back to happy expression');
    assert(fallbackImg?.getAttribute('src')?.includes('pair-happy.png'), 'falls back to happy PNG');

    // 4. Non-decorative accessibility
    await act(async () => {
      root.render(React.createElement(NookiPair, {
        expression: 'affectionate',
        decorative: false,
        accessibleLabel: 'Two companions holding hands',
      }));
    });
    const accessibleImg = dom.window.document.querySelector('img[data-nooki-pair]');
    assert.equal(accessibleImg?.getAttribute('role'), 'img', 'non-decorative image has role="img"');
    assert.equal(accessibleImg?.getAttribute('alt'), 'Two companions holding hands', 'supplies accessible alt text');
    assert.equal(accessibleImg?.hasAttribute('aria-hidden'), false, 'non-decorative image is accessible to screen readers');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('HomeNookiCompanions: reserved slot placement, idle animation, and real loop extensibility', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;

  const root = createRoot(dom.window.document.getElementById('root'));

  try {
    const { HomeNookiCompanions } = await server.ssrLoadModule('/src/components/home/HomeNookiCompanions.tsx');
    const { HomeView } = await server.ssrLoadModule('/src/components/home/HomeView.tsx');

    // 1. Renders inside HomeView in the reserved slot immediately above bottom navigation
    await act(async () => {
      root.render(React.createElement(HomeView, {
        events: [],
        anniversaryDate: '2024-01-01',
        eventsLoading: false,
        eventsError: null,
        onOpenCalendar: () => {},
      }));
    });

    const home = dom.window.document.querySelector('[data-screen="home"]');
    assert(home, 'Home tab renders');

    const scenePlaceholder = home.querySelector('[data-scene-placeholder]');
    assert(scenePlaceholder, 'reserved scene placeholder exists');
    assert.equal(home.lastElementChild, scenePlaceholder, 'scene placeholder is the last element above bottom navigation');

    // The reserved area has empty text content for screen readers / accessibility
    assert.equal(scenePlaceholder.textContent, '', 'reserved area has empty text content');

    const companions = scenePlaceholder.querySelector('[data-component="home-nooki-companions"]');
    assert(companions, 'HomeNookiCompanions component renders inside reserved slot');
    assert.equal(companions.getAttribute('aria-hidden'), 'true', 'companions are decorative and aria-hidden');
    assert.equal(companions.style.pointerEvents, 'none', 'companions do not intercept touch/mouse events');

    const artwork = companions.querySelector('img[data-nooki-pair]');
    assert(artwork, 'renders pair illustration');
    assert.equal(artwork.getAttribute('data-expression'), 'happy', 'uses happy expression by default');
    assert.equal(artwork.style.aspectRatio, '1 / 1', 'preserves 1:1 aspect ratio');
    assert.equal(artwork.style.objectFit, 'contain', 'uses object-fit contain');

    // 2. Restrained idle effect
    const idleWrapper = companions.querySelector('.nooki-companions-idle');
    assert(idleWrapper, 'applies restrained idle animation wrapper');
    const artContainer = companions.querySelector('.nooki-companions-art');
    assert(artContainer, 'art container present');
    assert.equal(artContainer.style.transformOrigin, '50% 83.5%', 'anchored near feet (y=83.5%)');

    // 3. Paused prop stops animation
    await act(async () => {
      root.render(React.createElement(HomeNookiCompanions, { paused: true }));
    });
    const pausedComp = dom.window.document.querySelector('[data-component="home-nooki-companions"]');
    assert.equal(pausedComp?.getAttribute('data-companions-active'), 'false', 'marked inactive when paused');
    assert(pausedComp?.querySelector('.nooki-companions-paused'), 'applies paused class');

    // 4. Future animation loop extensibility via renderAnimation
    await act(async () => {
      root.render(React.createElement(HomeNookiCompanions, {
        renderAnimation: () => React.createElement('div', { 'data-custom-loop': 'active' }),
      }));
    });
    const customLoop = dom.window.document.querySelector('[data-custom-loop="active"]');
    assert(customLoop, 'supports dropping in finished transparent animation loop without rebuilding home page');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
