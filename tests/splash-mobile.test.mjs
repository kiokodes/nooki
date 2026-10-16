import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('splash screen: boot splash is replaced by the real splash, whose finish is reported', async () => {
  // Start from the shipped index.html, boot splash and all: on a phone this is what
  // paints while the bundle is still downloading, so it has to be there pre-JavaScript.
  const indexHtml = readSource('../index.html');
  const dom = new JSDOM(indexHtml, { url: 'http://localhost' });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'FormData', 'localStorage']) {
    globalThis[key] = dom.window[key];
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  const root = createRoot(document.getElementById('root'));
  try {
    assert(document.querySelector('[data-boot-splash]'), 'index.html paints a boot splash before any JavaScript runs');

    const { SplashScreen, SPLASH_DURATION_MS } = await server.ssrLoadModule('/src/components/common/SplashScreen.tsx');
    assert(SPLASH_DURATION_MS <= 1500, 'splash screen duration stays within 1.5s');

    let completions = 0;
    await act(async () => {
      root.render(React.createElement(SplashScreen, { onAnimationComplete: () => { completions += 1; } }));
    });

    // React takes over #root: the boot copy is gone, the real splash stands in its place.
    assert.equal(document.querySelector('[data-boot-splash]'), null, 'the boot splash is replaced when the app mounts');
    const splash = document.querySelector('[data-screen="splash"]');
    assert(splash, 'the real splash screen renders on mount');
    assert.equal(splash.querySelector('[data-splash-wordmark]')?.textContent, 'Nooki', 'the splash shows the Nooki wordmark');
    const track = splash.querySelector('[data-splash-track]');
    assert(track?.classList.contains('nooki-splash-track'), 'the race track carries the container class its distances are measured from');
    const pink = splash.querySelector('[data-splash-dot="pink"]');
    const green = splash.querySelector('[data-splash-dot="green"]');
    assert(pink?.classList.contains('nooki-splash-dot') && green?.classList.contains('nooki-splash-dot'),
      'both racing dots carry the splash dot classes');

    // The finish line is the green dot's own animationend (it runs last), not a
    // wall-clock guess — a phone that painted the splash late must still see the race.
    // jsdom exposes only the vendor-prefixed animation property, so React listens for
    // the prefixed event name there; real browsers use the standard one. Fire both.
    const fireAnimationEnd = async (dot) => {
      await act(async () => {
        dot.dispatchEvent(new window.Event('animationend', { bubbles: true }));
        dot.dispatchEvent(new window.Event('webkitAnimationEnd', { bubbles: true }));
      });
    };
    await fireAnimationEnd(pink);
    assert.equal(completions, 0, 'the pink dot finishing first does not end the splash');
    await fireAnimationEnd(green);
    assert.equal(completions, 1, 'the green dot finishing reports the splash as seen');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('splash screen: the race is compositor-driven and cannot be stranded off-screen', () => {
  const css = readSource('../src/index.css');

  // The primary keyframes race on transforms measured in track-width units (cqw), so
  // the animation runs on the compositor even while a phone's main thread is busy
  // mounting the app — the old `left` race elapsed unpainted on exactly those phones.
  const raceBlock = (name) => css.match(new RegExp(`@keyframes ${name} \\{([\\s\\S]*?)\\n\\}`))?.[1] ?? '';
  assert(raceBlock('nooki-dot-race-pink').includes('translateX(58cqw)'), 'the pink race is transform-driven across the track');
  assert(raceBlock('nooki-dot-race-green').includes('translateX(calc(100cqw + 14px))'), 'the green race ends just past the track edge');
  assert(!raceBlock('nooki-dot-race-pink').includes('left:'), 'the primary pink race never animates the layout property `left`');
  assert(css.includes('.nooki-splash-track') && css.includes('container-type: inline-size'),
    'the track is the inline-size container the cqw distances resolve against');
  assert(css.includes('@supports not (width: 1cqw)') && raceBlock('nooki-dot-race-pink-left').includes('left: 104%'),
    'browsers without container-query units still get the percentage `left` race');

  // The last dot must finish inside the advertised duration, or the fallback timer
  // would cut the race short on every device.
  const greenTiming = css.match(/\.nooki-splash-dot--green \{\s*animation: nooki-dot-race-green ([\d.]+)s[^;]*? ([\d.]+)s both;/);
  assert(greenTiming, 'the green dot animation timing is declared');
  assert(Number(greenTiming[1]) + Number(greenTiming[2]) <= 1.5, 'the green dot finishes within SPLASH_DURATION_MS');

  // Reduced motion (common on phones, rare on a dev desktop) must not strand the dots
  // off-screen: the splash still appears, with both dots parked visibly under the wordmark.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{(?:[^{}]|\{[^{]*\})*nooki-splash-dot--pink\s*\{\s*left: calc\(50% - 16px\)/) ;
  assert(reduced, 'reduced-motion readers get the splash dots parked visibly instead of off-screen');

  // index.html's boot splash uses the same compositor race, and the app wires the
  // real splash's finish (plus its painted-frame fallback) into dismissal.
  const indexHtml = readSource('../index.html');
  assert(indexHtml.includes('data-boot-splash') && indexHtml.includes('nooki-boot-race-pink')
    && indexHtml.includes('translateX(58cqw)'), 'the boot splash races before the bundle loads');
  const app = readSource('../src/App.tsx');
  assert(app.includes('onAnimationComplete={() => setSplashDone(true)}'), 'the app ends the splash when the race finishes');
  assert(app.includes("typeof requestAnimationFrame === 'function'"), 'the fallback dismissal timer waits for a painted frame (with a jsdom-safe fallback)');
});
