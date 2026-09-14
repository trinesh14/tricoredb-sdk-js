import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const testsDir = join(root, 'test');

function collect(dir) {
  const items = readdirSync(dir, { withFileTypes: true });
  const out = [];
  for (const item of items) {
    const path = join(dir, item.name);
    if (item.isDirectory()) out.push(...collect(path));
    else if (item.isFile() && item.name.endsWith('.test.js')) out.push(path);
  }
  return out.sort();
}

const tests = collect(testsDir);
if (tests.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

const result = spawnSync(process.execPath, ['--test', ...tests], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
