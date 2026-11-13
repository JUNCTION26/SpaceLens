import { bounds, signedArea, uid } from '../../core/geometry';
import { emptyModel } from '../../core/sample';
import type { Evidence, Measurement, Opening, Space, SpaceModel, Vec2, WallMeta } from '../../core/types';

export interface RoomDraft {
  polygon: Vec2[];
  walls: WallMeta[];
  openings: Omit<Opening, 'spaceId'>[];
  measurements: Measurement[];
  evidence: Evidence[];
}

/** Makes the polygon clockwise on screen, keeping walls aligned, and moves it to start at (ox, oy). */
export function normalise(d: RoomDraft, ox = 0, oy = 0): RoomDraft {
  let polygon = d.polygon, walls = d.walls;
  if (signedArea(polygon) < 0) {
    // Reverse vertex order; wall i (p[i]->p[i+1]) becomes a wall between the same two points.
    const n = polygon.length;
    polygon = [...polygon].reverse();
    walls = polygon.map((_, i) => d.walls[(2 * n - 2 - i) % n]);
    const remap = (wi: number) => (2 * n - 2 - wi) % n;
    d = { ...d, openings: d.openings.map((o) => ({ ...o, wallIndex: remap(o.wallIndex) })) };
    d = { ...d, measurements: d.measurements.map((m) => m.targetId?.startsWith('#') ? { ...m, targetId: `#${remap(Number(m.targetId.slice(1)))}` } : m) };
  }
  const b = bounds(polygon);
  polygon = polygon.map((p) => ({ x: +(p.x - b.minX + ox).toFixed(4), y: +(p.y - b.minY + oy).toFixed(4) }));
  return { ...d, polygon, walls };
}

/**
 * Builds a new model from drafts. Measurement targetIds written as `#i` are rewritten to the
 * real wall id. If `keep` is given, its spaces stay and the new room goes to the right.
 */
export function buildModel(drafts: RoomDraft[], opts: { name: string; ceilingM: number; sourceLabel: string; keep?: SpaceModel }): SpaceModel {
  const base = emptyModel(opts.name);
  const spaces: Space[] = opts.keep ? [...opts.keep.spaces] : [];
  const openings: Opening[] = opts.keep ? [...opts.keep.openings] : [];
  const measurements: Measurement[] = opts.keep ? [...opts.keep.measurements] : [];
  const evidence: Evidence[] = opts.keep ? [...opts.keep.evidence] : [];
  let ox = 0;
  if (spaces.length) ox = bounds(spaces.flatMap((s) => s.polygon)).maxX + 1;
  for (const raw of drafts) {
    const d = normalise(raw, ox, 0);
    const id = uid('sp');
    const ms = d.measurements.map((m) => m.targetId?.startsWith('#') ? { ...m, targetId: `${id}:${m.targetId.slice(1)}` } : m);
    const walls = d.walls.map((w, i) => {
      const m = ms.find((x) => x.targetId === `${id}:${i}`);
      return m ? { ...w, measurementId: m.id } : w;
    });
    spaces.push({ id, name: `Room ${spaces.length + 1}`, polygon: d.polygon, walls });
    openings.push(...d.openings.map((o) => ({ ...o, spaceId: id })));
    measurements.push(...ms);
    evidence.push(...d.evidence);
    ox = bounds(d.polygon).maxX + 1;
  }
  return {
    ...base,
    name: opts.keep ? opts.keep.name : opts.name,
    ceilingM: opts.ceilingM,
    sourceLabel: opts.sourceLabel,
    furniture: opts.keep ? opts.keep.furniture : [],
    spaces, openings, measurements, evidence,
    version: (opts.keep?.version ?? 0) + 1,
  };
}
