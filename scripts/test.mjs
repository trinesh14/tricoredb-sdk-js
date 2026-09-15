import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// npm test            -> every suite under test/
// npm run test:unit   -> test/unit only
// npm run test:live   -> test/live only (needs a tricore-server binary, or TRICORE_TEST_HOST)
const root = fileURLToPath(new URL('..', import.meta.url));
const which = process.argv[2];
const base = join(root, 'test');
const dir = which ? join(base, which) : base;

if (!existsSync(dir)) {
  console.log(`No test directory at ${dir}.`);
  process.exit(0);
}

function collect(d) {
  const out = [];
  for (const item of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, item.name);
    if (item.isDirectory()) out.push(...collect(p));
    else if (item.isFile() && item.name.endsWith('.test.js')) out.push(p);
  }
  return out.sort();
}

const tests = collect(dir);
if (tests.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

// A per-test timeout turns a leaked socket or timer into a failure instead of a
// hung run. `--test-timeout` exists only from Node 20.11 / 21.2, so older
// versions run without it rather than refusing to start at all.
const [major, minor] = process.versions.node.split('.').map(Number);
const hasTimeout = major > 21 || (major === 21 && minor >= 2) || (major === 20 && minor >= 11);
const flags = ['--test'];
if (hasTimeout) flags.push('--test-timeout=60000');
if (process.env.TEST_REPORTER) flags.push(`--test-reporter=${process.env.TEST_REPORTER}`);

function run(files) {
  const r = spawnSync(process.execPath, [...flags, ...files], { cwd: root, stdio: 'inherit' });
  return r.status ?? 1;
}

// Unit tests are hermetic and run together. Live test files run one at a time:
// against a shared server (TRICORE_TEST_HOST) they would otherwise interleave,
// and one file's CREATE TABLE committing while another file's transaction is
// open makes the server abort that transaction — correct server behaviour, and
// a false failure here. `--test-concurrency` would express this, but Node 18
// and 19 do not have it, so each live file gets its own process instead.
const live = tests.filter((t) => t.includes(`${sep}live${sep}`));
const others = tests.filter((t) => !live.includes(t));

let status = 0;
if (others.length) status = run(others) || status;
for (const file of live) status = run([file]) || status;

process.exit(status);
