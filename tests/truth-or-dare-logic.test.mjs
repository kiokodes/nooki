import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Truth or Dare age gates, intensity steps and alternating turns', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const logic = await server.ssrLoadModule('/src/lib/truthOrDare.ts');
    const none = { tier: 0, source: 'missing' };
    const adult18 = { tier: 18, source: 'confirmation' };
    const adult20 = { tier: 20, source: 'date_of_birth' };

    assert.equal(logic.bothPartnersMeetAgeRule('random', none, none), true, 'Random has no adult-theme gate');
    assert.equal(logic.bothPartnersMeetAgeRule('flirty', adult18, adult18), true);
    assert.equal(logic.bothPartnersMeetAgeRule('flirty', adult18, none), false, 'both partners must qualify');
    assert.equal(logic.bothPartnersMeetAgeRule('spicy', adult20, adult18), false, 'Spicy needs both to be 20+');
    assert.equal(logic.bothPartnersMeetAgeRule('spicy', adult20, adult20), true);

    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 100].map(logic.intensityForCompletedCount), [1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
    const round = {
      id: 'round', couple_id: 'couple', theme: 'random', created_by: 'a',
      player_one: 'a', player_two: 'b', turn_id: 'a', status: 'active', accepted_by: ['a', 'b'],
      current_prompt: null, completed_count: 0, created_at: '', updated_at: '',
    };
    assert.equal(logic.isTodTurn(round, 'a'), true);
    assert.equal(logic.isTodTurn(round, 'b'), false);
    assert.equal(logic.hasAcceptedRound(round, 'b'), true);
    assert.equal(logic.otherTodPlayer(round, 'a'), 'b');
    assert.equal(logic.otherTodPlayer(round, 'stranger'), null);
    assert.equal(logic.isTodTurn({ ...round, status: 'paused' }, 'a'), false, 'a paused room has no active turn');
  } finally {
    await server.close();
  }
});
