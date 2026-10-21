import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { installTestBackend } from './helpers/testBackend.mjs';

// Letters wait for days, so pin the process timezone to keep "today" deterministic.
process.env.TZ = 'UTC';

/** One row of `epistles`, as the app reads it. */
const letter = (overrides = {}) => ({
  id: 'letter',
  couple_id: 'c1',
  sender_id: 'alice',
  title: null,
  body: 'My dearest Bob,\n\nThe distance is only geography.\n\nAll my love.',
  sealed_at: '2026-10-19T09:00:00.000Z',
  opens_at: null,
  opened_at: null,
  reply_to_id: null,
  created_at: '2026-10-19T09:00:00.000Z',
  updated_at: '2026-10-19T09:00:00.000Z',
  ...overrides,
});

test('epistles: the states of an envelope, and the words that go with them', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const epistle = await server.ssrLoadModule('/src/lib/epistle.ts');

    // A draft is whatever has not been sealed yet, whoever wrote it.
    assert.equal(epistle.epistleState(letter({ sealed_at: null }), '2026-10-20'), 'draft');
    // Sealed, no open day: ready the moment it exists.
    assert.equal(epistle.epistleState(letter(), '2026-10-20'), 'sealed-unopened');
    // Sealed for a day that has not come: waiting, visibly, on the partner's shelf.
    assert.equal(epistle.epistleState(letter({ opens_at: '2026-12-25' }), '2026-10-20'), 'sealed-waiting');
    // The waiting is over on the day itself, never a day after.
    assert.equal(epistle.epistleState(letter({ opens_at: '2026-12-25' }), '2026-12-25'), 'sealed-unopened');
    // Once the wax is broken the letter is final, whatever day it was for.
    assert.equal(epistle.epistleState(letter({ opens_at: '2026-12-25', opened_at: '2026-12-25T10:00:00.000Z' }), '2026-10-20'), 'opened');

    // Openability is the day's own question: today counts, yesterday counts, tomorrow does not.
    assert.equal(epistle.isEpistleOpenable(letter({ opens_at: null }), '2026-10-20'), true);
    assert.equal(epistle.isEpistleOpenable(letter({ opens_at: '2026-10-20' }), '2026-10-20'), true);
    assert.equal(epistle.isEpistleOpenable(letter({ opens_at: '2026-10-19' }), '2026-10-20'), true);
    assert.equal(epistle.isEpistleOpenable(letter({ opens_at: '2026-10-21' }), '2026-10-20'), false);
    assert.equal(epistle.isEpistleOpenable(letter({ sealed_at: null }), '2026-10-20'), false, 'a draft is never openable');

    // The countdown never goes negative: a letter whose day passed while nobody was
    // looking is simply ready.
    assert.equal(epistle.daysUntilOpen('2026-10-25', '2026-10-20'), 5);
    assert.equal(epistle.daysUntilOpen('2026-10-20', '2026-10-20'), 0);
    assert.equal(epistle.daysUntilOpen('2026-10-15', '2026-10-20'), 0);

    // The envelope's words: today, tomorrow, a handful of days, then the date itself.
    assert.equal(epistle.formatOpensIn('2026-10-20', '2026-10-20'), 'Opens today');
    assert.equal(epistle.formatOpensIn('2026-10-21', '2026-10-20'), 'Opens tomorrow');
    assert.equal(epistle.formatOpensIn('2026-10-24', '2026-10-20'), 'Opens in 4 days');
    // A week or more away is the full date, said however this phone says dates.
    assert.match(epistle.formatOpensIn('2026-12-25', '2026-10-20'), /^Opens (?:25 December|December 25),? 2026$/);

    // The wax carries the writer's initial, the way a signet does.
    assert.equal(epistle.waxInitial('Ana'), 'A');
    assert.equal(epistle.waxInitial('  bode '), 'B');
    assert.equal(epistle.waxInitial(''), '♥');

    // A letter is cut for the reading on blank lines; single line breaks are only wrap.
    assert.deepEqual(
      epistle.letterParagraphs('Dear you,\n\nFirst paragraph here.\nAnd a wrapped line.\n\nLast one.'),
      ['Dear you,', 'First paragraph here.\nAnd a wrapped line.', 'Last one.'],
    );
    assert.deepEqual(epistle.letterParagraphs('\n\n   \n'), []);

    // The honest counter on the writing desk.
    assert.equal(epistle.countWords(''), 0);
    assert.equal(epistle.countWords('   '), 0);
    assert.equal(epistle.countWords('Word'), 1);
    assert.equal(epistle.countWords('One word'), 2);
    assert.equal(epistle.countWords('Two  words,\n\tthree words.'), 4);

    // The dateline, the way real letters carry one (the day is this phone's own wording).
    const day = new Date('2026-10-20T12:00:00').toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
    assert.equal(epistle.formatDateline('Lagos, Nigeria', '2026-10-20'), `Lagos, Nigeria · ${day}`);
    assert.equal(epistle.formatDateline(null, '2026-10-20'), day);
    assert.equal(epistle.formatDateline('   ', '2026-10-20'), day);

    // A draft is trimmed to what the database will accept, or refused outright.
    assert.deepEqual(
      epistle.cleanEpistleDraft('  Our first winter  ', '  The rain finally came.  '),
      { title: 'Our first winter', body: 'The rain finally came.' },
    );
    assert.deepEqual(epistle.cleanEpistleDraft('   ', '  Words.  '), { title: null, body: 'Words.' });
    assert.equal(epistle.cleanEpistleDraft('Anything', '   '), null);
    assert.equal(epistle.cleanEpistleDraft('T', 'x'.repeat(20_001)).body.length, 20_000, 'the body is clipped, not refused');
  } finally {
    await server.close();
  }
});

