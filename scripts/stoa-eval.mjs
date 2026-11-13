#!/usr/bin/env node
// Runs the Stoa benchmark through vitest so it uses the app's own TypeScript answerer.
// Usage: node scripts/stoa-eval.mjs [datasetPath] [--source swiss_dwellings] [--limit 300]
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const env = { ...process.env, STOA_EVAL: '1' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source') env.STOA_SOURCE = args[++i];
  else if (args[i] === '--limit') env.STOA_LIMIT = args[++i];
  else env.STOA_DATA = args[i];
}
const r = spawnSync('npx', ['vitest', 'run', 'src/features/drawings/stoa.eval.test.ts'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
