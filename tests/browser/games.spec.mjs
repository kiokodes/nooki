import { test, expect } from '@playwright/test';

// Exercise the real hook, service and UI. Only the HTTP boundary is faked here;
// the PostgreSQL tests separately exercise the same RPCs and migrations with RLS.
async function mockGames(page, options = {}) {
  const state = {
    reads: 0, starts: 0, legacySnake: false, offline: false, ...options,
    snapshot: { today: '2026-10-15', wins: {}, matches: [] },
  };
  await page.route('https://test-project.supabase.co/**', async (route) => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split('/').at(-1);
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (state.offline) return route.abort('internetdisconnected');
    if (name === 'games_state') {
      state.reads += 1;
      return route.fulfill({ json: state.snapshot, headers });
    }
    if (name === 'start_game') {
      state.starts += 1;
      if (state.waitForStart) await state.waitForStart;
      expect(request.postDataJSON().p_game).toBe('snake');
      if (state.legacySnake) {
        return route.fulfill({ status: 400, json: { code: 'P0001', message: 'Invalid game settings.' }, headers });
      }
      if (!state.snapshot.matches.length) state.snapshot.matches.push({
        id: 'duel-1', game: 'snake', player_x: 'test-user', player_o: 'test-partner',
        board: Array(9).fill(''), turn_id: 'test-user', best_of: 3, round: 1,
        score_x: 0, score_o: 0, my_pick: null, partner_locked: false,
        finished: false, winner_id: null, rounds: [],
        snake: { mine: null, partner: { status: 'waiting', ended: null } },
      });
      return route.fulfill({ json: 'duel-1', headers });
    }
    if (name === 'snake_start') {
      const run = {
        status: 'running', score: 0, ticks: 0, dirs: [], foods: [[3, 3], [17, 17]],
        started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
        deadline: new Date(Date.now() + 240_000).toISOString(), ended: null,
      };
      state.snapshot.matches[0].snake.mine = run;
      return route.fulfill({ json: run, headers });
    }
    if (name === 'snake_beat' || name === 'snake_finish') {
      return route.fulfill({ json: state.snapshot.matches[0].snake.mine, headers });
    }
    throw new Error(`Unexpected request: ${request.url()}`);
  });
  return state;
}

async function mockDash(page) {
  const state = { starts: 0, runs: 0, finishes: 0, reads: 0, snapshot: { wins: {}, matches: [] } };
  await page.route('https://test-project.supabase.co/**', async (route) => {
    const request = route.request();
    const name = new URL(request.url()).pathname.split('/').at(-1);
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (name === 'games_state') {
      state.reads += 1;
      return route.fulfill({ json: state.snapshot, headers });
    }
    if (name === 'start_dash') {
      const args = request.postDataJSON();
      state.starts += 1;
      state.snapshot.matches = [{
        id: 'dash-1', game: 'dash-duel', player_x: 'test-user', player_o: 'test-partner',
        turn_id: 'test-user', best_of: 3, round: 1, score_x: 0, score_o: 0,
        my_pick: null, partner_locked: false, finished: false, winner_id: null, rounds: [],
        dash: {
          course_version: 1,
          course: [{ tick: 1, kind: 'barrier', lanes: [1], jumpable: true }],
          mode: args.p_mode, level: args.p_level, created_by: 'test-user', mine: null,
          partner: { status: 'waiting', ended: null },
        },
      }];
      return route.fulfill({ json: 'dash-1', headers });
    }
    if (name === 'dash_start') {
      state.runs += 1;
      const run = {
        status: 'running', ended: null, distance: 0, hearts: 0, ticks: 0, lane: 1, jump_ticks: 0,
        actions: [], started_at: new Date().toISOString(), last_seen: new Date().toISOString(),
      };
      state.snapshot.matches[0].dash.mine = run;
      return route.fulfill({ json: run, headers });
    }
    if (name === 'dash_finish' || name === 'dash_beat') {
      const run = state.snapshot.matches[0].dash.mine;
      const args = request.postDataJSON();
      state.finishes += Number(name === 'dash_finish');
      Object.assign(run, { status: 'crash', ended: 'barrier', ticks: args.p_ticks, distance: 0, last_seen: new Date().toISOString() });
      return route.fulfill({ json: run, headers });
    }
    throw new Error(`Unexpected Dash request: ${request.url()}`);
  });
  return state;
}

