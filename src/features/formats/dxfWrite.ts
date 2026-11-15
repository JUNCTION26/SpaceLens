/**
 * ASCII DXF writer (R12-compatible entities: LINE, ARC, TEXT and heavy POLYLINE only), in metres.
 * Plan y points down, DXF y points up, so every y is negated and the plan keeps its look.
 * Layers: WALLS, DOORS, WINDOWS, FURNITURE, DIMENSIONS, TEXT, plus ROOMS for the room outlines
 * (closed polylines on the wall centre lines) so other tools can find each room and its area.
 */
import type { Opening, Space, SpaceModel, Vec2 } from '../../core/types';

const LAYERS: Array<[string, number]> = [
  ['WALLS', 7], ['DOORS', 3], ['WINDOWS', 5], ['FURNITURE', 30], ['DIMENSIONS', 2], ['TEXT', 1], ['ROOMS', 8],
];

const f = (n: number) => (Math.abs(n) < 5e-7 ? 0 : n).toFixed(4);
const area = (p: Vec2[]) => p.reduce((s, a, i) => { const b = p[(i + 1) % p.length]; return s + (a.x * b.y - b.x * a.y); }, 0) / 2;
/** DXF text is ASCII in R12: other characters use the \U+XXXX escape. */
const txt = (s: string) => Array.from(s.replace(/[\r\n]+/g, ' ')).map((c) => {
  const cp = c.codePointAt(0)!;
  return cp >= 32 && cp < 127 ? c : `\\U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}).join('');

export function modelToDxf(model: SpaceModel): string {
  const out: Array<string | number> = [];
  const g = (...a: Array<string | number>) => { out.push(...a); };
  const P = (p: Vec2): [string, string] => [f(p.x), f(-p.y)];

  g(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSUNITS', 70, 6, 0, 'ENDSEC');
  g(0, 'SECTION', 2, 'TABLES');
  g(0, 'TABLE', 2, 'LTYPE', 70, 1, 0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0, 0, 'ENDTAB');
  g(0, 'TABLE', 2, 'LAYER', 70, LAYERS.length);
  for (const [n, c] of LAYERS) g(0, 'LAYER', 2, n, 70, 0, 62, c, 6, 'CONTINUOUS');
  g(0, 'ENDTAB', 0, 'ENDSEC');
  g(0, 'SECTION', 2, 'ENTITIES');

  const line = (layer: string, a: Vec2, b: Vec2) => { const [ax, ay] = P(a), [bx, by] = P(b); g(0, 'LINE', 8, layer, 10, ax, 20, ay, 30, 0, 11, bx, 21, by, 31, 0); };
  const poly = (layer: string, pts: Vec2[]) => {
    g(0, 'POLYLINE', 8, layer, 66, 1, 70, 1, 10, 0, 20, 0, 30, 0);
    for (const p of pts) { const [x, y] = P(p); g(0, 'VERTEX', 8, layer, 10, x, 20, y, 30, 0); }
    g(0, 'SEQEND', 8, layer);
  };
  const text = (layer: string, at: Vec2, h: number, s: string) => { const [x, y] = P(at); g(0, 'TEXT', 8, layer, 10, x, 20, y, 30, 0, 40, f(h), 1, txt(s), 50, 0); };
  const arc = (layer: string, c: Vec2, r: number, a0: number, a1: number) => {
    const [x, y] = P(c);
    g(0, 'ARC', 8, layer, 10, x, 20, y, 30, 0, 40, f(r), 50, f(a0), 51, f(a1));
  };

  const frame = (sp: Space, i: number) => {
    const p = sp.polygon[i], q = sp.polygon[(i + 1) % sp.polygon.length];
    if (!p || !q) return null;
    const L = Math.hypot(q.x - p.x, q.y - p.y);
    if (L < 1e-9) return null;
    const ux = (q.x - p.x) / L, uy = (q.y - p.y) / L;
    // Inward normal: the room lies to the left of travel (in plan axes) when the area is positive.
    const s = area(sp.polygon) >= 0 ? 1 : -1;
    return { p, q, L, u: { x: ux, y: uy }, n: { x: -uy * s, y: ux * s }, t: sp.walls[i]?.thicknessM ?? 0.12 };
  };
  const at = (p: Vec2, u: Vec2, a: number, n: Vec2, b: number): Vec2 => ({ x: p.x + u.x * a + n.x * b, y: p.y + u.y * a + n.y * b });

  for (const sp of model.spaces) {
    if (sp.polygon.length < 3) continue;
    poly('ROOMS', sp.polygon);
    sp.polygon.forEach((_, i) => {
      const w = frame(sp, i); if (!w) return;
      const h = w.t / 2;
      line('WALLS', at(w.p, w.u, 0, w.n, h), at(w.p, w.u, w.L, w.n, h));
      line('WALLS', at(w.p, w.u, 0, w.n, -h), at(w.p, w.u, w.L, w.n, -h));
      // length as text just outside the wall, at its midpoint
      text('DIMENSIONS', at(w.p, w.u, w.L / 2, w.n, -(h + 0.12)), 0.1, `${w.L.toFixed(2)} m`);
    });
    const c = sp.polygon.reduce((s, p) => ({ x: s.x + p.x / sp.polygon.length, y: s.y + p.y / sp.polygon.length }), { x: 0, y: 0 });
    text('TEXT', c, 0.2, sp.name);
    text('TEXT', { x: c.x, y: c.y + 0.3 }, 0.15, `${Math.abs(area(sp.polygon)).toFixed(1)} m2`);
  }

  const opening = (o: Opening) => {
    const sp = model.spaces.find((s) => s.id === o.spaceId);
    const w = sp && frame(sp, o.wallIndex);
    if (!sp || !w) return;
    const a = o.offsetM - o.widthM / 2, b = o.offsetM + o.widthM / 2;
    if (o.kind === 'window') {
      for (const k of [-1, 0, 1]) line('WINDOWS', at(w.p, w.u, a, w.n, (k * w.t) / 2), at(w.p, w.u, b, w.n, (k * w.t) / 2));
      line('WINDOWS', at(w.p, w.u, a, w.n, -w.t / 2), at(w.p, w.u, a, w.n, w.t / 2));
      line('WINDOWS', at(w.p, w.u, b, w.n, -w.t / 2), at(w.p, w.u, b, w.n, w.t / 2));
      return;
    }
    // door or open gap: jamb marks across the wall
    line('DOORS', at(w.p, w.u, a, w.n, -w.t / 2), at(w.p, w.u, a, w.n, w.t / 2));
    line('DOORS', at(w.p, w.u, b, w.n, -w.t / 2), at(w.p, w.u, b, w.n, w.t / 2));
    if (o.kind !== 'door' || o.swing === 'none') return;
    const side = o.swing === 'in' ? 1 : -1;
    const hingeAt = o.hinge === 'start' ? a : b;
    const toward = o.hinge === 'start' ? 1 : -1;
    const H = at(w.p, w.u, hingeAt, w.n, 0);
    const leaf = { x: w.n.x * side, y: w.n.y * side };
    line('DOORS', H, { x: H.x + leaf.x * o.widthM, y: H.y + leaf.y * o.widthM });
    // angles in DXF axes (y up), counter-clockwise from start to end
    const closed = Math.atan2(-w.u.y * toward, w.u.x * toward);
    const open = Math.atan2(-leaf.y, leaf.x);
    let d = open - closed; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
    const [s0, s1] = d >= 0 ? [closed, open] : [open, closed];
    const deg = (r: number) => ((r * 180) / Math.PI + 360) % 360;
    arc('DOORS', H, o.widthM, deg(s0), deg(s1));
  };
  model.openings.forEach(opening);

  for (const it of model.furniture) {
    const c = Math.cos(it.rotation), s = Math.sin(it.rotation);
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const x = (a * it.w) / 2, y = (b * it.d) / 2;
      return { x: it.x + x * c - y * s, y: it.y + x * s + y * c };
    });
    poly('FURNITURE', pts);
  }

  g(0, 'ENDSEC', 0, 'EOF');
  return out.join('\n') + '\n';
}
