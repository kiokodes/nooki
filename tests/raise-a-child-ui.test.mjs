import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

// The real components, rendered without a backend: the Together card, the sheet it opens,
// the private pick, the reveal, the album and the letter. The preview's partner answers on
// a timer, exactly like the second phone would.
test('Raise a Child: one card in Together, a private pick, a shared reveal', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost', pretendToBeVisual: true });
  for (const key of ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent']) globalThis[key] = dom.window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: React, act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const { PreviewTogether } = await server.ssrLoadModule('/src/preview/PreviewTogether.tsx');
    let chatOpened = 0;
    await act(async () => root.render(React.createElement(PreviewTogether, {
      partnerName: 'Ravi', userName: 'Ana', onOpenChat: () => { chatOpened += 1; },
    })));
    const settle = async (ms) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
    const buttonText = (text) => [...document.querySelectorAll('button')].find((item) => item.textContent.includes(text));

    // The entry point is the one card in Together, with the child's name on it.
    const card = document.querySelector('[data-card="raise-a-child"]');
    assert.ok(card, 'the family card is in Together');
    assert.equal(card.textContent.includes('Mia, 4 years old'), true);
    assert.ok(card.querySelector('.raise-child-avatar'), 'the card carries the child’s drawing');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'the sheet is closed until asked for');

    await act(async () => card.click());
    const sheet = document.querySelector('[role="dialog"]');
    assert.ok(sheet, 'the card opens the family sheet');
    assert.equal(sheet.getAttribute('aria-modal'), 'true');

    // The home screen: the child, their soft mood, their traits, and the bond as language.
    const body = sheet.querySelector('.raise-child-sheet__body');
    assert.equal(body.textContent.includes('Mia'), true);
    assert.equal(body.textContent.includes('4 years old'), true);
    assert.equal(body.textContent.includes('feels safe'), true);
    assert.deepEqual([...body.querySelectorAll('.raise-child-trait')].map((chip) => chip.textContent), ['Kind', 'Curious', 'Brave']);
    assert.equal(body.textContent.includes('Mia looks for you first when the door opens.'), true);
    assert.equal(/\b\d+\s*\/\s*100\b/.test(body.textContent), false, 'no bond number anywhere');
    assert.equal(body.querySelectorAll('progress, meter').length, 0, 'and no bar');

    // The moment, with both options and a promise that the pick stays private.
    assert.equal(body.textContent.includes('The broken vase'), true);
    assert.equal(body.textContent.includes('A favourite vase is in three pieces'), true);
    const choices = [...body.querySelectorAll('.raise-child-choice')];
    assert.deepEqual(
      choices.map((choice) => choice.textContent.replace(/^\d/, '').trim()),
      ['Clean it up together', 'Ask what happened first', 'Sit down with her before anything else'],
      'a card offers a trade-off, not a yes or no',
    );
    assert.equal(body.textContent.includes('Only you can see this answer until Ravi has chosen too.'), true);

    await act(async () => choices[0].click());
    assert.equal(body.textContent.includes('You picked “Clean it up together”.'), true, 'the pick is confirmed');
    assert.equal(body.textContent.includes('Waiting for Ravi.'), true, 'and the partner is named, not blamed');
    assert.equal(body.textContent.includes('Kept in the album.'), false, 'the outcome is not there yet');

    // The partner answers differently. Nothing settles itself: the split is shown, both
    // picks in the open, with the two ways to settle it.
    await settle(1600);
    assert.equal(body.textContent.includes('You chose differently.'), true);
    const picks = [...body.querySelectorAll('.raise-child-pick')].map((pick) => pick.textContent);
    assert.equal(picks.some((pick) => pick.startsWith('You') && pick.includes('Clean it up together')), true);
    assert.equal(picks.some((pick) => pick.startsWith('Ravi') && pick.includes('Ask what happened first')), true);
    assert.equal(body.textContent.includes('Kept in the album.'), false, 'a split is not an outcome');
    assert.ok(buttonText('Talk it out'), 'the two of them can take it to chat');
    assert.ok(buttonText('Use my decision'), 'and this year’s lead parent can use their call');
    assert.ok(buttonText('Change my pick'), 'with one change of mind still in hand');

    // Talking it out opens the chat, and the year is still open when you come back.
    await act(async () => buttonText('Talk it out').click());
    assert.equal(chatOpened, 1, 'the chat opens with the split');
    assert.equal(document.querySelector('[role="dialog"]'), null, 'and the sheet steps out of the way');
    await act(async () => document.querySelector('[data-card="raise-a-child"]').click());
    const reopened = document.querySelector('.raise-child-sheet__body');
    assert.equal(reopened.textContent.includes('You chose differently.'), true, 'nothing was decided behind your back');

    // Now the lead parent settles it, in the open.
    const decide = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Use my decision'));
    await act(async () => decide.click());
    assert.equal(reopened.textContent.includes('You wanted different things. You had this year’s call, and used it.'), true, 'the reveal says plainly what happened');
    assert.equal(reopened.textContent.includes('You swept it up side by side.'), true, 'and the outcome text is read out');
    assert.equal(reopened.textContent.includes('Kept in the album.'), true);
    assert.equal(reopened.textContent.includes('missed'), false, 'nothing scolds anyone');
    assert.equal(reopened.textContent.includes('Coming soon'), false);
    const bodyAfter = reopened;

    // The small surprise, and the album it lands in.
    assert.equal(bodyAfter.textContent.includes('Something arrived'), true);
    await act(async () => buttonText('Open it').click());
    assert.equal(reopened.textContent.includes('All afternoon, to the fridge, the window, and the cat next door.'), true);

    await act(async () => buttonText('The album').click());
    const years = [...document.querySelectorAll('.raise-child-album__year')].map((item) => item.textContent);
    assert.deepEqual(years, ['The first year', 'Two', 'Three', 'Four'], 'the album groups its pages by the child’s age');
    assert.equal(document.querySelectorAll('.raise-child-entry').length, 4);
    assert.equal(document.querySelectorAll('.raise-child-entry__kind')[0].textContent, 'A milestone');
    assert.equal(document.querySelectorAll('.raise-child-entry__kind')[2].textContent, 'A small surprise');

    // Back home, then the letter at eighteen.
    await act(async () => document.querySelector('[aria-label="Back"]').click());
    await act(async () => document.querySelector('[aria-label="Close"]').click());
    assert.equal(document.querySelector('[role="dialog"]'), null, 'the sheet closes');

    await act(async () => buttonText('The letter at eighteen').click());
    await act(async () => document.querySelector('[data-card="raise-a-child"]').click());
    const letter = document.querySelector('.raise-child-letter');
    assert.ok(letter, 'the letter arrives in the sheet');
    assert.equal(letter.textContent.includes('Dear both of you,'), true);
    assert.equal(letter.textContent.includes('I am all right.'), true, 'and it is kind');
    assert.equal(letter.textContent.trim().endsWith('.'), true, 'with no app-drawn signature');

    const reply = document.querySelector('.raise-child-textarea');
    assert.ok(reply, 'there is one line back');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(reply, 'We read it twice.');
      reply.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelector('.raise-child-count').textContent, '17/400');
    const keep = [...document.querySelectorAll('button')].find((item) => item.textContent.includes('Keep this note'));
    assert.ok(keep, 'the note can be kept');
    assert.equal(keep.disabled, false);
    await act(async () => keep.click());
    assert.ok(document.querySelector('.raise-child-note')?.textContent.includes('Saved to the album'), 'the note is acknowledged');
    assert.equal(document.body.textContent.includes('Start a new child'), true, 'and the choice to begin again is offered');
  } finally {
    await act(async () => root.unmount());
    await server.close();
    dom.window.close();
  }
});
