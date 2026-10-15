import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Test-only Supabase transport adapter backed by real PostgreSQL/RLS.
// This file is never imported by the app and never contacts a live project.
export async function installTestBackend(client) {
  await client.auth.initialize();
  await client.auth.dispose();
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE anon NOLOGIN;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id UUID PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE SQL STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::UUID;
    $$;
    CREATE FUNCTION auth.role() RETURNS TEXT LANGUAGE SQL STABLE AS $$ SELECT current_user::TEXT; $$;
  `);
  await db.exec(await readFile(new URL('../../supabase/schema.sql', import.meta.url), 'utf8'));
  await db.exec(`
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles, public.couples, public.couple_events TO authenticated;
  `);
  const users = new Map();
  let currentUser = null;
  const setUser = async (user) => {
    currentUser = user;
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, false)", [user?.id || '']);
    await db.exec('SET ROLE authenticated');
  };
  client.auth.signUp = async ({ email, password }) => {
    const user = { id: randomUUID(), email };
    users.set(email, { user, password });
    await db.exec('RESET ROLE');
    await db.query('INSERT INTO auth.users (id) VALUES ($1)', [user.id]);
    await setUser(user);
    return { data: { user, session: { user } }, error: null };
  };
  client.auth.signInWithPassword = async ({ email, password }) => {
    const account = users.get(email);
    if (!account || account.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
    await setUser(account.user);
    return { data: { user: account.user, session: { user: account.user } }, error: null };
  };
  client.auth.getUser = async () => ({ data: { user: currentUser }, error: null });
  client.auth.getSession = async () => ({ data: { session: currentUser ? { user: currentUser } : null }, error: null });
  client.auth.signOut = async () => { await setUser(null); return { error: null }; };

  client.rpc = async (name, args = {}) => {
    assertIdentifier(name);
    try {
      const params = Object.entries(args);
      const placeholders = params.map(([key], i) => { assertIdentifier(key); return `${key} => $${i + 1}`; }).join(', ');
      const result = await db.query(`SELECT public.${name}(${placeholders}) AS result`, params.map(([, value]) => value));
      return { data: result.rows[0].result, error: null };
    } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
  };
  client.from = (table) => {
    if (!['profiles', 'couples', 'couple_events', 'messages'].includes(table)) throw new Error('Unexpected table in test');
    let writeData;
    let writeMode;
    let singleRow = false;
    let orderBy;
    let rowLimit;
    const filters = [];
    const query = {
      select() { return query; },
      insert(data) { writeData = data; writeMode = 'insert'; return query; },
      upsert(data) { writeData = data; writeMode = 'upsert'; return query; },
      update(data) { writeData = data; writeMode = 'update'; return query; },
      delete() { writeMode = 'delete'; return query; },
      order(column, options = {}) { assertIdentifier(column); orderBy = `${column} ${options.ascending === false ? 'DESC' : 'ASC'}`; return query; },
      limit(count) { rowLimit = count; return query; },
      eq(column, value) { assertIdentifier(column); filters.push([column, '=', value]); return query; },
      neq(column, value) { assertIdentifier(column); filters.push([column, '<>', value]); return query; },
      // `IS NULL` / `IS NOT NULL`: Postgres does not accept a bind parameter here.
      is(column, value) { assertIdentifier(column); filters.push([column, value === null ? 'IS NULL' : 'IS NOT NULL', undefined]); return query; },
      single() { singleRow = true; return execute(); },
      maybeSingle() { singleRow = true; return execute(); },
      // Bare `await` on a filter builder returns a list, exactly like the real client.
      then(resolve, reject) { return execute().then(resolve, reject); },
    };
    async function execute() {
      try {
        let result;
        // `IS NULL` carries no value, so only value-carrying filters consume a placeholder.
        let placeholder = 0;
        const where = filters.length
          ? `WHERE ${filters.map(([field, operator]) => (
              operator === 'IS NULL' || operator === 'IS NOT NULL'
                ? `${field} ${operator}`
                : `${field} ${operator} $${++placeholder}`
            )).join(' AND ')}`
          : '';
        if (writeMode === 'insert' || writeMode === 'upsert') {
          const fields = Object.keys(writeData);
          fields.forEach(assertIdentifier);
          const values = Object.values(writeData);
          const conflict = writeMode === 'upsert'
            ? ` ON CONFLICT (id) DO UPDATE SET ${fields.filter((key) => key !== 'id').map((key) => `${key} = EXCLUDED.${key}`).join(', ')}`
            : '';
          result = await db.query(
            `INSERT INTO public.${table} (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})${conflict} RETURNING *`,
            values,
          );
        } else if (writeMode === 'update') {
          const fields = Object.keys(writeData);
          fields.forEach(assertIdentifier);
          const values = Object.values(writeData);
          let updatePlaceholder = fields.length;
          const whereForUpdate = filters.length
            ? `WHERE ${filters.map(([field, operator]) => (
                operator === 'IS NULL' || operator === 'IS NOT NULL'
                  ? `${field} ${operator}`
                  : `${field} ${operator} $${++updatePlaceholder}`
              )).join(' AND ')}`
            : '';
          result = await db.query(
            `UPDATE public.${table} SET ${fields.map((field, i) => `${field} = $${i + 1}`).join(', ')} ${whereForUpdate} RETURNING *`,
            [...values, ...filters.filter(([, , value]) => value !== undefined).map(([, , value]) => value)],
          );
        } else if (writeMode === 'delete') {
          result = await db.query(`DELETE FROM public.${table} ${where} RETURNING *`,
            filters.filter(([, , value]) => value !== undefined).map(([, , value]) => value));
        } else {
          result = await db.query(
            `SELECT * FROM public.${table} ${where}${orderBy ? ` ORDER BY ${orderBy}` : ''}${rowLimit ? ` LIMIT ${Number(rowLimit)}` : ''}`,
            filters.filter(([, , value]) => value !== undefined).map(([, , value]) => value),
          );
        }
        const rows = result.rows.map(toRow);
        if (singleRow && rows.length > 1) throw new Error('Expected at most one row');
        return { data: singleRow ? rows[0] ?? null : rows, error: null };
      } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
      finally { writeData = undefined; writeMode = undefined; }
    }
    return query;
  };
  // Owner-level access, so tests can apply migrations the way the dashboard would.
  // RLS is bypassed as the owner; callers must sign in again afterwards.
  return {
    close: () => db.close(),
    exec: async (sql) => { await db.exec('RESET ROLE'); await db.exec(sql); },
    query: async (sql, params) => { await db.exec('RESET ROLE'); return db.query(sql, params); },
    resetRole: async () => { await db.exec('RESET ROLE'); },
  };
}

/** Mirrors how the real client serialises Postgres values into JSON. */
function toRow(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    value instanceof Date ? (key.endsWith('_date') ? value.toISOString().slice(0, 10) : value.toISOString()) : value,
  ]));
}

function assertIdentifier(value) {
  if (!/^[a-z_]+$/.test(value)) throw new Error('Invalid identifier in test query');
}
