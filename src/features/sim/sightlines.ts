import { add, itemCorners, mul, openingSegment, sub, cross } from '../../core/geometry';
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';

export const EYE_M = 1.2;
export interface Sightline { a: Vec2; b: Vec2; visible: boolean }

/** Parameter t in [0,1] along p->q where it first hits segment a-b, or null. */
function hit(p: Vec2, q: Vec2, a: Vec2, b: Vec2): number | null {
  const r = sub(q, p), s = sub(b, a), den = cross(r, s);
  if (Math.abs(den) < 1e-12) return null;
  const t = cross(sub(a, p), s) / den, u = cross(sub(a, p), r) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

/** Rays from the viewpoint to every opening and to 72 directions; tall furniture and walls block. */
export function castSightlines(model: SpaceModel, furniture: FurnitureItem[], from: Vec2, excludeId?: string): Sightline[] {
  const walls: [Vec2, Vec2][] = [];
  for (const s of model.spaces) s.polygon.forEach((p, i) => walls.push([p, s.polygon[(i + 1) % s.polygon.length]]));
  const blockers: [Vec2, Vec2][] = [];
  for (const f of furniture) {
    if (f.id === excludeId || f.h <= EYE_M) continue;
    const c = itemCorners(f); c.forEach((p, i) => blockers.push([p, c[(i + 1) % 4]]));
  }
  const firstHit = (to: Vec2, segs: [Vec2, Vec2][]) => { let m = Infinity; for (const [a, b] of segs) { const t = hit(from, to, a, b); if (t !== null && t > 1e-6 && t < m) m = t; } return m; };
  const out: Sightline[] = [];
  for (const o of model.openings) {
    const s = model.spaces.find((x) => x.id === o.spaceId); if (!s) continue;
    const seg = openingSegment(s, o), target = add(seg.c, mul(seg.inward, 0.02));
    const tw = firstHit(target, walls), tf = firstHit(target, blockers);
    out.push({ a: from, b: seg.c, visible: tw > 1 && tf > 1 });
  }
  for (let k = 0; k < 72; k++) {
    const ang = (k * Math.PI * 2) / 72, far = add(from, { x: Math.cos(ang) * 50, y: Math.sin(ang) * 50 });
    const tw = Math.min(firstHit(far, walls), 1), tf = firstHit(far, blockers);
    const t = Math.min(tw, tf);
    out.push({ a: from, b: add(from, mul(sub(far, from), t)), visible: tf >= tw });
  }
  return out;
}