test('Dash Duel runs a complete mobile crash attempt, saves the referee result and stays within the phone', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const state = await mockDash(page);
  await page.goto('/tests/browser/games.html');
  const card = page.locator('article[data-game="dash-duel"]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: /Play together/ })).toHaveCount(0);
  await card.getByRole('button', { name: 'Set a challenge →', exact: true }).click();
  await expect(page.locator('[data-dash-mode="challenge"]')).toBeVisible();
  await page.getByRole('button', { name: 'Start my run', exact: true }).click();
  await expect(page.locator('.dash-stage')).toBeVisible();
  await expect(page.locator('.dash-lane')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Move to the left lane' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Jump over a barrier' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move to the right lane' })).toBeVisible();
  await expect(page.locator('[data-dash-waiting="me"]')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-dash-waiting="me"]')).toContainText('Barrier hit');
  expect(state.starts).toBe(1);
  expect(state.runs).toBe(1);
  expect(state.finishes).toBe(1);
  expect(state.snapshot.matches[0].dash.mine.distance).toBe(0);
  const dimensions = await page.locator('.games-view').evaluate((view) => ({
    scroll: view.scrollWidth,
    client: view.clientWidth,
    board: view.querySelector('.dash-stage').getBoundingClientRect().width,
  }));
  expect(dimensions.scroll).toBe(dimensions.client);
  expect(dimensions.board).toBeLessThanOrEqual(360);
});

test('Dash Duel live choice appears only when partner presence is online', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await mockDash(page);
  await page.goto('/tests/browser/games.html?online=1');
  await expect(page.locator('article[data-game="dash-duel"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Play together · online →', exact: true })).toBeVisible();
});

