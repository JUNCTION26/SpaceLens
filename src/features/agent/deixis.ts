// Turning the person's sketches into geometry, so "put the sofa here" or "a wall here" has a
// place, a size and a direction. Pure functions, plan metres.
import { dist } from '../../core/geometry';
import type { SketchMark, Vec2 } from '../../core/types';

export interface MarkGeometry {
  centroid: Vec2;
  bbox: { minX: number; minY: number; maxX: number; maxY: number; w: number; h: number };
  /** First to last point. */
  start: Vec2;
  end: Vec2;
  /** Unit direction start -> end, or null for a dot or a closed loop. */
  dir: Vec2 | null;
  /** Angle of `dir` in radians (atan2 on the plan), 0 when there is no direction. */
  angle: number;
  /** Path length along the points. */
  lengthM: number;
  /** End close to start: a circle or loop around something. */
  closed: boolean;
  /** Nearly straight line, long enough to mean a wall or an edge. */
  straight: boolean;
}

export function markGeometry(m: Pick<SketchMark, 'kind' | 'points' | 'w' | 'd'>): MarkGeometry | null {
  const pts = m.points;
  if (!pts.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, L = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    if (i) L += dist(pts[i - 1], p);
  }
  if (m.kind === 'ghost' && pts.length === 1 && m.w && m.d) {
    const r = Math.max(m.w, m.d) / 2;
    minX -= r; maxX += r; minY -= r; maxY += r;
  }
  const start = pts[0], end = pts[pts.length - 1];
  const chord = dist(start, end);
  const closed = m.kind === 'circle' || m.kind === 'rect' || m.kind === 'zone' || (pts.length > 4 && L > 0.6 && chord < Math.max(0.25, L * 0.2));
  // Closed shapes: the centre of the box is a steadier "here" than the mean of uneven samples.
  const centroid = closed || m.kind === 'ghost'
    ? { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
    : { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const dir = !closed && chord > 0.05 ? { x: (end.x - start.x) / chord, y: (end.y - start.y) / chord } : null;
  const straight = !closed && chord > 0.5 && chord >= L * 0.9;
  if (pts.length === 1) { centroid.x = start.x; centroid.y = start.y; }
  return {
    centroid, start, end, dir, angle: dir ? Math.atan2(dir.y, dir.x) : 0, lengthM: L, closed, straight,
    bbox: { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY },
  };
}

/** Words that point at the latest sketch. */
export const DEICTIC = /\b(here|there|this|that|these|those|där|här|denna|den här|det här)\b/i;
export const refersToSketch = (text: string) => DEICTIC.test(text);

/** Classify a freehand stroke the person just drew: closed loop -> circle, otherwise stroke. */
export function classifyStroke(points: Vec2[]): SketchMark['kind'] {
  const g = markGeometry({ kind: 'stroke', points });
  return g?.closed ? 'circle' : 'stroke';
}

/** Drop points closer than `minM` to the previous kept point (keeps the last). */
export function simplify(points: Vec2[], minM = 0.03): Vec2[] {
  if (points.length < 3) return points.slice();
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) if (dist(out[out.length - 1], points[i]) >= minM) out.push(points[i]);
  out.push(points[points.length - 1]);
  return out;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Compact text for the model: where a mark is and what shape it has. */
export function describeMark(m: SketchMark, ref: string): Record<string, unknown> {
  const g = markGeometry(m);
  const o: Record<string, unknown> = { ref, by: m.by, kind: m.kind };
  if (!g) return o;
  o.centre = [r2(g.centroid.x), r2(g.centroid.y)];
  o.size = [r2(g.bbox.w), r2(g.bbox.h)];
  if (g.straight) { o.line = [[r2(g.start.x), r2(g.start.y)], [r2(g.end.x), r2(g.end.y)]]; o.lengthM = r2(g.lengthM); }
  else if (g.dir) o.dirDeg = Math.round((g.angle * 180) / Math.PI);
  if (g.closed) o.closed = true;
  if (m.text) o.text = m.text;
  return o;
}
