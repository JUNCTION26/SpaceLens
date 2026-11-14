#!/usr/bin/env node
// Plan-to-building benchmark: converts every swiss_dwellings PDF into a 3D model and scores it
// against the printed room areas and the dataset questions. Uses the app's own TypeScript code.
// Usage: node scripts/stoa-build.mjs [datasetPath] [--limit 50] [--only site1000] [--overlays <dir>]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const args = process.argv.slice(2);
const env = { ...process.env, STOA_BUILD: '1' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit') env.STOA_LIMIT = args[++i];
  else if (args[i] === '--only') env.STOA_ONLY = args[++i];
  else if (args[i] === '--overlays') env.STOA_OVERLAYS = args[++i];
  else env.STOA_DATA = args[i];
}
const root = join(fileURLToPath(import.meta.url), '..', '..');
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', 'src/features/drawings/stoa.build.eval.test.ts'], { stdio: 'inherit', env, cwd: root });
process.exit(r.status ?? 1);
