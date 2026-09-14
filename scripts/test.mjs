import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// npm test            -> every suite under test/
// npm run test:unit   -> test/unit only
// npm run test:live   -> test/live only (needs TRICORE_SERVER_BIN or a running server)
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

// A per-test timeout so a leaked socket or timer fails loudly instead of
// hanging the run forever.
const result = spawnSync(process.execPath, ['--test', '--test-timeout=30000', ...tests], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
