import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

const readSource = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/** Declarations only: prose is allowed to name the things the code must not do. */
const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '');

/** The body of a block, found by brace counting (keyframes nest their own braces). */
const blockAfter = (source, header) => {
  const start = source.indexOf(header);
  if (start === -1) return '';
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  return '';
};

/** One @keyframes block, whitespace flattened so two files can be compared value for value. */
const keyframes = (source, name) =>
  blockAfter(source, `@keyframes ${name}`).replace(/\s+/g, ' ').trim();

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
    assert(document.querySelector('.nooki-boot-waiting')?.textContent.includes('Waking up your nook'),
      'and says what it is doing if the bundle is slow');

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
    assert(splash.querySelector('[data-splash-track]')?.classList.contains('nooki-splash-track'),
      'the race track carries the class its distances are measured from');
    assert(splash.querySelector('[data-splash-waiting]'), 'the slow-load line exists, hidden until it is needed');

    const pink = splash.querySelector('[data-splash-dot="pink"]');
    const green = splash.querySelector('[data-splash-dot="green"]');
    assert(pink?.classList.contains('nooki-splash-runner') && green?.classList.contains('nooki-splash-runner'),
      'each dot rides a full-width runner');
    assert(pink.querySelector('.nooki-splash-dot') && green.querySelector('.nooki-splash-dot'),
      'with the visible dot inside it');

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

    // No boot splash (design preview, tests, an unmarked launch): the whole race plays.
    assert.equal(splash.querySelector('[data-splash-track]').style.getPropertyValue('--nooki-race-delay'), '-0ms',
      'without a head start the race starts from its first keyframe');

    // With one, the race is carried on instead of replayed.
    await act(async () => {
      root.render(React.createElement(SplashScreen, { elapsedMs: 620 }));
    });
    const headStart = document.querySelector('[data-splash-track]').style.getPropertyValue('--nooki-race-delay');
    assert.equal(headStart, '-620ms', 'the race resumes 620ms in when the boot splash already ran 620ms of it');
    await act(async () => {
      root.render(React.createElement(SplashScreen, { elapsedMs: 9000 }));
    });
    assert.equal(document.querySelector('[data-splash-track]').style.getPropertyValue('--nooki-race-delay'), '-1500ms',
      'a head start past the whole race holds the finishing pose rather than running backwards');
  } finally {
    await act(() => root.unmount());
    await server.close();
    dom.window.close();
  }
});

