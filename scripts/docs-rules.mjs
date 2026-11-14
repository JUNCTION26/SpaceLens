#!/usr/bin/env node
// Prints the design rules and the safety defaults as Markdown tables, straight from the source,
// so the documents in docs/ never drift from the code.
// Usage: npx vite-node scripts/docs-rules.mjs [rules|safety]
import { RULES } from '../src/features/design/rules.ts';
import { SAFETY_DEFAULTS, SAFETY_DEFAULT_INFO, NOT_ASSESSED } from '../src/features/safety/assess.ts';

const which = process.argv.slice(2).find((a) => !a.startsWith('-')) ?? 'rules';
const esc = (s) => String(s).replace(/\|/g, '\|');

if (which === 'rules') {
  const order = { hard: 0, strong: 1, preference: 2 };
  const rows = [...RULES].sort((a, b) => order[a.severity] - order[b.severity]);
  console.log('| Rule | Id | Severity | Threshold or source | Needs floor grid |');
  console.log('| --- | --- | --- | --- | --- |');
  for (const r of rows) console.log(`| ${esc(r.name)} | \`${r.id}\` | ${r.severity} | ${esc(r.source)} | ${r.costly ? 'yes' : 'no'} |`);
} else if (which === 'safety') {
  const groups = { fire: 'Escape routes and fire planning', access: 'Accessibility', sim: 'Evacuation simulation' };
  for (const [g, title] of Object.entries(groups)) {
    console.log(`\n### ${title}\n`);
    console.log('| Setting | Default | Why |');
    console.log('| --- | --- | --- |');
    for (const [k, info] of Object.entries(SAFETY_DEFAULT_INFO)) {
      if (info.group !== g) continue;
      console.log(`| ${esc(info.label)} (\`${k}\`) | ${SAFETY_DEFAULTS[k]} ${esc(info.unit)} | ${esc(info.why)} |`);
    }
  }
  console.log('\n### Not assessed\n');
  for (const n of NOT_ASSESSED) console.log(`- ${n}`);
} else {
  console.error('Usage: npx vite-node scripts/docs-rules.mjs [rules|safety]');
  process.exit(1);
}
