import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSupabaseConfig } from '../src/lib/supabaseConfig.mjs';

const project = 'https://test-project.supabase.co';
const publishable = 'sb_publishable_test_only';
const jwt = (role) => `header.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;

test('configuration rejects missing settings, placeholders and private keys', () => {
  assert(validateSupabaseConfig('', ''));
  assert(validateSupabaseConfig(project, ''));
  assert(validateSupabaseConfig('https://your-project-ref.supabase.co', publishable));
  assert(validateSupabaseConfig('http://test-project.supabase.co', publishable));
  assert(validateSupabaseConfig(`${project}/rest/v1`, publishable));
  assert(validateSupabaseConfig(project, 'your-anon-public-key'));
  assert(validateSupabaseConfig(project, 'sb_secret_never_expose_this'));
  assert(validateSupabaseConfig(project, jwt('service_role')));
  assert.equal(validateSupabaseConfig(project, publishable), null);
  assert.equal(validateSupabaseConfig(project, jwt('anon')), null);
});

test('build preflight fails closed without environment configuration', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'nooki-env-test-'));
  const script = fileURLToPath(new URL('../scripts/check-env.mjs', import.meta.url));
  const env = { ...process.env };
  delete env.VITE_SUPABASE_URL;
  delete env.VITE_SUPABASE_ANON_KEY;
  try {
    const missing = spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Build blocked/);
    const unsafe = spawnSync(process.execPath, [script], {
      cwd, env: { ...env, VITE_SUPABASE_URL: project, VITE_SUPABASE_ANON_KEY: jwt('service_role') }, encoding: 'utf8',
    });
    assert.equal(unsafe.status, 1);
    assert(!unsafe.stderr.includes(jwt('service_role')), 'errors never print private keys');
    execFileSync(process.execPath, [script], {
      cwd, env: { ...env, VITE_SUPABASE_URL: project, VITE_SUPABASE_ANON_KEY: publishable }, stdio: 'pipe',
    });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
