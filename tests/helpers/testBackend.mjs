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
    GRANT SELECT, INSERT, DELETE ON public.push_subscriptions TO authenticated;
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
      const values = params.map(([, value]) => value);
      // PostgREST returns a list for a set-returning function and a bare value otherwise.
      const returnsSet = (await db.query(
        `SELECT p.proretset FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = $1`,
        [name],
      )).rows.some((row) => row.proretset);
      if (returnsSet) {
        const result = await db.query(`SELECT * FROM public.${name}(${placeholders})`, values);
        return { data: result.rows.map(toRow), error: null };
      }
      const result = await db.query(`SELECT public.${name}(${placeholders}) AS result`, values);
      return { data: result.rows[0].result, error: null };
    } catch (error) { return { data: null, error: { message: error.message, code: error.code } }; }
  };
  // PostgREST sends JSON for a jsonb column; a bare string bound into one is not valid
  // JSON. Learn which columns those are so a write arrives the way the real client sends it.
  const jsonColumns = new Map();
  const jsonColumnsFor = async (table) => {
    if (!jsonColumns.has(table)) {
      const result = await db.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 AND data_type IN ('json', 'jsonb')`,
        [table],
      );
      jsonColumns.set(table, new Set(result.rows.map((row) => row.column_name)));
    }
    return jsonColumns.get(table);
  };
  const encodeWrite = async (table, fields, values) => {
    const jsonFields = await jsonColumnsFor(table);
    return values.map((value, index) => (
      value !== null && value !== undefined && jsonFields.has(fields[index]) ? JSON.stringify(value) : value
    ));
  };

  client.from = (table) => {
    if (![
      'profiles', 'couples', 'couple_events', 'messages',
      'questions', 'question_sessions', 'answers', 'answer_comments', 'couple_settings',
      'shared_books', 'reading_progress', 'highlights', 'push_subscriptions',
    ].includes(table)) throw new Error('Unexpected table in test');
    let writeData;
    let writeMode;
    let writeConflict = 'id';
    let singleRow = false;
    let orderBy;
    let rowLimit;
    const filters = [];
    const query = {
      select() { return query; },
      insert(data) { writeData = data; writeMode = 'insert'; return query; },
      upsert(data, options = {}) {
        writeData = data;
        writeMode = 'upsert';
        writeConflict = options.onConflict || 'id';
        return query;
      },
      update(data) { writeData = data; writeMode = 'update'; return query; },
      delete() { writeMode = 'delete'; return query; },
      order(column, options = {}) { assertIdentifier(column); orderBy = `${column} ${options.ascending === false ? 'DESC' : 'ASC'}`; return query; },
      limit(count) { rowLimit = count; return query; },
      eq(column, value) { assertIdentifier(column); filters.push([column, '=', value]); return query; },
      neq(column, value) { assertIdentifier(column); filters.push([column, '<>', value]); return query; },
      // `= ANY($n)`: PostgREST's `in`, which takes one array parameter.
      in(column, values) {
        assertIdentifier(column);
        if (!Array.isArray(values)) throw new Error('in() needs a list of values');
        filters.push([column, '= ANY', values]);
        return query;
      },
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
          ? `WHERE ${filters.map(([field, operator]) => {
              if (operator === 'IS NULL' || operator === 'IS NOT NULL') return `${field} ${operator}`;
              // `= ANY` takes one array parameter, wrapped: `col = ANY($1)`.
              if (operator === '= ANY') return `${field} = ANY($${++placeholder})`;
              return `${field} ${operator} $${++placeholder}`;
            }).join(' AND ')}`
          : '';
        if (writeMode === 'insert' || writeMode === 'upsert') {
          const fields = Object.keys(writeData);
          fields.forEach(assertIdentifier);
          const values = await encodeWrite(table, fields, Object.values(writeData));
          const conflictColumns = writeConflict.split(',').map((key) => { const trimmed = key.trim(); assertIdentifier(trimmed); return trimmed; });
          const updates = fields.filter((key) => !conflictColumns.includes(key));
          const conflict = writeMode !== 'upsert'
            ? ''
            : updates.length
              ? ` ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${updates.map((key) => `${key} = EXCLUDED.${key}`).join(', ')}`
              : ` ON CONFLICT (${conflictColumns.join(', ')}) DO NOTHING`;
          result = await db.query(
            `INSERT INTO public.${table} (${fields.join(', ')}) VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')})${conflict} RETURNING *`,
            values,
          );
        } else if (writeMode === 'update') {
          const fields = Object.keys(writeData);
          fields.forEach(assertIdentifier);
          const values = await encodeWrite(table, fields, Object.values(writeData));
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
      finally { writeData = undefined; writeMode = undefined; writeConflict = 'id'; }
    }
    return query;
  };
  // Owner-level access, so tests can apply migrations the way the dashboard would.
  // RLS is bypassed as the owner; callers must sign in again afterwards.
  return {
    close: () => db.close(),
    // Returns the statement results, so a test can read what a script printed (the same
    // shape `db.exec` gives directly).
    exec: async (sql) => { await db.exec('RESET ROLE'); return db.exec(sql); },
    query: async (sql, params) => { await db.exec('RESET ROLE'); return db.query(sql, params); },
    resetRole: async () => { await db.exec('RESET ROLE'); },
    // verify.sql opens its own read-only transaction: a script that raises on purpose
    // leaves it aborted, and nothing else runs until it is rolled back. RESET ROLE is
    // itself refused inside an aborted transaction, so this goes straight to the server.
    rollback: async () => { try { await db.exec('ROLLBACK'); } catch { /* nothing was open */ } },
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
  // Lower-case Postgres identifiers, digits allowed after the first character: the push
  // RPCs take `p256dh`/`p_auth`, and the real client sends exactly those names.
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid identifier in test query');
}