test('epistles: the mailbox shelves, newest first, drafts private to their author', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const epistle = await server.ssrLoadModule('/src/lib/epistle.ts');

    const rows = [
      letter({ id: 'old-keepsake', sender_id: 'bob', opened_at: '2026-03-01T10:00:00.000Z', created_at: '2026-02-20T10:00:00.000Z' }),
      letter({ id: 'theirs-ready', sender_id: 'bob', created_at: '2026-10-19T09:00:00.000Z' }),
      letter({ id: 'theirs-waiting', sender_id: 'bob', opens_at: '2026-12-25', created_at: '2026-10-18T09:00:00.000Z' }),
      letter({ id: 'mine-standing', sender_id: 'alice', created_at: '2026-10-17T09:00:00.000Z' }),
      letter({ id: 'my-draft', sender_id: 'alice', sealed_at: null, created_at: '2026-10-19T20:00:00.000Z' }),
    ];

    const shelf = epistle.sectionEpistles(rows, 'alice', '2026-10-20');
    assert.deepEqual(shelf.unopened.map((row) => row.id), ['theirs-ready'], "the partner's openable letters are the mailbox's number");
    assert.deepEqual(shelf.waiting.map((row) => row.id), ['theirs-waiting']);
    assert.deepEqual(shelf.mine.map((row) => row.id), ['mine-standing']);
    assert.deepEqual(shelf.keepsakes.map((row) => row.id), ['old-keepsake']);
    assert.deepEqual(shelf.drafts.map((row) => row.id), ['my-draft']);

    // The same shelf from the other side of the couple: the drafts are Alice's
    // alone, and Bob's own standing letter is his to take back.
    const fromBob = epistle.sectionEpistles(rows, 'bob', '2026-10-20');
    assert.deepEqual(fromBob.mine.map((row) => row.id), ['theirs-ready', 'theirs-waiting'], 'newest first, even across shelves');
    assert.deepEqual(fromBob.unopened.map((row) => row.id), ['mine-standing']);
    assert.equal(fromBob.drafts.length, 0, 'a partner can never see the other one drafting');

    // The keepsakes split into the two directions the mailbox tabs show.
    const split = epistle.splitKeepsakes([
      letter({ id: 'kept-mine', sender_id: 'alice', opened_at: '2026-10-18T10:00:00.000Z' }),
      letter({ id: 'kept-theirs', sender_id: 'bob', opened_at: '2026-10-18T10:00:00.000Z' }),
    ], 'alice');
    assert.deepEqual(split.sent.map((row) => row.id), ['kept-mine']);
    assert.deepEqual(split.received.map((row) => row.id), ['kept-theirs']);

    // Newest first means the letter that began later stands above it.
    const newestFirst = epistle.sortEpistlesNewestFirst([
      letter({ id: 'a', created_at: '2026-01-01T00:00:00.000Z' }),
      letter({ id: 'b', created_at: '2026-06-01T00:00:00.000Z' }),
      letter({ id: 'c', created_at: '2026-03-01T00:00:00.000Z' }),
    ]);
    assert.deepEqual(newestFirst.map((row) => row.id), ['b', 'c', 'a']);

    // Every envelope says what it is out loud.
    const sealed = letter({ sender_id: 'bob', title: 'The long way home' });
    assert.equal(
      epistle.epistleAriaLabel(sealed, 'Bob', 'sealed-unopened'),
      'Sealed letter from Bob, “The long way home” — tap to break the seal',
    );
    assert.equal(
      epistle.epistleAriaLabel(letter({ sender_id: 'bob' }), 'Bob', 'sealed-waiting'),
      'A letter from Bob — sealed until its day',
    );
    assert.equal(
      epistle.epistleAriaLabel(letter({ sender_id: 'alice', sealed_at: null }), 'Alice', 'draft'),
      'Draft letter — continue writing',
    );
    assert.equal(
      epistle.epistleAriaLabel(letter({ sender_id: 'bob' }), 'Bob', 'opened'),
      'Letter from Bob — read again',
    );
  } finally {
    await server.close();
  }
});

