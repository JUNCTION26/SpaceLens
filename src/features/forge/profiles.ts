// Named 2D outlines for extruded parts. A model (or a template) says `style: "heart"` and gets a
// clean, many-point outline instead of spending tokens on coordinates. Every outline is in a unit
// box (x in [-0.5, 0.5], y in [0, 1]); the renderer scales it to the part's size anyway.

type Pt = [number, number];

const ring = (n: number, f: (t: number) => Pt): Pt[] => Array.from({ length: n }, (_, i) => f((i / n) * Math.PI * 2));

/** Top edge from right to left over a flat bottom: closes a panel whose top follows `top(u)` (u 0..1 left to right). */
function topped(top: (u: number) => number, n = 48): Pt[] {
  const pts: Pt[] = [[-0.5, 0], [0.5, 0]];
  for (let i = 0; i <= n; i++) { const u = 1 - i / n; pts.push([u - 0.5, top(u)]); }
  return pts;
}

const heart = (): Pt[] => ring(56, (t) => [16 * Math.sin(t) ** 3 / 34, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t) + 17) / 30]);

function piano(): Pt[] {
  // Grand piano case in plan: keyboard along the front (y = 1), straight bass side on the left,
  // the curved bentside on the right narrowing into a rounded tail.
  return [[-0.5, 1], [0.5, 1], [0.5, 0.8], [0.46, 0.66], [0.36, 0.55], [0.22, 0.45], [0.12, 0.34], [0.07, 0.22], [0.02, 0.1], [-0.08, 0.02], [-0.22, 0], [-0.36, 0.01], [-0.46, 0.05], [-0.5, 0.14]];
}

export const PROFILE_PRESETS: Record<string, () => Pt[]> = {
  rect: () => [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]],
  rounded: () => ring(48, (t) => { const c = Math.cos(t), s = Math.sin(t); const e = 0.25; return [0.5 * Math.sign(c) * Math.abs(c) ** e, 0.5 + 0.5 * Math.sign(s) * Math.abs(s) ** e]; }),
  arch: () => topped((u) => 0.72 + 0.28 * Math.sin(Math.PI * u) ** 0.8),
  scallop: () => topped((u) => 0.74 + 0.2 * Math.sin(Math.PI * u) ** 0.8 + 0.06 * Math.abs(Math.sin(Math.PI * u * 7)), 84),
  wave: () => topped((u) => 0.85 + 0.15 * Math.cos(Math.PI * 2 * 1.5 * (u - 0.5)), 60),
  crown: () => topped((u) => { const k = Math.abs(((u * 5) % 1) - 0.5) * 2; return 0.62 + 0.38 * (1 - k) * (0.75 + 0.25 * Math.sin(Math.PI * u)); }, 80),
  cloud: () => topped((u) => 0.7 + 0.14 * Math.sin(Math.PI * u) + 0.16 * Math.abs(Math.sin(Math.PI * u * 3.5)) ** 0.6, 84),
  shell: () => topped((u) => 0.45 + 0.55 * Math.sin(Math.PI * u) ** 0.7 - 0.05 * Math.abs(Math.sin(Math.PI * u * 9)), 90),
  house: () => [[-0.5, 0], [0.5, 0], [0.5, 0.62], [0, 1], [-0.5, 0.62]],
  shield: () => [[0, 0], [0.32, 0.12], [0.48, 0.42], [0.5, 1], [-0.5, 1], [-0.48, 0.42], [-0.32, 0.12]],
  heart,
  star: () => ring(10, (t) => { const r = (Math.round(t / (Math.PI / 5)) % 2 ? 0.2 : 0.5); return [r * Math.sin(t), 0.5 + r * Math.cos(t)]; }),
  round: () => ring(64, (t) => [0.5 * Math.sin(t), 0.5 + 0.5 * Math.cos(t)]),
  oval: () => ring(64, (t) => [0.5 * Math.sin(t), 0.5 + 0.5 * Math.cos(t)]),
  semicircle: () => [[-0.5, 0], ...Array.from({ length: 33 }, (_, i) => { const a = Math.PI - (i / 32) * Math.PI; return [0.5 * Math.cos(a), Math.sin(a)] as Pt; }).reverse()],
  'd-shape': () => [[-0.5, 0], [0.5, 0], ...Array.from({ length: 33 }, (_, i) => { const a = (i / 32) * Math.PI; return [0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a) ** 0.6] as Pt; }).slice(1, -1), [-0.5, 1]].map(([x, y]) => [x, y] as Pt),
  kidney: () => ring(64, (t) => { const x = 0.5 * Math.sin(t), y = 0.5 + 0.5 * Math.cos(t); return [x, y - 0.22 * Math.max(0, Math.cos(t)) * (1 - 4 * x * x)]; }),
  boat: () => ring(64, (t) => { const x = 0.5 * Math.sin(t); return [x, 0.5 + 0.5 * Math.cos(t) * (0.55 + 0.45 * (1 - 4 * x * x))]; }),
  hexagon: () => ring(6, (t) => [0.5 * Math.sin(t + Math.PI / 6), 0.5 + 0.5 * Math.cos(t + Math.PI / 6)]),
  octagon: () => ring(8, (t) => [0.5 * Math.sin(t + Math.PI / 8), 0.5 + 0.5 * Math.cos(t + Math.PI / 8)]),
  'l-shape': () => [[-0.5, 0], [0.5, 0], [0.5, 1], [0.12, 1], [0.12, 0.42], [-0.5, 0.42]],
  'u-shape': () => [[-0.5, 0], [0.5, 0], [0.5, 1], [0.22, 1], [0.22, 0.4], [-0.22, 0.4], [-0.22, 1], [-0.5, 1]],
  piano,
  surfboard: () => ring(64, (t) => [0.5 * Math.sin(t) * (0.6 + 0.4 * Math.cos(t / 2) ** 2), 0.5 + 0.5 * Math.cos(t)]),
};

export const PROFILE_STYLES = Object.keys(PROFILE_PRESETS);

/** A preset outline by (loose) name, or undefined. */
export function presetProfile(style: unknown): Pt[] | undefined {
  if (typeof style !== 'string') return undefined;
  const k = style.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-?(shaped|shape|top|headboard|outline)$/, '').replace(/^d$/, 'd-shape').replace(/^l$/, 'l-shape').replace(/^u$/, 'u-shape');
  const key = PROFILE_PRESETS[k] ? k : k === 'circle' ? 'round' : k === 'grand-piano' ? 'piano' : k === 'scalloped' ? 'scallop' : k === 'arched' ? 'arch' : k === 'wavy' ? 'wave' : k === 'hearts' ? 'heart' : k === 'rectangle' ? 'rect' : undefined;
  return key ? PROFILE_PRESETS[key]().map(([x, y]) => [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000] as Pt) : undefined;
}
