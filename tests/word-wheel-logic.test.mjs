import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';

test('Word Wheel core: buildable words, blank groups, hints, tie-break and shuffle', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const wheel = await server.ssrLoadModule('/src/lib/wordWheel.ts');
    const practice = await server.ssrLoadModule('/src/lib/wordWheelPractice.ts');
    const {
      canBuildWord, normalizeWord, wordGroups, chooseHint, nextHintIndex,
      compareWordAttempts, formatWordClock, formatWordTime, shuffleLetters, isWordLevel,
      isWordDuration,
    } = wheel;

    assert.equal(normalizeWord('  PiCtUrE!! '), 'picture');
    assert.equal(canBuildWord('ceiprtu', 'picture'), true);
    assert.equal(canBuildWord('ceiprtu', 'pictures'), false, 'each wheel letter may be used only once');
    assert.equal(canBuildWord('aabbcc', 'cab'), true);
    assert.equal(canBuildWord('aabbcc', 'ccab'), true);
    assert.equal(canBuildWord('aabbcc', 'ccc'), false);
    assert.equal(isWordLevel('hard'), true);
    assert.equal(isWordLevel('spicy'), false);
    assert.equal(isWordDuration(180), true);
    assert.equal(isWordDuration(120), false);

    const practicePuzzle = practice.choosePracticePuzzle([{
      letters: 'ceiprtu', base_word: 'picture',
      packs: { easy: { '60': ['picture', 'cut', 'it'] } },
    }], 'easy', 60, () => 0);
    assert.deepEqual(practicePuzzle, { letters: 'ceiprtu', grandWord: 'picture', words: ['picture', 'cut', 'it'] });
    const practiceSession = practice.createPracticeWordSession(practicePuzzle, 'easy', 60, 1_000, () => 0);
    assert.equal(practiceSession.round.status, 'running');
    assert.equal(practiceSession.round.mine.started, true);
    assert.equal(practiceSession.round.mine.started_at, new Date(1_000).toISOString());
    assert.equal(practiceSession.round.partner.started, false);

    const groups = wordGroups(['picture', 'cut', 'it', 'up', 'tie', 'true', 'price', 'pure'], 'picture');
    assert.deepEqual(groups.map((group) => [group.length, group.grand, group.words.length]), [
      [7, true, 1],
      [2, false, 2],
      [3, false, 2],
      [4, false, 2],
      [5, false, 1],
    ]);
    assert.deepEqual(groups[0].words, ['picture'], 'the grand prize gets its own first row');
    assert.equal(groups.flatMap((group) => group.words).includes('picture'), true);

    assert.equal(nextHintIndex('picture', [0, 1, 2, 3, 4, 5, 6]), null);
    assert.equal(nextHintIndex('picture', [0, 1, 2], () => 0), 3);
    const revealed = new Map([['cut', new Set([0, 1])]]);
    const hint = chooseHint(['picture', 'cut', 'it'], ['it'], revealed, () => 0.999);
    assert.deepEqual(hint, { word: 'cut', index: 2 }, 'a hint only reveals an unfound word and an unrevealed letter');
    assert.equal(chooseHint(['it'], ['it'], new Map()), null);

    assert.equal(compareWordAttempts({ word: '', count: 6, finishedMs: 50_000 }, { word: '', count: 5, finishedMs: 10_000 }), 'mine');
    assert.equal(compareWordAttempts({ word: '', count: 5, finishedMs: 40_000 }, { word: '', count: 5, finishedMs: 30_000 }), 'partner');
    assert.equal(compareWordAttempts({ word: '', count: 5, finishedMs: 30_000 }, { word: '', count: 5, finishedMs: 30_000 }), 'draw');

    assert.equal(formatWordClock(60_000), '1:00');
    assert.equal(formatWordClock(9_001), '0:10');
    assert.equal(formatWordClock(0), '0:00');
    assert.equal(formatWordTime(42_400), '0:42');
    assert.equal(formatWordTime(null), '—');

    const shuffled = shuffleLetters('picture', () => 0);
    assert.deepEqual([...shuffled].sort(), [...'picture'].sort(), 'shuffle only reorders the same seven letters');
    assert.notDeepEqual(shuffled, 'picture'.split(''));
  } finally {
    await server.close();
  }
});