test('epistles: a correspondence — replies, chains, and who may read what', async () => {
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    const epistle = await server.ssrLoadModule('/src/lib/epistle.ts');

    // A reply starts life named after the answered letter, prefixed exactly once.
    assert.equal(epistle.replySubject('The long way home'), 'Re: The long way home');
    assert.equal(epistle.replySubject('Re: The long way home'), 'Re: The long way home');
    assert.equal(epistle.replySubject('re: already'), 're: already');
    assert.equal(epistle.replySubject(null), '');
    assert.equal(epistle.replySubject('   '), '');

    // Three letters, each answering the one before: a long chain of correspondence.
    const first = letter({ id: 'first', sender_id: 'alice', created_at: '2026-10-15T09:00:00.000Z' });
    const second = letter({ id: 'second', sender_id: 'bob', reply_to_id: 'first', created_at: '2026-10-16T09:00:00.000Z' });
    const third = letter({ id: 'third', sender_id: 'alice', reply_to_id: 'second', created_at: '2026-10-17T09:00:00.000Z' });
    const rows = [first, second, third];
    const byId = new Map(rows.map((row) => [row.id, row]));

    assert.equal(epistle.replyParent(third, byId)?.id, 'second');
    assert.equal(epistle.replyParent(first, byId), null, 'the first letter answers nothing');
    assert.equal(epistle.replyParent(letter({ reply_to_id: 'missing' }), byId), null, 'a gone letter answers nothing either');

    // Behind the third letter stand the second, then the first — oldest first, the
    // way a correspondence is reread.
    assert.deepEqual(epistle.replyAncestors(third, byId).map((row) => row.id), ['first', 'second']);
    assert.deepEqual(epistle.replyAncestors(first, byId), []);
    // Beneath the first stand both answers, newest first — the latest word first.
    assert.deepEqual(epistle.replyDescendants('first', rows).map((row) => row.id), ['third', 'second']);
    assert.deepEqual(epistle.replyDescendants('third', rows), []);
    // From anywhere in the chain, the whole correspondence counts three.
    assert.equal(epistle.threadSize(first, rows, byId), 3);
    assert.equal(epistle.threadSize(second, rows, byId), 3);
    assert.equal(epistle.threadSize(third, rows), 3, 'the lookup builds itself when it must');
    assert.equal(epistle.threadSize(letter({ id: 'alone' }), [letter({ id: 'alone' })]), 1);

    // Readability: one's own letters always, the partner's only once opened.
    assert.equal(epistle.isEpistleReadable(letter({ sender_id: 'alice', sealed_at: null }), 'alice'), true, 'my draft is mine to read');
    assert.equal(epistle.isEpistleReadable(letter({ sender_id: 'alice' }), 'alice'), true, 'my sealed letter is mine to read');
    assert.equal(epistle.isEpistleReadable(letter({ sender_id: 'bob' }), 'alice'), false, 'an unopened letter waits for its ceremony');
    assert.equal(epistle.isEpistleReadable(letter({ sender_id: 'bob', opened_at: '2026-10-19T10:00:00.000Z' }), 'alice'), true);

    // Banners and thread lists show the first line or two, never the whole letter.
    assert.equal(epistle.letterExcerpt('My dearest Alice,\n\nThe distance is only geography.'), 'My dearest Alice,');
    assert.equal(epistle.letterExcerpt('One wrapped\nline here.'), 'One wrapped line here.');
    assert.equal(epistle.letterExcerpt('   '), '');
    assert.equal(epistle.letterExcerpt('A very long first line that runs on well past the limit', 20).endsWith('…'), true);
  } finally {
    await server.close();
  }
});

