#!/usr/bin/env node
// Serve the last commit on its own port so tests are not disturbed by files being edited in the working copy.
// Usage: node scripts/e2e/snapshot.mjs <dir> [--port 5191]
// Exports HEAD with `git archive` into <dir>, links node_modules, copies .env.local if present, starts Vite there.
import { execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const dir = resolve(args.find((a) => !a.startsWith('--')) ?? 'snapshot');
const k = args.indexOf('--port');
const port = k >= 0 ? args[k + 1] : '5191';
const repo = resolve(new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const tar = join(dir, '..', 'snapshot.tar');
execSync(`git archive --format=tar -o "${tar}" HEAD`, { cwd: repo });
// Relative path: some tar builds read "C:" as a remote host.
execSync('tar -xf ../snapshot.tar', { cwd: dir });
rmSync(tar, { force: true });
symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'junction');
if (existsSync(join(repo, '.env.local'))) copyFileSync(join(repo, '.env.local'), join(dir, '.env.local'));
const head = execSync('git log --oneline -1', { cwd: repo }).toString().trim();
writeFileSync(join(dir, 'SNAPSHOT.txt'), `${head}\n${new Date().toISOString()}\n`);
console.log(`snapshot of ${head} in ${dir}, serving on http://localhost:${port}/`);
// Keep the dependency cache inside the snapshot: node_modules is shared with the main dev server.
writeFileSync(join(dir, 'vite.snapshot.config.mjs'),
  "import base from './vite.config.ts';\nexport default { ...base, cacheDir: '.vite-snapshot-cache' };\n");
const vite = spawn(process.execPath, [join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'vite.snapshot.config.mjs', '--port', port, '--strictPort'], { cwd: dir, stdio: 'inherit' });
vite.on('exit', (c) => process.exit(c ?? 0));
