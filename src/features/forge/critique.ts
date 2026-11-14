// A render-free self-check that repairs the mistakes fast models make most, without another call:
// - a lone thin rod poking far out of the object (a rail drawn on the wrong axis) is dropped, since
//   it would otherwise set the bounding box and squash everything else when fitted;
// - a body that swallows its own legs (a piano case drawn from the floor) is lifted onto them.

import type { ObjectPart, ObjectSpec } from '../../core/types';
import { partBounds, type Bounds } from './spec';

const LEGGY = /\b(leg|legs|caster|castor|wheel|foot|feet|lyre|pedal)/i;

function isThin(p: ObjectPart): boolean {
  const s = [...p.size].sort((a, b) => a - b);
  return s[0] < 0.06 && s[2] / Math.max(s[1], 1e-3) > 10;
}

function unionBounds(bs: Bounds[]): Bounds {
  const out: Bounds = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  for (const b of bs) for (let i = 0; i < 3; i++) { out.min[i] = Math.min(out.min[i], b.min[i]); out.max[i] = Math.max(out.max[i], b.max[i]); }
  return out;
}

/** Thin parts that alone stick far out of the rest of the object. */
export function strayRods(parts: readonly ObjectPart[]): number[] {
  if (parts.length < 5) return [];
  const bs = parts.map(partBounds);
  const coreIdx = parts.map((p, i) => (isThin(p) ? -1 : i)).filter((i) => i >= 0);
  if (coreIdx.length < 2) return [];
  const core = unionBounds(coreIdx.map((i) => bs[i]));
  const out: number[] = [];
  parts.forEach((p, i) => {
    // Props and stays legitimately reach out alone (a piano lid prop).
    if (!isThin(p) || /prop|stay|strut/i.test(p.name)) return;
    for (let a = 0; a < 3; a++) {
      const dim = core.max[a] - core.min[a];
      for (const side of [1, -1]) {
        const beyond = (b: Bounds) => (side > 0 ? b.max[a] - core.max[a] : core.min[a] - b.min[a]);
        const pr = beyond(bs[i]);
        if (pr < Math.max(0.12, 0.2 * dim)) continue;
        const company = bs.filter((b, j) => j !== i && beyond(b) > pr * 0.5).length;
        if (company === 0 && !out.includes(i)) out.push(i);
      }
    }
  });
  return out;
}

/** Repair the spec in object space (before fitting). Returns what was changed. */
export function critique(spec: ObjectSpec): { spec: ObjectSpec; fixes: string[] } {
  const fixes: string[] = [];
  let parts = spec.parts;
  const stray = strayRods(parts);
  if (stray.length) {
    fixes.push(`dropped stray ${stray.map((i) => parts[i].name).join(', ')}`);
    parts = parts.filter((_, i) => !stray.includes(i));
  }
  // Bodies that start at the floor around two or more legs sit on the legs instead.
  const legs = parts.filter((p) => LEGGY.test(p.name) || p.shape === 'leg');
  if (legs.length >= 2) {
    const lb = legs.map(partBounds);
    const floor = Math.min(...parts.map((p) => partBounds(p).min[1]));
    parts = parts.map((p) => {
      if (legs.includes(p) || p.rot && p.shape !== 'extrude') return p;
      const b = partBounds(p);
      if (b.min[1] - floor > 0.02) return p;
      const inside = lb.filter((l) => l.min[0] >= b.min[0] - 0.01 && l.max[0] <= b.max[0] + 0.01 && l.min[2] >= b.min[2] - 0.01 && l.max[2] <= b.max[2] + 0.01 && l.max[1] < b.max[1] - 0.05);
      if (inside.length < 2) return p;
      const top = Math.max(...inside.map((l) => l.max[1]));
      const h = b.max[1] - top;
      if (h < (b.max[1] - b.min[1]) * 0.2) return p;
      fixes.push(`lifted ${p.name} onto its legs`);
      const k = h / (b.max[1] - b.min[1]);
      // Axis-aligned or extruded upright: scale the vertical extent, whichever local axis carries it.
      const vert = p.rot ? 2 : 1;
      const size = [...p.size] as [number, number, number];
      size[vert] = size[vert] * k;
      return { ...p, size, pos: [p.pos[0], top + h / 2, p.pos[2]] as [number, number, number] };
    });
  }
  return { spec: fixes.length ? { ...spec, parts } : spec, fixes };
}