test('epistles: the database keeps the promises the interface makes', async () => {
  const server = await createServer({
    server: { middlewareMode: true, hmr: false, ws: false },
    define: {
      'import.meta.env.VITE_SUPABASE_URL': JSON.stringify('https://test-project.supabase.co'),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify('sb_publishable_test_only'),
    },
  });
  let backend;
  try {
    const { supabase } = await server.ssrLoadModule('/src/lib/supabaseClient.ts');
    backend = await installTestBackend(supabase);
    const auth = await server.ssrLoadModule('/src/lib/authService.ts');
    const epistleService = await server.ssrLoadModule('/src/lib/epistleService.ts');

    // The migrations run on the live schema and are safe to rerun.
    const migration = await readFile(
      new URL('../supabase/migrations/202610200001_epistles.sql', import.meta.url),
      'utf8',
    );
    const repliesMigration = await readFile(
      new URL('../supabase/migrations/202610210001_epistle_replies.sql', import.meta.url),
      'utf8',
    );
    await backend.exec(migration);
    await backend.exec(repliesMigration);

    const alice = (await auth.signUpWithEmail('alice@example.com', 'password')).user;
    await auth.saveOnboardingProfile(alice.id, { name: 'Alice', location: null, timezone: 'Africa/Lagos' });
    const bob = (await auth.signUpWithEmail('bob@example.com', 'password')).user;
    await auth.saveOnboardingProfile(bob.id, { name: 'Bob', location: null, timezone: 'Pacific/Auckland' });
    const { couple } = await auth.createCouple(bob.id, '2020-02-14');
    await auth.signInWithEmail('alice@example.com', 'password');
    await auth.joinCoupleWithCode(alice.id, couple.invite_code);
    const carol = (await auth.signUpWithEmail('carol@example.com', 'password')).user;
    await auth.saveOnboardingProfile(carol.id, { name: 'Carol', location: null, timezone: 'UTC' });

    const asAlice = async (work) => {
      await auth.signOutUser();
      await auth.signInWithEmail('alice@example.com', 'password');
      return work();
    };
    const asBob = async (work) => {
      await auth.signOutUser();
      await auth.signInWithEmail('bob@example.com', 'password');
      return work();
    };

    // --- An author starts a letter as a draft, in their own couple -------------------
    let draft = null;
    await asAlice(async () => {
      draft = await epistleService.createEpistleDraft(couple.id, alice.id, { title: 'The long way home', body: 'It has been forty-one days.' });
      assert.ok(draft.id);
      assert.equal(draft.sealed_at, null, 'a letter begins unsealed');
    });

    // Alice's draft is hers alone: Bob's phone has never heard of it.
    await asBob(async () => {
      const { data } = await supabase.from('epistles').select('*').eq('couple_id', couple.id);
      assert.equal((data ?? []).length, 0, 'a partner can never see the other one drafting');
    });

    // --- Sealing: the letter stands in the partner's mailbox -------------------------
    await asAlice(async () => {
      const sealed = await epistleService.sealEpistle(draft.id, null);
      assert.ok(sealed.sealed_at, 'sealing stamps the moment');
      assert.equal(sealed.opens_at, null);

      // An author may not insert a sealed letter straight into existence: drafts only.
      const { error } = await supabase.from('epistles').insert({
        couple_id: couple.id,
        title: 'Shortcut',
        body: 'Trying to skip the draft.',
        sealed_at: new Date().toISOString(),
      }).select().single();
      assert.ok(error, 'a letter must begin as a draft');
    });

    await asBob(async () => {
      const rows = await epistleService.fetchEpistles(couple.id);
      assert.equal(rows.length, 1, 'the sealed letter is now in the couple’s world');
      assert.equal(rows[0].title, 'The long way home');

      // The partner may not rework somebody else's letter. (A filtered update is
      // silent — zero rows — so what we assert is the thing that matters: the
      // words were never touched.)
      await supabase.from('epistles')
        .update({ body: 'Rewritten by the wrong hands.' })
        .eq('id', draft.id);
      const reread = await epistleService.fetchEpistles(couple.id);
      assert.equal(reread[0].body, 'It has been forty-one days.', 'the words were never touched');
      assert.equal(reread[0].title, 'The long way home');
    });

    // --- The seal refuses the author, and answers the day to the partner -------------
    await asAlice(async () => {
      await assert.rejects(
        () => epistleService.openEpistle(draft.id),
        /never sealed to you/,
        'the author was never sealed out of their own letter',
      );
    });

    // --- A scheduled letter waits for its day ----------------------------------------
    let anniversary = null;
    await asBob(async () => {
      anniversary = await epistleService.createEpistleDraft(couple.id, bob.id, { title: null, body: 'Open this on our day.' });
      await epistleService.sealEpistle(anniversary.id, '2099-01-01');
    });

    await asAlice(async () => {
      await assert.rejects(
        () => epistleService.openEpistle(anniversary.id),
        /Not yet/,
        'the database decides when the day has come, not the phone',
      );
      // …but the waiting envelope is visible: anticipation is part of the design.
      const rows = await epistleService.fetchEpistles(couple.id);
      assert.equal(rows.length, 2);
    });

    // --- Taking a letter back, while it is still unopened ----------------------------
    await asBob(async () => {
      const recalled = await epistleService.recallEpistle(anniversary.id);
      assert.equal(recalled.sealed_at, null, 'the wax lifts');
      assert.equal(recalled.opens_at, null, 'the day is forgotten');
      const resealed = await epistleService.sealEpistle(anniversary.id, '2099-01-01');
      assert.ok(resealed.sealed_at, 'and it goes back on the mantelpiece');
    });

    // --- Breaking the seal: once, by the partner, on the day -------------------------
    let opened = null;
    await asBob(async () => {
      opened = await epistleService.openEpistle(draft.id);
      assert.ok(opened.opened_at, 'the seal is broken');

      // Opening twice is not a second ceremony; the letter is simply returned.
      const again = await epistleService.openEpistle(draft.id);
      assert.equal(again.opened_at, opened.opened_at);
    });

    // --- Once opened, the letter is final --------------------------------------------
    await asBob(async () => {
      await supabase.from('epistles')
        .update({ body: 'Too late to reword.' })
        .eq('id', draft.id);
      const reread = await epistleService.fetchEpistles(couple.id);
      assert.equal(reread.find((row) => row.id === draft.id).body, 'It has been forty-one days.', 'a read letter is final');
    });

    // --- Replies: a letter may answer another ----------------------------------------
    let question = null;
    let answer = null;
    await asAlice(async () => {
      question = await epistleService.createEpistleDraft(couple.id, alice.id, { title: 'A question', body: 'Do you remember the rain?' });
      await epistleService.sealEpistle(question.id, null);
    });
    await asBob(async () => {
      await epistleService.openEpistle(question.id);
      answer = await epistleService.createEpistleDraft(couple.id, bob.id, {
        title: 'Re: A question',
        body: 'I remember everything.',
        replyToId: question.id,
      });
      assert.equal(answer.reply_to_id, question.id, 'the answer points at the answered letter');
    });

    // A reply draft is still a draft: the answered side has never heard of it.
    await asAlice(async () => {
      const rows = await epistleService.fetchEpistles(couple.id);
      assert.equal(rows.find((row) => row.id === answer.id), undefined, 'a reply draft is private until sealed');
    });

    // A draft answers nothing — not even its author's own.
    await asAlice(async () => {
      const unsent = await epistleService.createEpistleDraft(couple.id, alice.id, { title: null, body: 'Not yet sent.' });
      await assert.rejects(
        () => epistleService.createEpistleDraft(couple.id, alice.id, { title: null, body: 'Too soon.', replyToId: unsent.id }),
        /sealed/,
        'only a sealed letter may be answered',
      );
      // Nor does a letter outside the mailbox.
      await assert.rejects(
        () => epistleService.createEpistleDraft(couple.id, alice.id, { title: null, body: 'To nobody.', replyToId: '00000000-0000-0000-0000-000000000000' }),
        /own mailbox/,
        'only a letter in the mailbox may be answered',
      );
      // The link may be cleared while the reply is still a draft, and set again.
      const cleared = await epistleService.saveEpistleDraft(unsent.id, { title: null, body: 'Not yet sent.', replyToId: null });
      assert.equal(cleared.reply_to_id, null);
    });

    await asBob(async () => {
      // A letter never answers itself.
      await assert.rejects(
        () => epistleService.saveEpistleDraft(anniversary.id, { title: 'Re: ours', body: 'Open this on our day.', replyToId: anniversary.id }),
        /no_self_reply|own letter/i,
        'a letter never answers itself',
      );
      // Sealing keeps the link: the answer arrives as an answer.
      const sealed = await epistleService.sealEpistle(answer.id, null);
      assert.equal(sealed.reply_to_id, question.id, 'sealing keeps the correspondence');
    });

    // --- Drafts are discardable; sealed letters are keepsakes ------------------------
    await asBob(async () => {
      const disposable = await epistleService.createEpistleDraft(couple.id, bob.id, { title: null, body: 'Not my best work.' });
      await epistleService.deleteEpistleDraft(disposable.id);
      const { data: after } = await supabase.from('epistles').select('id').eq('id', disposable.id);
      assert.equal(after.length, 0, 'a draft may be discarded');

      // A sealed letter is a keepsake: a delete touches nothing, and it survives.
      await supabase.from('epistles').delete().eq('id', draft.id);
      const { data: keepsakes } = await supabase.from('epistles').select('id').eq('id', draft.id);
      assert.equal(keepsakes.length, 1, 'a sealed letter is not deleted');
    });

    // --- A stranger's account is outside the whole world ------------------------------
    await auth.signOutUser();
    await auth.signInWithEmail('carol@example.com', 'password');
    const carolRows = await epistleService.fetchEpistles(couple.id).catch(() => []);
    assert.equal(carolRows.length, 0, 'an unpaired account reads nothing');
    await assert.rejects(
      () => epistleService.openEpistle(draft.id),
      /Pair with your partner|does not exist/,
      'a third account may never break a couple’s seal',
    );

    // --- Rerunning the migrations changes nothing -------------------------------------
    await backend.exec(migration);
    await backend.exec(repliesMigration);
    await asAlice(async () => {
      const rows = await epistleService.fetchEpistles(couple.id);
      assert.equal(rows.length, 5, 'the letters survive a rerun');
      const again = rows.find((row) => row.id === draft.id);
      assert.ok(again.opened_at, 'the broken seal stays broken');
      const kept = rows.find((row) => row.id === answer.id);
      assert.equal(kept.reply_to_id, question.id, 'the correspondence survives a rerun');
    });
  } finally {
    if (backend) await backend.close();
    await server.close();
  }
});
