'use strict';

// The published shape: CJS and ESM agree, the version is one number, there are
// no runtime dependencies, and the emitted .d.ts matches the implementation.

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..', '..');
const pkg = require('../../package.json');
const cjs = require('tricoredb');

test('package.json is publishable as tricoredb 0.1.0 with zero runtime dependencies', () => {
  assert.equal(pkg.name, 'tricoredb');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.license, 'Apache-2.0');
  // Node 18 is past end-of-life; 20 is the oldest line the package supports.
  assert.equal(pkg.engines.node, '>=20');
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.repository.url, 'git+https://github.com/trinesh14/tricoredb-sdk-js.git');
  assert.ok(Array.isArray(pkg.files) && pkg.files.includes('LICENSE'));
  assert.equal(cjs.SDK_VERSION, pkg.version);
});

test('ESM and CommonJS entry points export the same names and working classes', async () => {
  const esm = await import('tricoredb');
  const names = (m) => Object.keys(m).filter((k) => k !== 'default' && k !== 'module.exports').sort();
  assert.deepEqual(names(esm), names(cjs));
  assert.deepEqual(names(cjs), [
    'AuthError', 'DEFAULT_PORT', 'DocFilter', 'DocStage', 'FEATURES', 'FEATURE_CORRELATION_ID',
    'FEATURE_SERVER_PARAMS', 'FEATURE_SESSION_TXN', 'MAX_CONTROL_FRAME_SIZE', 'MAX_FRAME_SIZE',
    'MAX_SUPPORTED_FRAME_VERSION', 'NOT_LEADER', 'Pool', 'PoolTimeout', 'ProtocolError', 'Response', 'Rows',
    'SDK_VERSION', 'Timeout', 'TriCore', 'TriCoreError', 'bindParams', 'connect', 'encodeBody', 'quoteSql', 'sqlParam',
  ]);
  assert.equal(typeof esm.TriCore.connect, 'function');
  assert.equal(new esm.TriCoreError('m', { code: 'not_leader' }).isRedirect, true);
  assert.equal(esm.NOT_LEADER, 'not_leader');
  assert.equal(esm.MAX_FRAME_SIZE, 16 * 1024 * 1024);
  assert.equal(esm.MAX_CONTROL_FRAME_SIZE, 64 * 1024);
});

test('error classes keep their hierarchy and names', () => {
  for (const Ctor of [cjs.AuthError, cjs.ProtocolError, cjs.Timeout, cjs.PoolTimeout]) {
    const e = new Ctor('boom');
    assert.ok(e instanceof cjs.TriCoreError && e instanceof Error);
    assert.equal(e.name, Ctor.name);
    assert.equal(e.code, null);
    assert.equal(e.leaderHint, null);
    assert.equal(e.isRedirect, false);
  }
});

test('the emitted declarations type-check against the implementation (ESM and CJS)', () => {
  const tsc = require.resolve('typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tsc, '-p', path.join('test', 'types', 'tsconfig.json')], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(r.status, 0, `tsc failed:\n${r.stdout}${r.stderr}`);
});
