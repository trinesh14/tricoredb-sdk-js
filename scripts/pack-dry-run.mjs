import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npmCmd, ['pack', '--dry-run', '--json'], {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'npm pack failed');
  process.exit(result.status ?? 1);
}

const stdout = result.stdout || '';
const jsonStart = stdout.indexOf('[');
if (jsonStart === -1) {
  console.error('No npm pack JSON payload found in output');
  process.exit(1);
}

const payload = JSON.parse(stdout.slice(jsonStart));
const info = Array.isArray(payload) ? payload[0] : payload;
const files = Array.isArray(info?.files) ? info.files : [];
const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);

console.log(`npm pack --dry-run summary`);
console.log(`files: ${files.length}`);
console.log(`size: ${totalBytes} bytes`);
for (const file of files) {
  console.log(`- ${file.path} (${file.size} bytes)`);
}

if (files.length === 0) {
  console.log('No files included in the package tarball.');
}
