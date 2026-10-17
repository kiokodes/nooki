import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createServer } from 'vite';

// The place a person is lives on their profile: country, state, city, and the key the
// marketplace will one day join vendors on. Two things have to hold. The migration has to
// add all of it to a live project without touching the couples already on it, and the key
// the database generates has to be the key the frontend computes — because a vendor in
// Port Harcourt and a partner in port harcourt must land on the same row.

const ada = '00000000-0000-4000-8000-0000000000a1';
const ben = '00000000-0000-4000-8000-0000000000b2';
const stranger = '00000000-0000-4000-8000-0000000000c3';

const authSchema = `
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE anon NOLOGIN;
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id UUID PRIMARY KEY);
  CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
    SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
  $$;
  CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT current_user::TEXT; $$;
`;

test('locations: the migration adds them to a live project and leaves its couples alone', async () => {
  const db = new PGlite();
  try {
    await db.exec(authSchema);
    // A project as it was before this migration: profiles with a name, a timezone and a
    // couple, and nothing about where anybody is.
    await db.exec(`
      CREATE TABLE public.couples (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        invite_code VARCHAR(6) UNIQUE NOT NULL,
        anniversary_date DATE
      );
      CREATE TABLE public.profiles (
        id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
        couple_id UUID REFERENCES public.couples(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        last_seen_at TIMESTAMPTZ DEFAULT timezone('utc'::text, now()),
        created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
      );
      INSERT INTO auth.users VALUES ('${ada}'), ('${ben}');
      INSERT INTO public.couples (id, invite_code, anniversary_date)
        VALUES ('99999999-9999-4999-8999-999999999999', 'ABC123', '2021-06-01');
      INSERT INTO public.profiles (id, couple_id, name, timezone) VALUES
        ('${ada}', '99999999-9999-4999-8999-999999999999', 'Ada', 'Africa/Lagos'),
        ('${ben}', '99999999-9999-4999-8999-999999999999', 'Ben', 'Europe/London');
    `);

    const migration = await readFile(
      new URL('../supabase/migrations/202610170001_partner_locations.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    // Safe to run twice: a deploy that retries must not fail on the second attempt.
    await db.exec(migration);

    const before = (await db.query(
      `SELECT name, timezone, couple_id, country_code, city_key, location_updated_at
       FROM public.profiles ORDER BY name`)).rows;
    assert.deepEqual(before, [
      { name: 'Ada', timezone: 'Africa/Lagos', couple_id: '99999999-9999-4999-8999-999999999999', country_code: null, city_key: null, location_updated_at: null },
      { name: 'Ben', timezone: 'Europe/London', couple_id: '99999999-9999-4999-8999-999999999999', country_code: null, city_key: null, location_updated_at: null },
    ], 'an existing couple keeps its names, zones and pairing, and simply has no place yet');

    // The columns the app writes are all there, and the key follows the place.
    const moved = (await db.query(
      `UPDATE public.profiles SET country_code='NG', country_name='Nigeria', state_code='RI',
         state_name='Rivers', city_name='Port Harcourt', timezone='Africa/Lagos', location_updated_at=now()
       WHERE id='${ada}' RETURNING city_key`)).rows[0];
    assert.equal(moved.city_key, 'ng/ri/port-harcourt');

    const columns = (await db.query(
      `SELECT column_name, is_generated FROM information_schema.columns
       WHERE table_schema='public' AND table_name='profiles' ORDER BY ordinal_position`)).rows;
    // Order is not part of the contract (a migration appends, a fresh schema interleaves),
    // so this is a set: what matters is that every column the app writes is there.
    assert.deepEqual(columns.map((column) => column.column_name).sort(), [
      'city_key', 'city_name', 'country_code', 'country_name', 'couple_id', 'created_at', 'id',
      'last_seen_at', 'location_updated_at', 'name', 'state_code', 'state_name', 'timezone',
    ]);
    assert.equal(columns.find((column) => column.column_name === 'city_key').is_generated, 'ALWAYS');
    assert.deepEqual(
      (await db.query(`SELECT indexname FROM pg_indexes WHERE tablename='profiles' AND indexname='idx_profiles_city_key'`)).rows.length,
      1, 'the marketplace key is indexed');
  } finally {
    await db.close();
  }
});

test('locations: a place is whole or it is nothing, and only the couple can read it', async () => {
  const db = new PGlite();
  const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false } });
  try {
    await db.exec(authSchema);
    await db.exec(await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
    await db.exec(`
      GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.couples TO authenticated;
      INSERT INTO auth.users VALUES ('${ada}'), ('${ben}'), ('${stranger}');
    `);
    const asUser = async (id) => {
      await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [id || '']);
      await db.exec(id ? 'SET ROLE authenticated' : 'RESET ROLE');
    };

    // A fresh project starts the way a migrated one ends: no place, working clock.
    await asUser(ada);
    const created = (await db.query(
      `INSERT INTO public.profiles (id, name, timezone) VALUES ('${ada}', 'Ada', 'Africa/Lagos')
       RETURNING city_key, country_code, location_updated_at`)).rows[0];
    assert.deepEqual(created, { city_key: null, country_code: null, location_updated_at: null });

    await asUser(ben);
    await db.query(`INSERT INTO public.profiles (id, name) VALUES ('${ben}', 'Ben')`);
    await asUser(stranger);
    await db.query(`INSERT INTO public.profiles (id, name) VALUES ('${stranger}', 'Stranger')`);

    // Pair them as the owner, the way the pairing RPCs would.
    await asUser(null);
    await db.exec(`
      INSERT INTO public.couples (id, invite_code) VALUES ('88888888-8888-4888-8888-888888888888', 'XYZ789');
      UPDATE public.profiles SET couple_id='88888888-8888-4888-8888-888888888888' WHERE id IN ('${ada}', '${ben}');
    `);

    await asUser(ada);
    const saved = (await db.query(
      `UPDATE public.profiles SET country_code='NG', country_name='Nigeria', state_code='RI',
         state_name='Rivers', city_name='Port Harcourt', timezone='Africa/Lagos', location_updated_at=now()
       WHERE id='${ada}' RETURNING city_key, location_updated_at IS NOT NULL AS stamped`)).rows[0];
    assert.equal(saved.city_key, 'ng/ri/port-harcourt');
    assert.equal(saved.stamped, true);

    // Half a place is refused by the database, not only by the form. Each of these is an
    // update to Ada's own row, which RLS allows, so a rejection can only be the check.
    for (const [label, set] of [
      ['a city with no country', `country_code=NULL, country_name=NULL, state_code=NULL, state_name=NULL, city_name='Lagos'`],
      ['a country with no city', `city_name=NULL`],
      ['a blank city', `city_name='   '`],
      ['a stamped time with no place',
        `country_code=NULL, country_name=NULL, state_code=NULL, state_name=NULL, city_name=NULL`],
    ]) {
      await assert.rejects(
        db.query(`UPDATE public.profiles SET ${set}, location_updated_at=now() WHERE id='${ada}'`),
        /profiles_location_complete/,
        `${label} must not be savable`,
      );
    }
    assert.equal(
      (await db.query(`SELECT city_name FROM public.profiles WHERE id='${ada}'`)).rows[0].city_name,
      'Port Harcourt',
      'a refused half-place leaves the saved one exactly as it was',
    );

    // The generated key cannot be written, so it cannot drift from the place it came from.
    await assert.rejects(
      db.query(`UPDATE public.profiles SET city_key='ng/ri/lagos' WHERE id='${ada}'`),
      /cannot insert a non-DEFAULT value|can only be updated to DEFAULT/,
    );

    // Moving rewrites the key in the same update; clearing the place clears it too.
    const moved = (await db.query(
      `UPDATE public.profiles SET country_code='ZA', country_name='South Africa', state_code='WC',
         state_name='Western Cape', city_name='Cape Town', timezone='Africa/Johannesburg'
       WHERE id='${ada}' RETURNING city_key, timezone`)).rows[0];
    assert.deepEqual(moved, { city_key: 'za/wc/cape-town', timezone: 'Africa/Johannesburg' });
    const cleared = (await db.query(
      `UPDATE public.profiles SET country_code=NULL, country_name=NULL, state_code=NULL, state_name=NULL,
         city_name=NULL, location_updated_at=NULL WHERE id='${ada}' RETURNING city_key`)).rows[0];
    assert.equal(cleared.city_key, null);

    // The partner reads the place — that is what lets the marketplace open on their city
    // without a new table — and a stranger reads nothing at all.
    // The app always writes the place and the zone it implies together; clearing a place
    // leaves the old zone on the profile, which is the clock the couple is used to.
    await db.query(
      `UPDATE public.profiles SET country_code='NG', country_name='Nigeria', state_code='RI',
         state_name='Rivers', city_name='Port Harcourt', timezone='Africa/Lagos',
         location_updated_at=now() WHERE id='${ada}'`);
    await asUser(ben);
    const partnerSees = (await db.query(
      `SELECT city_name, city_key, timezone FROM public.profiles WHERE id='${ada}'`)).rows;
    assert.deepEqual(partnerSees, [{ city_name: 'Port Harcourt', city_key: 'ng/ri/port-harcourt', timezone: 'Africa/Lagos' }]);
    // Reading is allowed; rewriting is not. RLS hides the row from the partner's UPDATE
    // rather than raising, so the proof is that nothing changed.
    const attempted = await db.query(`UPDATE public.profiles SET city_name='Lagos' WHERE id='${ada}'`);
    assert.equal(attempted.affectedRows, 0, 'a partner can read a place but never rewrite it');
    await asUser(ada);
    assert.equal(
      (await db.query(`SELECT city_name FROM public.profiles WHERE id='${ada}'`)).rows[0].city_name,
      'Port Harcourt',
    );
    await asUser(stranger);
    // Everybody can read their own row, so what a stranger must not see is anybody else's.
    assert.deepEqual(
      (await db.query(`SELECT id, city_name, city_key FROM public.profiles ORDER BY id`)).rows,
      [{ id: stranger, city_name: null, city_key: null }],
      'somebody outside the couple sees their own place and nobody else’s',
    );

    // The frontend's key rule and the database's have to be the same rule.
    const { buildCityKey } = await server.ssrLoadModule('/src/lib/geo/location.ts');
    await asUser(null);
    const rows = (await db.query(`SELECT country_code, state_code, city_name, city_key FROM public.profiles`)).rows;
    for (const row of rows) {
      assert.equal(
        buildCityKey({ countryCode: row.country_code, stateCode: row.state_code, cityName: row.city_name }),
        row.city_key,
        `${row.city_name}: the app and the database disagree about the key`,
      );
    }
    const agreed = (await db.query(
      `SELECT public.profile_city_key('US','IN','Indianapolis') AS a,
              public.profile_city_key('SG',NULL,'Singapore') AS b,
              public.profile_city_key('CA','NS','St John''s') AS c`)).rows[0];
    assert.deepEqual(agreed, {
      a: buildCityKey({ countryCode: 'US', stateCode: 'IN', cityName: 'Indianapolis' }),
      b: buildCityKey({ countryCode: 'SG', stateCode: null, cityName: 'Singapore' }),
      c: buildCityKey({ countryCode: 'CA', stateCode: 'NS', cityName: "St John's" }),
    });

    // --- The deployment preflight passes here, and names the migration when a piece is gone
    const migration = await readFile(
      new URL('../supabase/migrations/202610170001_partner_locations.sql', import.meta.url), 'utf8');
    const verification = await readFile(new URL('../supabase/verify.sql', import.meta.url), 'utf8');
    await db.exec(verification);

    for (const [label, damage, expected] of [
      ['the whole-place check', 'ALTER TABLE public.profiles DROP CONSTRAINT profiles_location_complete', /whole-place-or-nothing/],
      ['the marketplace key index', 'DROP INDEX public.idx_profiles_city_key', /marketplace key index/],
      // The key rule itself cannot be dropped on its own: the generated column depends on
      // it, which is the point of generating it.
      ['the generated key', 'ALTER TABLE public.profiles DROP COLUMN city_key', /location columns/],
    ]) {
      await db.exec(damage);
      await assert.rejects(db.exec(verification), expected, `without ${label} the preflight must say so`);
      // The preflight runs in a transaction of its own, and a refused one leaves it aborted.
      await db.exec('ROLLBACK');
      await db.exec(migration);
      await db.exec(verification);
    }
  } finally {
    await server.close();
    await db.close();
  }
});