test('splash race: compositor-driven, matched by the boot splash, and never stranded', () => {
  const css = readSource('../src/index.css');
  const indexHtml = readSource('../index.html');
  const declarations = stripComments(css);
  const bootDeclarations = stripComments(indexHtml);

  // The race runs on the compositor, on transforms, in every browser. It must not use
  // `left` (main-thread layout: the race elapses unpainted while a phone mounts the app)
  // nor container-query units (resolved on the main thread, and unsupported on older
  // browsers — this is the version that stood still on mobile).
  assert(!declarations.includes('cqw'), 'the stylesheet no longer measures the race in container units');
  assert(!bootDeclarations.includes('cqw'), 'and neither does the boot splash');
  assert(!declarations.includes('@supports not'), 'so the container-unit fallback race is gone with it');
  assert(!keyframes(css, 'nooki-splash-race-pink').includes('left:'), 'the pink race never animates the layout property `left`');
  assert(keyframes(css, 'nooki-splash-race-pink').includes('translateX(calc(58% + 0px))'),
    'the pink race travels 58% of its own width — a share of the track — with no units to resolve');
  assert(keyframes(css, 'nooki-splash-race-green').includes('translateX(calc(100% + 14px))'),
    'the green race ends just past the track edge');

  // The runners are full-width, so a percentage of the runner *is* a percentage of the
  // track, and the scale grows the dot about its own centre — the point the old keyframes
  // used — so the run looks exactly as it did.
  const runner = css.match(/\.nooki-splash-runner \{([^}]*)\}/)?.[1] ?? '';
  assert(runner.includes('width: 100%'), 'a runner spans the whole track');
  assert(runner.includes('transform-origin: 5px 50%'), 'and scales its dot about the dot’s own centre');
  assert(runner.includes('animation-delay: var(--nooki-race-delay, 0ms)'),
    'the runner takes the head start the boot splash left for it');
  assert(css.match(/\.nooki-splash-runner--green \{([^}]*)\}/)?.[1].includes('calc(var(--nooki-race-delay, 0ms) + 0.1s)'),
    'and the green dot keeps its beat after any head start');

  // The last dot must finish inside the advertised duration, or the fallback timer
  // would cut the race short on every device.
  const green = css.match(/\.nooki-splash-runner--green \{([^}]*)\}/)?.[1] ?? '';
  const duration = Number(runner.match(/animation-duration:\s*([\d.]+)s/)?.[1]);
  const delay = Number(green.match(/animation-delay:\s*calc\(var\(--nooki-race-delay, 0ms\) \+ ([\d.]+)s\)/)?.[1]);
  assert.equal(duration, 1.35, 'the green run is 1.35s');
  assert.equal(delay, 0.1, 'and starts a beat after the pink one');
  assert(duration + delay <= 1.5, 'and finishes within SPLASH_DURATION_MS');

  // index.html's boot splash is the *same* race, with the same structure: one of the two
  // copies always drifts first, so they are compared value for value.
  assert.equal(
    keyframes(indexHtml, 'nooki-boot-race-pink').replace(/nooki-boot/g, 'nooki-splash'),
    keyframes(css, 'nooki-splash-race-pink'),
    'the boot splash runs the same pink race as the app',
  );
  assert.equal(
    keyframes(indexHtml, 'nooki-boot-race-green').replace(/nooki-boot/g, 'nooki-splash'),
    keyframes(css, 'nooki-splash-race-green'),
    'and the same green race',
  );
  assert(indexHtml.includes('nooki-boot-runner') && indexHtml.includes('nooki-boot-dot--pink')
    && indexHtml.includes('width: 100%'), 'the boot splash uses the same runner structure');

  // Reduced motion (common on phones, rare on a dev desktop) must not strand the dots
  // off-screen: the splash still appears, with both dots parked visibly under the wordmark.
  const reduced = css.match(/@media \(prefers-reduced-motion: reduce\) \{(?:[^{}]|\{[^{]*\})*nooki-splash-runner--pink\s*\{\s*left: calc\(50% - 16px\)/);
  assert(reduced, 'reduced-motion readers get the splash dots parked visibly instead of off-screen');

  // The app wires the real splash's finish (plus its painted-frame fallback) into dismissal,
  // and hands it the head start the boot splash recorded.
  const app = readSource('../src/App.tsx');
  assert(app.includes('onAnimationComplete={() => setSplashDone(true)}'), 'the app ends the splash when the race finishes');
  assert(app.includes("typeof requestAnimationFrame === 'function'"), 'the fallback dismissal timer waits for a painted frame (with a jsdom-safe fallback)');
});

test('launch speed: the first paint is not held up, and the race is played once', async () => {
  const indexHtml = readSource('../index.html');

  // A stylesheet in the head is render-blocking: on a phone it sat between the Home Screen
  // icon and the splash, waiting on a third-party host. The fonts are fetched off the
  // critical path now, and still arrive — including for a browser with JavaScript off.
  const fontLinks = [...indexHtml.matchAll(/<link\b[^>]*fonts\.googleapis\.com\/css2[^>]*>/g)].map((match) => match[0]);
  assert.equal(fontLinks.length, 2, 'the font stylesheet is linked twice: the deferred copy and the no-JS one');
  const [deferred, noScript] = fontLinks;
  assert.match(deferred, /media="print"/, 'the main copy is fetched without blocking the first paint');
  assert.match(deferred, /onload="this\.media='all'"/, 'and applied as soon as it arrives');
  assert(indexHtml.indexOf('<noscript>') < indexHtml.indexOf(noScript), 'the second copy lives in <noscript>');
  assert.doesNotMatch(noScript, /media=|onload=/, 'where it is a plain stylesheet, as it must be');
  assert(indexHtml.includes('display=swap'), 'and text stays visible while the fonts load');
  assert.match(deferred, /rel="stylesheet"/, 'this is still a stylesheet, not a preload that never applies');

  // The boot splash records when its own race began, and the app reads it there: the marker
  // name is written in two languages, so the two are compared literally.
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { BOOT_RACE_MARKER, bootRaceElapsedMs } = await server.ssrLoadModule('/src/lib/bootRace.ts');
    assert(indexHtml.includes(`window.${BOOT_RACE_MARKER} = {`), 'index.html writes the marker the app reads');
    assert.match(indexHtml, /startedAt:\s*typeof performance/, 'recording the clock the animation itself runs on');

    // No marker — the design preview, the tests, a cached index.html from before this change
    // — means "play the whole race", never a negative head start.
    delete globalThis[BOOT_RACE_MARKER];
    assert.equal(bootRaceElapsedMs(), 0, 'without a marker the race starts at the beginning');
    globalThis[BOOT_RACE_MARKER] = { startedAt: performance.now() - 500 };
    const elapsed = bootRaceElapsedMs();
    assert(elapsed >= 500 && elapsed < 1000, `the marker is read against the same clock (got ${Math.round(elapsed)}ms)`);
    globalThis[BOOT_RACE_MARKER] = { startedAt: performance.now() + 1000 };
    assert.equal(bootRaceElapsedMs(), 0, 'a marker from a clock further ahead is never a negative head start');
    globalThis[BOOT_RACE_MARKER] = { startedAt: 'soon' };
    assert.equal(bootRaceElapsedMs(), 0, 'and nonsense is ignored rather than trusted');
    delete globalThis[BOOT_RACE_MARKER];
  } finally {
    await server.close();
  }

  // The app reads it once, before the first render, gives it to the splash and takes it off
  // its own fallback — which is what stops a phone launch from being two races long.
  const app = readSource('../src/App.tsx');
  assert(app.includes('useState(bootRaceElapsedMs)'), 'the app reads the head start once, at the first render');
  assert(app.includes('elapsedMs={bootRaceElapsed}'), 'and hands it to the splash');
  assert(app.includes('Math.max(0, SPLASH_DURATION_MS - bootRaceElapsed)'),
    'the fallback only waits out what is left of the race');
});
