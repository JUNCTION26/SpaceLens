#!/usr/bin/env node
// Live quality run: generate every prompt with the real Gemini key (scripts/forge-live.test.ts),
// render each saved spec with headless Edge (scripts/forge-shot.mjs), and write a results table.
// Needs VITE_GEMINI_KEY in .env.local and the dev server on --port (default 5180).
// Usage: node scripts/forge-live.mjs [--out dir] [--only 0,3] [--prompts file.json] [--conc 1] [--no-shots]
//        node scripts/forge-live.mjs --table-only --out dir      rebuild results.md (reads verdicts.json if present)
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const out = resolve(flag('--out', 'forge-live-out'));
const port = flag('--port', '5180');
mkdirSync(out, { recursive: true });

if (!args.includes('--table-only')) {
  const env = { ...process.env, FORGE_LIVE: '1', FORGE_OUT: out, FORGE_CONC: flag('--conc', '1') };
  if (flag('--only')) env.FORGE_ONLY = flag('--only');
  if (flag('--prompts')) env.FORGE_PROMPTS = resolve(flag('--prompts'));
  const r = spawnSync('npx', ['vitest', 'run', 'scripts/forge-live.test.ts', '--reporter=verbose'], { stdio: 'inherit', env, shell: true });
  if (r.status) process.exit(r.status);
  if (!args.includes('--no-shots')) spawnSync('node', ['scripts/forge-shot.mjs', '--specs', out, '--out', out, '--port', port], { stdio: 'inherit', shell: true });
}

const rowsFile = resolve(out, 'results.json');
if (existsSync(rowsFile)) {
  const rows = JSON.parse(readFileSync(rowsFile, 'utf8'));
  const vf = resolve(out, 'verdicts.json');
  const verdicts = existsSync(vf) ? JSON.parse(readFileSync(vf, 'utf8')) : {};
  const lines = ['| # | prompt | model | tier | first token ms | first parts ms | total ms | items | parts | moving | out tok | fixes | verdict |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.i} | ${r.prompt} | ${r.model.replace(/^gemini-/, '')} | ${r.tier ?? '-'} | ${r.firstTokenMs ?? '-'} | ${r.firstPartsMs ?? '-'} | ${r.totalMs} | ${r.items ?? '-'} | ${r.parts} | ${r.motions} | ${r.outTok} | ${(r.fixes ?? []).join(', ')} | ${verdicts[r.slug] ?? verdicts[r.i] ?? ''} |`);
  const med = (k) => { const v = rows.map((r) => r[k]).filter((x) => typeof x === 'number').sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : '-'; };
  lines.push('', `Median: first token ${med('firstTokenMs')} ms, first parts ${med('firstPartsMs')} ms, total ${med('totalMs')} ms, ${med('parts')} parts, ${med('outTok')} output tokens.`);
  writeFileSync(resolve(out, 'results.md'), lines.join('\n') + '\n');
  console.log(lines.join('\n'));
}
