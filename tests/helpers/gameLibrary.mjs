import assert from 'node:assert/strict';

/**
 * The Games tab is a carousel: one game title in the rail, one settings panel under it.
 * Only the chosen game's settings and start button are on the page, so a test that wants
 * to start a particular game first picks it, exactly as a thumb would.
 *
 * `act` is React's act(), so the click and the re-render it causes settle before the
 * assertions. Returns the chip, so a caller can assert on the selection it left behind.
 */
export async function openGameTab(document, gameId, act) {
  const tab = document.querySelector(`[data-game-tab="${gameId}"]`);
  assert.ok(tab, `the ${gameId} tab should be in the game rail`);
  await act(async () => { tab.click(); });
  const panel = document.querySelector(`[data-game="${gameId}"]`);
  assert.ok(panel, `choosing ${gameId} should show its settings panel`);
  assert.equal(tab.getAttribute('aria-selected'), 'true', `the ${gameId} chip reads as selected`);
  assert.equal(panel.getAttribute('role'), 'tabpanel', 'the panel is labelled as the chosen tab');
  return tab;
}
