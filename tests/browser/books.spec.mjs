import { test, expect } from '@playwright/test';

// Drives the real EpubReader in a real Chromium with both a
// generated EPUB and one shaped like the couple's (EPUB 2.0, ncx,
// inline-SVG cover, @font-face rules without font files, an Adobe
// page-template link) and checks: pages render, taps turn pages
// (reporting a new CFI + percent), and selections report a range.
const consoleMessages = [];

async function bookLog(page) {
  return page.evaluate(() => window.__bookLog);
}

function renditionFrame(page) {
  return page.frames().find((candidate) => candidate !== page.mainFrame());
}

async function clickInsideBook(page, fraction) {
  const frame = renditionFrame(page);
  if (!frame) throw new Error('no rendition iframe found');
  await frame.evaluate((fractionX) => {
    const width = document.documentElement.clientWidth || 1;
    document.documentElement.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(width * fractionX),
      clientY: Math.round(window.innerHeight / 2),
    }));
  }, fraction);
}

for (const file of [
  'sample.epub',
  'realbook-like.epub',
  'v-epub3.epub',
  'v-nocover.epub',
  'v-nofonts.epub',
  'v-noxpgt.epub',
]) {
  test(`the reader renders, turns pages, and reports selections: ${file}`, async ({ page }) => {
    page.on('console', (message) => consoleMessages.push(`[console.${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${error.message}`));

    await page.goto(`/tests/browser/books.html?file=${file}`);

    await page.waitForFunction(() => window.__bookLog.some((entry) => entry.type === 'ready'), null, { timeout: 30_000 });

    let log = await bookLog(page);
    const errors = log.filter((entry) => entry.type === 'error');
    expect(errors, `engine reported errors: ${JSON.stringify(errors)}`).toEqual([]);

    // The opening page reports its location (relocated fires a frame
    // after display resolves, so wait for it rather than reading now).
    await page.waitForFunction(() => (
      window.__bookLog.some((entry) => entry.type === 'location')
    ), null, { timeout: 10_000 });

    log = await bookLog(page);
    const firstLocations = log.filter((entry) => entry.type === 'location');
    expect(firstLocations.length, 'the opening page reported a location').toBeGreaterThan(0);

    // Turn pages by tapping the right edge. A cover-first book needs
    // several turns before the percent moves off 0, so turn a few times.
    for (let turn = 0; turn < 8; turn++) {
      await clickInsideBook(page, 0.95);
      await page.waitForTimeout(400);
      const turned = await bookLog(page);
      const locs = turned.filter((entry) => entry.type === 'location');
      if (locs.some((entry) => Number(entry.percent) > 0)) break;
    }

    log = await bookLog(page);
    const locations = log.filter((entry) => entry.type === 'location');
    expect(locations.some((entry) => entry.location !== locations[0].location), 'a page turn reported a new CFI').toBe(true);
    expect(
      locations.some((entry) => Number(entry.percent) > 0),
      `percent stayed at 0: ${JSON.stringify(locations.map((entry) => entry.percent))}`,
    ).toBe(true);

    // Now on a text page: the content document actually rendered.
    const frame = renditionFrame(page);
    expect(frame, 'rendition iframe exists').toBeTruthy();
    const bodyText = await frame.evaluate(() => document.body.textContent ?? '');
    expect(bodyText.length, 'rendered page has text').toBeGreaterThan(100);

    // Select text inside the book: the reader must report a CFI range + quote.
    await frame.evaluate(() => {
      const paragraph = document.querySelector('p');
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(() => window.__bookLog.some((entry) => entry.type === 'selection'), null, { timeout: 10_000 });

    log = await bookLog(page);
    const selection = log.find((entry) => entry.type === 'selection');
    expect(String(selection.location)).toMatch(/epubcfi\(/);
    expect(String(selection.quoteText).length).toBeGreaterThan(10);
  });
}

test('a corrupt book says so instead of hanging blank', async ({ page }) => {
  page.on('pageerror', (error) => consoleMessages.push(`[pageerror] ${error.message}`));

  await page.goto('/tests/browser/books.html?file=corrupt.epub');

  // epubjs never settles book.ready for an unopenable archive, so the
  // reader reports the failure itself (the openFailed event, or the
  // open timeout as the backstop).
  await page.waitForFunction(() => (
    window.__bookLog.some((entry) => entry.type === 'error')
  ), null, { timeout: 25_000 });

  const log = await bookLog(page);
  const error = log.find((entry) => entry.type === 'error');
  expect(String(error.message)).toContain('could not be opened');
});
