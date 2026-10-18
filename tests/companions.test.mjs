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
    assert.equal(fallbackImg.getAttribute('data-expression'), 'happy', 'falls back to happy expression');
    assert(fallbackImg.getAttribute('src')?.includes('pair-happy.png'), 'falls back to happy PNG');

    // 4. Non-decorative accessibility
    await act(async () => {
      root.render(React.createElement(NookiPair, {
        expression: 'affectionate',
        decorative: false,
        accessibleLabel: 'Two companions holding hands',
      }));
    });
    const accessibleImg = dom.window.document.querySelector('img[data-nooki-pair]');
    assert.equal(accessibleImg.getAttribute('role'), 'img', 'non-decorative image has role="img"');
    assert.equal(accessibleImg.getAttribute('alt'), 'Two companions holding hands', 'supplies accessible alt text');
    assert.equal(accessibleImg?.hasAttribute('aria-hidden'), false, 'non-decorative image is accessible to screen readers');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});

// The companions no longer stand in the Home nook (the couple's own picture does —
// see the HomeView test below), but they remain the app's mascot artwork: the
// icon, the splash and any future ambient scene still render them through this
// component, so its contract keeps its own test.
test('HomeNookiCompanions: idle animation, presence awareness, and real loop extensibility', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;

  const root = createRoot(dom.window.document.getElementById('root'));

  try {
    const { HomeNookiCompanions } = await server.ssrLoadModule('/src/components/home/HomeNookiCompanions.tsx');

    // 1. Renders the pair decoratively: calm happy art while the partner is away.
    await act(async () => {
      root.render(React.createElement(HomeNookiCompanions));
    });

    const companions = dom.window.document.querySelector('[data-component="home-nooki-companions"]');
    assert(companions, 'HomeNookiCompanions renders');
    assert.equal(companions.getAttribute('aria-hidden'), 'true', 'companions are decorative and aria-hidden');
    assert.equal(companions.style.pointerEvents, 'none', 'companions do not intercept touch/mouse events');
    assert.equal(companions.getAttribute('data-partner-online'), 'false', 'starts in partner-away mode by default');

    const artwork = companions.querySelector('img[data-nooki-pair]');
    assert(artwork, 'renders pair illustration');
    assert.equal(artwork.getAttribute('data-expression'), 'happy', 'uses a calm happy expression while the partner is away');
    assert.equal(artwork.style.aspectRatio, '1 / 1', 'preserves 1:1 aspect ratio');
    assert.equal(artwork.style.objectFit, 'contain', 'uses object-fit contain');

    // 2. Restrained idle effect, anchored near the feet.
    const idleWrapper = companions.querySelector('.nooki-companions-idle');
    assert(idleWrapper, 'applies restrained idle animation wrapper');
    const artContainer = companions.querySelector('.nooki-companions-art');
    assert(artContainer, 'art container present');
    assert.equal(artContainer.style.transformOrigin, '50% 83.5%', 'anchored near feet (y=83.5%)');

    // 3. Presence-aware context expression: affectionate art when both are together.
    await act(async () => {
      root.render(React.createElement(HomeNookiCompanions, {
        ambient: true,
        partnerOnline: true,
        expression: 'affectionate',
      }));
    });
    const togetherCompanions = dom.window.document.querySelector('[data-component="home-nooki-companions"]');
    assert.equal(togetherCompanions.getAttribute('data-partner-online'), 'true', 'updates to together mode when the partner comes online');
    assert.equal(
      togetherCompanions.querySelector('[data-layer="overlay"] img[data-nooki-pair]')?.getAttribute('data-expression'),
      'affectionate',
      'crossfades to affectionate art when both partners are available',
    );

    // 4. Paused prop stops animation
    await act(async () => {
      root.render(React.createElement(HomeNookiCompanions, { paused: true }));
    });
    const pausedComp = dom.window.document.querySelector('[data-component="home-nooki-companions"]');
    assert.equal(pausedComp.getAttribute('data-companions-active'), 'false', 'marked inactive when paused');
    assert(pausedComp?.querySelector('.nooki-companions-paused'), 'applies paused class');

    // 5. Future animation loop extensibility via renderAnimation
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

test('HomeView: the nook holds the couple picture frame, with the caption and miss-you button untouched', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  globalThis.HTMLImageElement = dom.window.HTMLImageElement;

  const root = createRoot(dom.window.document.getElementById('root'));

  try {
    const { HomeView } = await server.ssrLoadModule('/src/components/home/HomeView.tsx');

    // 1. The reserved slot at the bottom of Home is the frame, and before a picture
    //    is framed it simply invites the couple to upload one.
    await act(async () => {
      root.render(React.createElement(HomeView, {
        events: [],
        anniversaryDate: '2024-01-01',
        eventsLoading: false,
        eventsError: null,
        onOpenCalendar: () => {},
        photo: { src: null, onUpload: () => {} },
      }));
    });

    const home = dom.window.document.querySelector('[data-screen="home"]');
    assert(home, 'Home tab renders');

    const scenePlaceholder = home.querySelector('[data-scene-placeholder]');
    assert(scenePlaceholder, 'reserved scene placeholder exists');
    assert.equal(home.lastElementChild, scenePlaceholder, 'scene placeholder is the last element above bottom navigation');

    const nookCaption = scenePlaceholder.querySelector('[data-nooki-caption]');
    assert.equal(nookCaption?.textContent.trim(), 'Our little nook', 'caption uses the shared "our little nook" wording');
    assert.equal(nookCaption?.style.position, 'absolute', 'caption is overlaid on the nook card');
    assert.equal(nookCaption?.style.top, '10px', 'caption sits at the top of the nook');
    assert.equal(nookCaption?.style.right, '12px', 'caption sits at the right of the nook');
    assert.equal(
      scenePlaceholder.getAttribute('aria-label'),
      'Our little nook — our favourite picture in its frame',
      'the nook region has an accessible shared-space label',
    );

    const frame = scenePlaceholder.querySelector('[data-component="nook-photo-frame"]');
    assert(frame, 'the couple picture frame renders inside the reserved slot');
    assert.equal(frame.getAttribute('data-has-photo'), 'false', 'starts empty before the first picture');
    const frameButton = frame.querySelector('button[data-nooki-frame-button]');
    assert(frameButton, 'the frame is one whole button');
    assert.equal(frameButton.getAttribute('aria-label'), 'Upload your couple picture', 'the empty frame invites the upload');
    assert(
      frame.querySelector('[data-nooki-frame-prompt]')?.textContent.includes('Upload your couple picture'),
      'the prompt is written out, not just announced',
    );
    assert.equal(frame.querySelector('img[data-nooki-pair]'), null, 'the mascot artwork no longer stands in the nook');

    // 2. Once a picture is framed, it is the first thing the nook shows — and
    //    replacing it is a deliberate act, not a pocket tap.
    await act(async () => {
      root.render(React.createElement(HomeView, {
        events: [],
        anniversaryDate: '2024-01-01',
        eventsLoading: false,
        eventsError: null,
        onOpenCalendar: () => {},
        photo: { src: 'https://example.test/us.jpg', onUpload: () => {} },
      }));
    });

    const framed = dom.window.document.querySelector('[data-component="nook-photo-frame"]');
    assert.equal(framed.getAttribute('data-has-photo'), 'true', 'the frame shows the framed picture');
    const photo = framed.querySelector('img[data-nooki-photo]');
    assert(photo, 'the picture renders inside the mat window');
    assert.equal(photo.getAttribute('src'), 'https://example.test/us.jpg', 'the picture is the signed URL the couple uploaded');
    assert.equal(photo.style.objectFit, 'cover', 'the picture fills the window without stretching');
    assert.equal(
      framed.querySelector('button[data-nooki-frame-button]').getAttribute('aria-label'),
      'Replace the picture in the frame',
      'a framed picture turns the button into a deliberate replace',
    );

    // 3. The miss-you button still lives in the nook's top-left corner.
    await act(async () => {
      root.render(React.createElement(HomeView, {
        events: [],
        anniversaryDate: '2024-01-01',
        eventsLoading: false,
        eventsError: null,
        onOpenCalendar: () => {},
        photo: { src: 'https://example.test/us.jpg', onUpload: () => {} },
        missYou: { visible: true, sentCount: 0, onTap: () => {} },
      }));
    });
    const nook = dom.window.document.querySelector('[data-scene-placeholder]');
    const corner = nook.querySelector('[data-miss-you="corner"]');
    assert(corner, 'the "I miss you" button stays in the nook');
    assert(nook.contains(nook.querySelector('[data-component="nook-photo-frame"]')), 'the frame and the button share the nook');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});