for (const width of [320, 360, 390, 480, 1024]) {
  test(`Sudoku stays square and inside the phone at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await mockGames(page);
    await page.goto('/tests/browser/games.html');
    const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Sudoku', exact: true }) });
    await card.getByRole('button', { name: 'Play →', exact: true }).click();
    await page.getByRole('button', { name: 'Start puzzle', exact: true }).click();
    await expect(page.locator('[data-sudoku-cell]')).toHaveCount(81);

    const layout = await page.locator('[data-sudoku-board]').evaluate((board) => {
      const bounds = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const cells = [...board.querySelectorAll('button')];
      const view = document.querySelector('.games-view');
      return {
        board: bounds(board),
        cells: cells.map(bounds),
        padding: getComputedStyle(cells[0]).padding,
        radius: getComputedStyle(cells[0]).borderRadius,
        divider: getComputedStyle(cells[2]).borderRightWidth,
        ordinary: getComputedStyle(cells[1]).borderRightWidth,
        rowDivider: getComputedStyle(cells[18]).borderBottomWidth,
        scrollWidth: view.scrollWidth, clientWidth: view.clientWidth,
      };
    });
    expect(Math.abs(layout.board.width - layout.board.height)).toBeLessThan(1);
    expect(layout.board.width).toBeLessThanOrEqual(320);
    expect(layout.scrollWidth).toBe(layout.clientWidth);
    expect(layout.padding).toBe('0px');
    expect(layout.radius).toBe('0px');
    expect(layout.divider).toBe('2px');
    expect(layout.rowDivider).toBe('2px');
    expect(layout.ordinary).toBe('1px');
    for (const [index, cell] of layout.cells.entries()) {
      expect(Math.abs(cell.width - cell.height)).toBeLessThan(1);
      expect(cell.left).toBeGreaterThanOrEqual(layout.board.left);
      expect(cell.right).toBeLessThanOrEqual(layout.board.right);
      expect(cell.bottom).toBeLessThanOrEqual(layout.board.bottom);
      // Every row has exactly nine columns, with continuous (not gapped) rules.
      if (index % 9) expect(Math.abs(cell.left - layout.cells[index - 1].right)).toBeLessThan(1);
      if (index >= 9) expect(Math.abs(cell.top - layout.cells[index - 9].bottom)).toBeLessThan(1);
    }

    const editable = page.locator('[data-sudoku-cell][data-given="false"]').first();
    await editable.click();
    await page.getByRole('button', { name: 'Enter 1', exact: true }).click();
    await expect(editable).toHaveText('1');
    await page.getByRole('button', { name: 'Erase selected cell', exact: true }).click();
    await expect(editable).toHaveText('');
    await editable.press('2');
    await expect(editable).toHaveText('2');
    await editable.press('Backspace');
    await expect(editable).toHaveText('');
  });
}

test('Duel opens, resumes the same match, and starts a moving board', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = await mockGames(page);
  await page.goto('/tests/browser/games.html');
  // Both duels invite you the same way, so name the card: an unscoped "Duel Ana →"
  // matches the Snake and the Tetris card alike.
  const duel = page.locator('article[data-game="snake"]').getByRole('button', { name: 'Duel Ana →', exact: true });
  await duel.click();
  await expect(page.locator('[data-snake-gate]')).toBeVisible();
  expect(state.starts).toBe(1);
  await page.getByRole('button', { name: '← All games', exact: true }).click();
  await duel.click();
  await expect(page.locator('[data-snake-gate]')).toBeVisible();
  expect(state.snapshot.matches).toHaveLength(1);
  await page.getByRole('button', { name: 'Start my run', exact: true }).click();
  await expect(page.locator('.snake-board')).toBeVisible();
  await expect.poll(() => page.locator('.snake-head').evaluate((head) => parseFloat(head.style.left))).toBeGreaterThan(50);
});

test('Duel shows progress and prevents duplicate starts while its request is pending', async ({ page }) => {
  let release;
  const waitForStart = new Promise(resolve => { release = resolve; });
  const state = await mockGames(page, { waitForStart });
  try {
    await page.goto('/tests/browser/games.html');
    await page.locator('article[data-game="snake"]').getByRole('button', { name: 'Duel Ana →', exact: true }).click();
    const opening = page.locator('article[data-game="snake"]').getByRole('button', { name: 'Opening duel…', exact: true });
    await expect(opening).toBeVisible();
    await expect(opening).toBeDisabled();
    await expect(opening).toHaveAttribute('aria-busy', 'true');
    // A second tap cannot dispatch another action while the first is in flight.
    await opening.dispatchEvent('click');
    expect(state.starts).toBe(1);
    release();
    await expect(page.locator('[data-snake-gate]')).toBeVisible();
    expect(state.starts).toBe(1);
  } finally {
    release();
  }
});

test('a missing Snake migration stays visible beside Duel through polling, and retry opens it', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const state = await mockGames(page, { legacySnake: true });
  await page.goto('/tests/browser/games.html');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Snake Duel', exact: true }) });
  await card.getByRole('button', { name: 'Duel Ana →', exact: true }).click();
  await expect(card.getByRole('alert')).toContainText('202610150010_snake_duel.sql');
  const reads = state.reads;
  await expect.poll(() => state.reads).toBeGreaterThan(reads);
  await expect(card.getByRole('alert')).toBeVisible();
  expect(state.starts).toBe(1);
  state.legacySnake = false;
  await card.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.locator('[data-snake-gate]')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(state.starts).toBe(2);
});

test('local Sudoku and warm-up remain playable when shared games cannot load', async ({ page }) => {
  await mockGames(page, { offline: true });
  await page.goto('/tests/browser/games.html');
  const card = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Sudoku', exact: true }) });
  await card.getByRole('button', { name: 'Play →', exact: true }).click();
  await page.getByRole('button', { name: 'Start puzzle', exact: true }).click();
  await expect(page.locator('[data-sudoku-board]')).toBeVisible();
  await page.getByRole('button', { name: '← All games', exact: true }).click();
  await page.getByRole('button', { name: 'Warm-up run (not counted)', exact: true }).click();
  await expect(page.locator('.snake-board')).toBeVisible();
});
