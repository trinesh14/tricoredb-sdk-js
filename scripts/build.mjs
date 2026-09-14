// Compile src/ twice: ESM to dist/esm, CommonJS to dist/cjs, each with .d.ts.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');

rmSync(join(root, 'dist'), { recursive: true, force: true });

for (const [project, out, type] of [
  ['tsconfig.json', 'dist/esm', 'module'],
  ['tsconfig.cjs.json', 'dist/cjs', 'commonjs'],
]) {
  const r = spawnSync(process.execPath, [tsc, '-p', project], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`tsc -p ${project} failed`);
    process.exit(r.status ?? 1);
  }
  mkdirSync(join(root, out), { recursive: true });
  writeFileSync(join(root, out, 'package.json'), `${JSON.stringify({ type }, null, 2)}\n`);
}

console.log('built dist/esm and dist/cjs');
