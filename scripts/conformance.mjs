import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ['conformance/runner.js', ...args], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
