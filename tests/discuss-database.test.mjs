import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

/**
 * A CSV-shaped library. Every row is spelled the way a real import tends to arrive —
 * mixed case, underscores, a synonym for the input type, options as objects — so the
 * normalising trigger is exercised by the same test as the privacy rules.
 *
 * These rows exist only inside this test's throwaway database. The app ships no questions.
 */
const IMPORT = `
  INSERT INTO public.questions (id, text, category, seriousness, input_type, options, is_adult) VALUES
    ('q-fun-1',   '  Beach or mountains?  ',      'fun',       1, 'choice',     '["Beach","Mountains"]', false),
    ('q-home-1',  'Rank your perfect Sunday',     'HOME_LIFE', 3, 'RANKING',    '["Sleep in","Brunch","Walk","Film"]', 'f'),
    ('q-deep-1',  'What are you most afraid of?', 'deep',      5, 'TEXT',       NULL, 'false'),
    ('q-money-1', 'How much should we save?',     'money',     4, 'scale',      NULL, false),
    ('q-chore-1', 'Tick the chores you hate',     'home life', 2, 'checkboxes', '["Dishes","Bins","Laundry"]', false),
    ('q-city-1',  'Where should we live?',        'future',    3, 'choice',     '[{"label":"Lagos"},{"text":"London"}]', false),
    ('q-adult-1', 'What do you want to try?',     'intimacy',  5, 'choice',     '["Talking","Touch","Surprise"]', false);
`;

