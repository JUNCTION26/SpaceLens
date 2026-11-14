// Dev-only stage for screenshots of generated objects.
// http://localhost:5180/scripts/forge-shot.html?i=0            one example
// ...?i=all                                                   every example in a grid
// ...?i=9&open=1                                              moving parts open
// ...?i=1&w=1.6&d=0.8&h=0.7                                   refitted to a size
// ...?inject=1                                                window.__FORGE_SPEC (set by forge-shot.mjs --specs)
import { createRoot } from 'react-dom/client';
import { ForgeShot } from '../src/features/forge/GeneratedMesh';
import { EXAMPLES } from '../src/features/forge/examples';
import { fitSpec } from '../src/features/forge/fit';
import type { ObjectSpec } from '../src/core/types';

const q = new URLSearchParams(location.search);
const i = q.get('i') ?? 'all';
const injected = (window as unknown as { __FORGE_SPEC?: ObjectSpec }).__FORGE_SPEC;
let specs = q.get('inject') && injected ? [injected] : i === 'all' ? EXAMPLES : i.split(',').map((k) => EXAMPLES[Number(k)]).filter(Boolean);
const w = Number(q.get('w')), d = Number(q.get('d')), h = Number(q.get('h'));
if (w && d && h) specs = specs.map((s) => fitSpec(s, { w, d, h }));
createRoot(document.getElementById('root')!).render(<ForgeShot specs={specs} open={Number(q.get('open') ?? 0)} />);
