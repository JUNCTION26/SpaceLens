// Scans relative imports under src/ and fails on layering violations it can prove.
//
// Enforced rules
//   1. core never imports from features or ui (one listed exception, see CORE_UI_ALLOW).
//   2. The referee's decision code (referee/validate.ts, referee/geom.ts) imports only core types
//      and its own geometry file. It never imports the solver, the rules or any other feature.
//   3. Neither core/geometry.ts nor core/types.ts imports anything outside core.
//
// Reported, not enforced (the codebase has real cycles; see docs/ARCHITECTURE.md)
//   - the cross-feature import pairs and the pairs that import each other.
//
// Run: npm run check:boundaries [-- --pairs]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';

const SRC = resolve('src');
const CORE_UI_ALLOW = new Set(['src/core/ai/AiStatus.tsx']); // a status chip that lives beside the router
const REFEREE_PURE = new Set(['src/features/referee/validate.ts', 'src/features/referee/geom.ts']);

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const isCode = (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f);
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g;

const area = (abs) => {
  const parts = relative(SRC, abs).split(sep);
  if (parts[0] === 'features') return { layer: 'features', name: parts[1], file: parts.join('/') };
  return { layer: parts[0], file: parts.join('/') };
};

const violations = [];
const pairs = new Map();
for (const file of walk(SRC).filter(isCode)) {
  const from = area(file);
  const rel = relative(process.cwd(), file).split(sep).join('/');
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith('.')) continue;
    const target = resolve(dirname(file), spec);
    const to = area(target);
    const bad = (why) => violations.push(`${rel}: imports '${spec}' (${why})`);
    if (from.layer === 'core' && (to.layer === 'features' || to.layer === 'ui') && !CORE_UI_ALLOW.has(rel)) bad('core must not depend on features or ui');
    if (REFEREE_PURE.has(rel)) {
      const ok = to.layer === 'core' ? /core\/types$/.test(to.file.replace(/\.tsx?$/, '')) : to.layer === 'features' && to.name === 'referee';
      if (!ok) bad('referee decision code may import only core types and its own files');
    }
    if (rel === 'src/core/geometry.ts' || rel === 'src/core/types.ts') if (to.layer !== 'core') bad('core base files stay self-contained');
    if (from.layer === 'features' && to.layer === 'features' && from.name !== to.name) {
      const key = `${from.name} -> ${to.name}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
}

const mutual = [...pairs.keys()].filter((k) => { const [a, b] = k.split(' -> '); return a < b && pairs.has(`${b} -> ${a}`); });
console.log(`Cross-feature import pairs: ${pairs.size}`);
console.log(`Feature pairs that import each other: ${mutual.length}${mutual.length ? ` (${mutual.map((k) => k.replace(' -> ', ' <-> ')).join(', ')})` : ''}`);
if (process.argv.includes('--pairs')) for (const [k, v] of [...pairs].sort()) console.log(`  ${k} (${v})`);
if (violations.length) {
  console.error(`
${violations.length} boundary violation(s):`);
  for (const v of [...new Set(violations)]) console.error(`  ${v}`);
  process.exit(1);
}
console.log('Boundaries OK.');
