#!/usr/bin/env node
// Screenshot one deep link and print page errors.
// Usage: node scripts/e2e/peek.mjs "nav=walk&sample=1&view=split" [name] [--size 390x844] [--wait 3000] [--nokey]
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { launch, sleep } from './cdp.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const k = args.indexOf(n); return k >= 0 ? args[k + 1] : d; };
const [query = '', name = 'peek'] = args.filter((a, i) => !a.startsWith('--') && !['--size', '--wait', '--base'].includes(args[i - 1]));
const [width, height] = flag('--size', '1440x900').split('x').map(Number);
const base = flag('--base', process.env.SPACELENS_URL ?? 'http://localhost:5180/');
const shots = join(process.env.LOCALAPPDATA ?? tmpdir(), 'Temp', 'spacelens-shots', 'e2e');

const page = await launch({ width, height, shots });
try {
  await page.goto(`${base}?coach=0&${query}`, 500);
  if (args.includes('--nokey')) await page.evaluate(`window.__spacelens.useStore.getState().setSettings({ geminiKey: '' })`);
  await sleep(Number(flag('--wait', '3000')));
  console.log(await page.shot(name));
  for (const p of page.takeProblems()) console.log(`  [${p.kind}] ${p.text}`);
} finally {
  await page.close();
}
