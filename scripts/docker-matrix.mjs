// Run the unit and live suites on every Node.js major version, each against a
// fresh TriCoreDB container.
//
//   node scripts/docker-matrix.mjs
//   TRICOREDB_IMAGE=tricoredb:local NODE_MAJORS=20,22,24 REPEAT=3 node scripts/docker-matrix.mjs
//
// For every run: a new data volume, a newly seeded administrator with a random
// password, a new server container, then the tests in a `node:<major>`
// container on the same Docker network. Nothing is shared between runs. A
// skipped test counts as a failure: this exists to prove the tests ran.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/');
const image = process.env.TRICOREDB_IMAGE || 'tricoredb:local';
const majors = (process.env.NODE_MAJORS || '18,19,20,21,22,23,24,25,26').split(',').map((s) => s.trim());
const repeat = Math.max(1, Number(process.env.REPEAT || 1));
const network = 'tricoredb-sdk-js-matrix';
const config = `${root}/test/docker/tricore.test.toml`;

function docker(args, { env } = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1', ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitForServer(name, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const logs = docker(['logs', name]);
    const text = `${logs.stdout}${logs.stderr}`;
    if (/listening on/.test(text)) return null;
    if (docker(['inspect', '-f', '{{.State.Running}}', name]).stdout.trim() === 'false') {
      return `server container exited:\n${text.slice(-2000)}`;
    }
    sleep(500);
  }
  return 'server did not report listening within 90s';
}

// `scripts/test.mjs` runs live files in separate processes, so the output holds
// several TAP summaries. Sum them all; taking the first would report one file.
const count = (tap, key) => {
  const matches = [...tap.matchAll(new RegExp(`^# ${key} (\\d+)`, 'gm'))];
  return matches.length ? matches.reduce((n, m) => n + Number(m[1]), 0) : null;
};

// Each `not ok` line with the YAML diagnostics block under it (error, expected,
// actual, location), so a failure explains itself.
function failureBlocks(tap) {
  const lines = tap.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*not ok /.test(lines[i])) continue;
    const block = [lines[i]];
    for (let j = i + 1; j < lines.length && block.length < 45; j++) {
      block.push(lines[j]);
      if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
    }
    blocks.push(block.join('\n'));
  }
  return blocks;
}

function cleanup(db, volume) {
  docker(['rm', '-f', db]);
  docker(['volume', 'rm', '-f', volume]);
}

if (docker(['image', 'inspect', image, '-f', '{{.Id}}']).status !== 0) {
  console.error(`image ${image} not found; build it first (TRICOREDB_IMAGE overrides)`);
  process.exit(2);
}
docker(['network', 'rm', network]);
if (docker(['network', 'create', network]).status !== 0) {
  console.error(`could not create docker network ${network}`);
  process.exit(2);
}

const results = [];
for (const major of majors) {
  for (let attempt = 1; attempt <= repeat; attempt++) {
    const db = `tricoredb-sdkjs-${major}`;
    const volume = `tricoredb-sdkjs-${major}`;
    const secret = randomBytes(24).toString('base64url');
    const row = { major, attempt, node: '?', tests: null, pass: null, fail: null, cancelled: null, skipped: null };
    cleanup(db, volume);
    process.stdout.write(`node ${major}${repeat > 1 ? ` #${attempt}` : ''}: `);

    try {
      if (docker(['volume', 'create', volume]).status !== 0) throw new Error('volume create failed');

      const seed = docker(
        ['run', '--rm', '-v', `${volume}:/var/lib/tricoredb`, '-e', 'TRICORE_ADMIN_PASSWORD',
          '--entrypoint', '/usr/local/bin/tricore', image,
          'auth', 'init-admin', '--user', 'admin', '--password-env', 'TRICORE_ADMIN_PASSWORD',
          '--data-dir', '/var/lib/tricoredb/data'],
        { env: { TRICORE_ADMIN_PASSWORD: secret } },
      );
      if (seed.status !== 0) throw new Error(`seeding the admin failed:\n${seed.stdout}${seed.stderr}`);

      const run = docker([
        'run', '-d', '--name', db, '--network', network, '--network-alias', 'tricoredb',
        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
        '-v', `${volume}:/var/lib/tricoredb`,
        '-v', `${config}:/etc/tricoredb/tricore.toml:ro`,
        image,
      ]);
      if (run.status !== 0) throw new Error(`server container failed to start:\n${run.stderr}`);
      const notReady = waitForServer(db);
      if (notReady) throw new Error(notReady);

      // `scripts/test.mjs` picks the flags each Node version supports.
      const t = docker(
        ['run', '--rm', '--network', network, '-v', `${root}:/app`, '-w', '/app',
          '-e', 'TRICORE_TEST_HOST=tricoredb', '-e', 'TRICORE_TEST_PORT=8427',
          '-e', 'TRICORE_TEST_USER=admin', '-e', 'TRICORE_TEST_SECRET', '-e', 'TEST_REPORTER=tap',
          `node:${major}-alpine`, 'sh', '-c', 'node --version && node scripts/test.mjs'],
        { env: { TRICORE_TEST_SECRET: secret } },
      );
      const out = `${t.stdout}${t.stderr}`;
      row.node = (/^v\d+\.\d+\.\d+/m.exec(out) || ['?'])[0];
      for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) row[k] = count(out, k);
      if (row.tests === null) row.error = `no test summary:\n${out.slice(-3000)}`;
      row.failures = failureBlocks(out);
    } catch (e) {
      row.error = e.message;
    } finally {
      cleanup(db, volume);
    }

    row.ok = !row.error && row.fail === 0 && row.cancelled === 0 && row.skipped === 0 && row.tests > 0;
    results.push(row);
    console.log(row.ok ? `PASS (${row.node}, ${row.pass}/${row.tests})` : 'FAIL');
  }
}

docker(['network', 'rm', network]);

console.log('\nNode  run  version     tests  pass  fail  cancelled  skipped  result');
for (const r of results) {
  const cell = (v, w = 5) => String(v ?? '-').padStart(w);
  console.log(
    `${String(r.major).padEnd(5)} ${String(r.attempt).padEnd(4)} ${String(r.node).padEnd(10)} ${cell(r.tests)} ${cell(r.pass)} ${cell(r.fail)} ${cell(r.cancelled, 10)} ${cell(r.skipped, 8)}  ${r.ok ? 'PASS' : 'FAIL'}`,
  );
}
for (const r of results.filter((x) => !x.ok)) {
  console.log(`\n--- node ${r.major} run ${r.attempt} (${r.node}) ---`);
  if (r.failures && r.failures.length) console.log(r.failures.join('\n\n'));
  if (r.error) console.log(r.error);
}
process.exit(results.every((r) => r.ok) ? 0 : 1);