test('discuss: an imported library, sealed answers, the reveal, the 18+ gate and per-couple RLS', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
  let backend;
  try {
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const discuss = await server.ssrLoadModule('/src/lib/discussService.ts');
    const format = await server.ssrLoadModule('/src/lib/questionFormat.ts');

    // --- 1. The owner imports the CSV; the database canonicalises it on the way in -----
    await backend.exec(IMPORT);
    const imported = await backend.query('SELECT * FROM public.questions ORDER BY id');
    const byId = Object.fromEntries(imported.rows.map((row) => [row.id, row]));
    assert.equal(imported.rows.length, 7, 'every imported row landed');
    assert.equal(byId['q-fun-1'].text, 'Beach or mountains?', 'question text is trimmed');
    assert.equal(byId['q-fun-1'].category, 'Fun', 'fun is the Fun category');
    assert.equal(byId['q-home-1'].category, 'Home Life', 'HOME_LIFE is the Home Life category');
    assert.equal(byId['q-home-1'].input_type, 'ranking', 'RANKING is lower-cased');
    assert.equal(byId['q-money-1'].input_type, 'slider', '"scale" is the 1-10 slider');
    assert.equal(byId['q-money-1'].options, null, 'a slider keeps no options');
    assert.equal(byId['q-chore-1'].input_type, 'multi_choice', '"checkboxes" means tick several');
    assert.deepEqual(byId['q-city-1'].options, ['Lagos', 'London'], 'option objects give up their labels');
    assert.equal(byId['q-adult-1'].category, 'Intimacy');
    assert.equal(byId['q-adult-1'].is_adult, true, 'Intimacy is 18+ whatever the CSV said');
    assert.equal(byId['q-fun-1'].is_adult, false);

    // A question that cannot be rendered is refused at the door rather than hidden later.
    await assert.rejects(
      backend.exec(`INSERT INTO public.questions (id, text, category, input_type)
                    VALUES ('q-bad-1', 'Pick one', 'fun', 'choice')`),
      /needs its options/,
      'a choice question without options cannot be imported',
    );
    await assert.rejects(
      backend.exec(`INSERT INTO public.questions (id, text, category) VALUES ('q-bad-2', '   ', 'fun')`),
      /needs its text/,
      'a blank question cannot be imported',
    );
    await backend.exec(`INSERT INTO public.questions (text, category, seriousness, input_type)
                        VALUES ('No id in the CSV', 'silly', 99, 'nonsense')`);
    const repaired = (await backend.query(
      `SELECT id, seriousness, input_type, category FROM public.questions WHERE text = 'No id in the CSV'`,
    )).rows[0];
    assert.match(repaired.id, /^[\w-]{8,}/, 'a missing id is generated');
    assert.equal(repaired.seriousness, 5, 'an impossible seriousness is clamped into 1-5');
    assert.equal(repaired.input_type, 'text', 'an unknown input type falls back to free typing');
    assert.equal(repaired.category, 'Silly');
    await backend.exec(`DELETE FROM public.questions WHERE text = 'No id in the CSV'`);

    // --- 2. The app and the database speak the same vocabulary ------------------------
    // Both sides canonicalise, so a project whose rows predate the migration still renders.
    for (const [alias, expected] of Object.entries(format.INPUT_TYPE_ALIASES)) {
      const result = await backend.query('SELECT public.canonical_question_input_type($1) AS canonical', [alias]);
      assert.equal(result.rows[0].canonical, expected, `input_type "${alias}" must agree on both sides`);
    }
    for (const [alias, expected] of Object.entries(format.CATEGORY_ALIASES)) {
      const result = await backend.query('SELECT public.canonical_question_category($1) AS canonical', [alias]);
      assert.equal(result.rows[0].canonical, expected, `category "${alias}" must agree on both sides`);
    }
    for (const alias of ['yesno', 'photo', '']) {
      const result = await backend.query('SELECT public.canonical_question_input_type($1) AS canonical', [alias]);
      assert.equal(result.rows[0].canonical, format.canonicalInputType(alias), `unknown input type "${alias}"`);
      assert.equal(format.canonicalInputType(alias), 'text');
    }
    assert.equal(
      (await backend.query(`SELECT public.canonical_question_category('Travel') AS canonical`)).rows[0].canonical,
      format.canonicalCategory('Travel'),
      'a category of the CSV author\'s own survives on both sides',
    );
    assert.equal(format.canonicalCategory('Travel'), 'Travel');

    for (const shape of ['["A","B"]', '"[\\"A\\",\\"B\\"]"', '"Beach | City"', '"Beach, City"', '[{"label":"A"},{"text":"B"}]', 'null']) {
      const sql = await backend.query('SELECT public.canonical_question_options($1::jsonb) AS canonical', [shape]);
      const parsed = shape === 'null' ? null : JSON.parse(shape);
      assert.deepEqual(
        format.normalizeQuestionOptions(parsed),
        sql.rows[0].canonical,
        `options shape ${shape} must normalise the same way on both sides`,
      );
    }

    // --- 3. Two couples, one shared library ------------------------------------------
    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Europe/London' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);

    const carol = (await auth.signUpWithEmail('carol@example.com', 'password')).user;
    await auth.saveOnboardingProfile(carol.id, { name: 'Carol', location: null, timezone: 'UTC' });
    const dave = (await auth.signUpWithEmail('dave@example.com', 'password')).user;
    await auth.saveOnboardingProfile(dave.id, { name: 'Dave', location: null, timezone: 'UTC' });
    const { couple: otherCouple } = await auth.createCouple(dave.id, '2021-01-01');
    await auth.signInWithEmail('carol@example.com', 'password');
    await auth.joinCoupleWithCode(carol.id, otherCouple.invite_code);

    const erin = (await auth.signUpWithEmail('erin@example.com', 'password')).user;
    await auth.saveOnboardingProfile(erin.id, { name: 'Erin', location: null, timezone: 'UTC' });

    // --- 4. Browsing: the library is shared, the history is not ----------------------
    await auth.signInWithEmail('alice@example.com', 'password');
    const categories = await discuss.fetchQuestionCategories();
    assert.deepEqual(
      categories.map((entry) => entry.category),
      ['Deep', 'Fun', 'Future', 'Home Life', 'Money'],
      'the browse screen sees every category except the 18+ one',
    );
    const homeLife = categories.find((entry) => entry.category === 'Home Life');
    assert.equal(homeLife.total, 2);
    assert.equal(homeLife.remaining, 2);
    assert.deepEqual(homeLife.byLevel, { 2: 1, 3: 1 }, 'the levels say what is actually there');

    const picked = await discuss.pickQuestion('Fun', 1);
    assert.equal(picked.question.id, 'q-fun-1');
    assert.equal(picked.question.text, 'Beach or mountains?');
    assert.equal(picked.question.input_type, 'choice');
    assert.deepEqual(picked.question.options, ['Beach', 'Mountains']);
    assert.equal(picked.remaining, 1);
    assert.equal((await discuss.pickQuestion('Fun', 4)).question, null, 'nothing at that level, and it says so');
    assert.equal((await discuss.pickQuestion('Intimacy', 5)).question, null, 'an 18+ category nobody opened');

    const surprise = await discuss.pickQuestion(null, null);
    assert.ok(surprise.question, 'Surprise me finds something');
    assert.equal(surprise.question.is_adult, false);

    // --- 5. "Ask my partner" makes one session, and twice does not make two ----------
    const { sessionId } = await discuss.askPartner('q-fun-1');
    const second = await discuss.askPartner('q-fun-1');
    assert.equal(second.sessionId, sessionId, 'a double tap reuses the session it already made');
    await assert.rejects(discuss.askPartner('q-adult-1'), /turn them on in settings/);
    await assert.rejects(discuss.askPartner('q-not-there'), /not in your library/);

    // --- 6. Alice answers, and her answer is hers alone ------------------------------
    await discuss.submitAnswer(sessionId, alice.id, 'Beach');
    let sessions = await discuss.fetchSessions(couple.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].answer_count, 1);
    assert.equal(sessions[0].completed_at, null, 'one answer does not reveal anything');
    const aliceSees = await discuss.fetchAnswers([sessionId]);
    assert.equal(aliceSees.length, 1);
    assert.equal(aliceSees[0].answer, 'Beach');
    assert.equal(aliceSees[0].user_id, alice.id);

    // --- 7. Bob cannot read it, because the database never sends it -------------------
    await auth.signInWithEmail('bob@example.com', 'password');
    assert.deepEqual(await discuss.fetchAnswers([sessionId]), [], "the partner's answer is sealed");
    await backend.resetRole();
    const stored = await backend.query('SELECT count(*)::int AS count FROM public.answers');
    assert.equal(stored.rows[0].count, 1, 'the row exists: row-level security is what hides it');
    await auth.signInWithEmail('bob@example.com', 'password');
    const bobSession = (await discuss.fetchSessions(couple.id))[0];
    assert.equal(bobSession.answer_count, 1, 'he can see that somebody answered');
    assert.equal(bobSession.completed_at, null, 'but not what they said');

    // Bob answers: the session reveals, and both answers become readable to both phones.
    await discuss.submitAnswer(sessionId, bob.id, 'Mountains');
    const revealedToBob = await discuss.fetchAnswers([sessionId]);
    assert.equal(revealedToBob.length, 2, 'the reveal opens both answers at once');
    const afterReveal = (await discuss.fetchSessions(couple.id))[0];
    assert.equal(afterReveal.answer_count, 2);
    assert.ok(afterReveal.completed_at, 'the session records the moment it revealed');

    await auth.signInWithEmail('alice@example.com', 'password');
    const revealedToAlice = await discuss.fetchAnswers([sessionId]);
    assert.equal(revealedToAlice.length, 2);
    assert.deepEqual(
      revealedToAlice.map((row) => row.answer).sort(),
      ['Beach', 'Mountains'],
    );

    // Locked for good: neither partner can rewrite a revealed answer.
    const aliceAnswer = revealedToAlice.find((row) => row.user_id === alice.id);
    await assert.rejects(discuss.reviseAnswer(aliceAnswer.id, 'City'), /locked now that you have both replied/);
    await assert.rejects(discuss.submitAnswer(sessionId, alice.id, 'City'), /both answered this one already/);

    // --- 8. Every input type is checked against its question -------------------------
    const ranking = await discuss.askPartner('q-home-1');
    await assert.rejects(discuss.submitAnswer(ranking.sessionId, alice.id, ['Walk', 'Film']), /every option in an order/);
    await assert.rejects(
      discuss.submitAnswer(ranking.sessionId, alice.id, ['Walk', 'Film', 'Brunch', 'Picnic']),
      /not one of the options/,
    );
    await assert.rejects(
      discuss.submitAnswer(ranking.sessionId, alice.id, ['Walk', 'Walk', 'Brunch', 'Film']),
      /same option twice/,
    );
    await discuss.submitAnswer(ranking.sessionId, alice.id, ['Film', 'Walk', 'Brunch', 'Sleep in']);

    const slider = await discuss.askPartner('q-money-1');
    await assert.rejects(discuss.submitAnswer(slider.sessionId, alice.id, 11), /between 1 and 10/);
    await assert.rejects(discuss.submitAnswer(slider.sessionId, alice.id, 0), /between 1 and 10/);
    await assert.rejects(discuss.submitAnswer(slider.sessionId, alice.id, 'seven'), /expects a number/);
    await discuss.submitAnswer(slider.sessionId, alice.id, 8);

    const ticks = await discuss.askPartner('q-chore-1');
    await assert.rejects(discuss.submitAnswer(ticks.sessionId, alice.id, []), /at least one option/);
    await assert.rejects(discuss.submitAnswer(ticks.sessionId, alice.id, ['Swimming']), /not one of the options/);
    await discuss.submitAnswer(ticks.sessionId, alice.id, ['Dishes', 'Bins']);

    const written = await discuss.askPartner('q-deep-1');
    await assert.rejects(discuss.submitAnswer(written.sessionId, alice.id, '   '), /write your answer first/);
    await discuss.submitAnswer(written.sessionId, alice.id, 'Being forgotten.');

    // Before the reveal the writer can still change their mind.
    const revised = await discuss.reviseAnswer(
      (await discuss.fetchAnswers([ticks.sessionId]))[0].id,
      ['Bins', 'Laundry'],
    );
    assert.deepEqual(revised.answer, ['Bins', 'Laundry'], 'an unrevealed answer is editable');

    // --- 9. One comment each, and it waits for the reveal -----------------------------
    await assert.rejects(discuss.saveComment(written.sessionId, alice.id, 'Too soon.'), /until you have both answered/);
    await assert.rejects(discuss.saveComment(sessionId, alice.id, '   '), /Say something about it first/);
    await assert.rejects(discuss.saveComment(sessionId, alice.id, `x${'y'.repeat(1000)}`), /1000 characters/);
    const firstComment = await discuss.saveComment(sessionId, alice.id, 'Obviously the beach.');
    assert.equal(firstComment.comment, 'Obviously the beach.');
    const changedComment = await discuss.saveComment(sessionId, alice.id, 'Obviously the beach, every time.');
    assert.equal(changedComment.id, firstComment.id, 'one comment per partner, changed in place');
    assert.equal((await discuss.fetchComments([sessionId])).length, 1);
    assert.equal((await discuss.fetchComments([sessionId]))[0].comment, 'Obviously the beach, every time.');

    // The friendly refusal is the database's own, not just the client's.
    const blank = await supabase.from('answer_comments').insert({ session_id: sessionId, user_id: alice.id, comment: '   ' });
    assert.match(blank.error?.message ?? '', /Say something about it first/, 'the database itself refuses an empty comment');

    await auth.signInWithEmail('bob@example.com', 'password');
    assert.deepEqual(await discuss.fetchComments([written.sessionId]), [], 'a sealed session shows no comments');
    assert.equal((await discuss.fetchComments([sessionId])).length, 1, 'a revealed one does');
    await discuss.saveComment(sessionId, bob.id, 'Mountains every time.');
    assert.equal((await discuss.fetchComments([sessionId])).length, 2, 'one each, not one between them');

    // --- 10. The 18+ category needs both partners, and closes when either opts out ---
    await auth.signInWithEmail('alice@example.com', 'password');
    const hasIntimacy = () => discuss.fetchQuestionCategories()
      .then((rows) => rows.some((entry) => entry.category === 'Intimacy'));
    assert.equal(await hasIntimacy(), false);
    await discuss.saveAdultPreference(couple.id, alice.id, true);
    assert.equal(await hasIntimacy(), false, 'one partner agreeing is not enough');
    await assert.rejects(discuss.askPartner('q-adult-1'), /turn them on in settings/);
    assert.deepEqual(await discuss.fetchQuestionsByIds(['q-adult-1']), [], 'and the row itself is not readable');

    await auth.signInWithEmail('bob@example.com', 'password');
    await discuss.saveAdultPreference(couple.id, bob.id, true);
    assert.equal(await hasIntimacy(), true, 'both partners agreeing opens it');
    const intimacy = (await discuss.fetchQuestionCategories()).find((entry) => entry.category === 'Intimacy');
    assert.equal(intimacy.adult, true);
    assert.equal(intimacy.remaining, 1);
    assert.equal((await discuss.pickQuestion('Intimacy', 5)).question.id, 'q-adult-1');
    assert.equal((await discuss.fetchQuestionsByIds(['q-adult-1']))[0].text, 'What do you want to try?');
    const adultSession = await discuss.askPartner('q-adult-1');

    // Either partner turning it off hides the category again, for both phones.
    await discuss.saveAdultPreference(couple.id, bob.id, false);
    assert.equal(await hasIntimacy(), false, 'opting out closes it again at once');
    assert.deepEqual(await discuss.fetchQuestionsByIds(['q-adult-1']), [], 'the questions go back to being invisible');
    await assert.rejects(
      discuss.submitAnswer(adultSession.sessionId, bob.id, 'Talking'),
      /hidden until you both turn them on/,
    );
    await auth.signInWithEmail('alice@example.com', 'password');
    assert.equal(await hasIntimacy(), false, 'and it is closed on the other phone too');

    // --- 11. Another couple shares the library but never the answers -----------------
    await auth.signInWithEmail('carol@example.com', 'password');
    assert.deepEqual(await discuss.fetchSessions(couple.id), [], "another couple reads no sessions");
    assert.deepEqual(await discuss.fetchAnswers([sessionId]), [], 'and no answers');
    assert.deepEqual(await discuss.fetchComments([sessionId]), [], 'and no comments');
    await assert.rejects(discuss.submitAnswer(sessionId, carol.id, 'Butting in'), /own couple|row-level security/i);
    await assert.rejects(discuss.saveComment(sessionId, carol.id, 'Butting in'), /own couple|row-level security/i);
    const carolAsk = await discuss.askPartner('q-fun-1');
    assert.notEqual(carolAsk.sessionId, sessionId, 'the same question gives the other couple its own session');
    assert.deepEqual(await discuss.fetchSessions(couple.id), [], "and Alice's history is still hers alone");
    assert.equal((await discuss.fetchSessions(otherCouple.id)).length, 1);
    assert.equal((await discuss.fetchQuestionCategories()).length, 5, 'the library is the same for everyone');

    // An unpaired account cannot play at all.
    await auth.signInWithEmail('erin@example.com', 'password');
    assert.deepEqual(await discuss.fetchQuestionCategories(), [], 'an unpaired account sees no categories');
    await assert.rejects(discuss.pickQuestion(null, null), /Pair with your partner/);
    await assert.rejects(discuss.askPartner('q-fun-1'), /Pair with your partner/);
    assert.deepEqual(await discuss.fetchSessions(couple.id), []);

    // --- 12. Ending the couple takes its sessions with it, not the library -----------
    await backend.resetRole();
    const counts = `SELECT
      (SELECT count(*) FROM public.question_sessions)::int AS sessions,
      (SELECT count(*) FROM public.answers)::int AS answers,
      (SELECT count(*) FROM public.answer_comments)::int AS comments,
      (SELECT count(*) FROM public.couple_settings)::int AS settings,
      (SELECT count(*) FROM public.questions)::int AS questions`;
    const mineBefore = await backend.query(
      `SELECT
        (SELECT count(*) FROM public.question_sessions WHERE couple_id = $1)::int AS sessions,
        (SELECT count(*) FROM public.answers WHERE session_id IN
          (SELECT id FROM public.question_sessions WHERE couple_id = $1))::int AS answers,
        (SELECT count(*) FROM public.answer_comments WHERE session_id IN
          (SELECT id FROM public.question_sessions WHERE couple_id = $1))::int AS comments,
        (SELECT count(*) FROM public.couple_settings WHERE couple_id = $1)::int AS settings`,
      [couple.id],
    );
    const before = (await backend.query(counts)).rows[0];
    assert.ok(mineBefore.rows[0].sessions >= 6, 'Alice and Bob have a history to lose');

    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.requestOrConfirmBreakup();
    await auth.signInWithEmail('bob@example.com', 'password');
    assert.equal((await auth.requestOrConfirmBreakup()).status, 'ended');

    await backend.resetRole();
    const after = (await backend.query(counts)).rows[0];
    assert.equal(after.sessions, before.sessions - mineBefore.rows[0].sessions, 'their sessions are gone');
    assert.equal(after.answers, before.answers - mineBefore.rows[0].answers, 'and so are their answers');
    assert.equal(after.comments, before.comments - mineBefore.rows[0].comments, 'and their comments');
    assert.equal(after.settings, before.settings - mineBefore.rows[0].settings, 'and their 18+ consent');
    assert.equal(after.questions, before.questions, 'the shared library outlives every couple');
    assert.ok(after.sessions >= 1, "the other couple's history is untouched");

    // --- 13. Safe to rerun, and the preflight notices a half-applied migration -------
    const migration = await readFile(new URL('../supabase/migrations/202610150004_discuss_questions.sql', import.meta.url), 'utf8');
    const commentsMigration = await readFile(new URL('../supabase/migrations/202610150005_discuss_comments_chat_links.sql', import.meta.url), 'utf8');
    const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');
    await backend.exec(verification);
    await backend.exec(migration);
    await backend.exec(commentsMigration);
    await backend.exec(commentsMigration);
    await backend.exec(verification);
    await backend.rollback();

    await auth.signInWithEmail('carol@example.com', 'password');
    assert.equal((await discuss.fetchSessions(otherCouple.id)).length, 1, 'rerunning keeps the history');
    assert.equal((await discuss.fetchQuestionCategories()).length, 5, 'and the library');

    // Without the progress trigger nothing would ever reveal: the preflight says so.
    await backend.exec('DROP TRIGGER answers_sync_session_progress ON public.answers');
    await assert.rejects(backend.exec(verification), /never reveal/);
    await backend.rollback();
    await backend.exec(migration);
    await backend.exec(verification);

    // Without the normalising trigger a fresh import would not be canonical.
    await backend.exec('DROP TRIGGER questions_normalize_row ON public.questions');
    await assert.rejects(backend.exec(verification), /canonicalised/);
    await backend.rollback();
    await backend.exec(migration);
    await backend.exec(verification);

    // Without the comment guard an empty comment could be stored; the preflight says so.
    await backend.exec('DROP TRIGGER answer_comments_guard ON public.answer_comments');
    await assert.rejects(backend.exec(verification), /answer_comments guard/);
    await backend.rollback();
    await backend.exec(commentsMigration);
    await backend.exec(verification);

    // A library the app could write to is a bug, not a feature.
    await backend.exec('GRANT INSERT ON public.questions TO authenticated');
    await assert.rejects(backend.exec(verification), /must not be able to write to questions/);
    await backend.rollback();
    await backend.exec('REVOKE INSERT ON public.questions FROM authenticated');
    await backend.exec(verification);
  } finally {
    await server.close();
    await supabase.auth.dispose();
    await backend?.close();
  }
});
