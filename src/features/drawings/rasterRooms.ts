/**
 * Scanned or photographed plans have no drawing lines to read. A vision model proposes room
 * outlines and labels; the person confirms them; this turns the confirmed outlines into a model
 * marked as photo-inferred. Sizes come from printed room areas (when the model read them) or
 * from the scale the person set.
 */
import type { Evidence, Space, SpaceModel, Vec2 } from '../../core/types';
import type { RoomReport } from './toBuilding';
import { purposeOf } from './purpose';

export interface RoomProposal {
  name: string;
  /** Printed net area read from the sheet, m², when there is one. */
  areaM2?: number;
  /** Outline in normalised image coordinates (0..1). */
  polygon: Vec2[];
}

export const PROPOSAL_SCHEMA = {
  type: 'OBJECT',
  properties: {
    rooms: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' },
          areaM2: { type: 'NUMBER' },
          polygon: { type: 'ARRAY', items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] } },
        },
        required: ['name', 'polygon'],
      },
    },
  },
  required: ['rooms'],
};

export const PROPOSAL_PROMPT = 'This is a floor plan. List every room. For each room give its printed name, its printed net area in m² if one is written inside it (omit otherwise, never estimate), and its outline along the inner wall faces as polygon corners in normalised image coordinates (x, y from 0 to 1, origin top-left), clockwise.';

const shoelace = (p: Vec2[]) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return s / 2; };

export function cleanProposals(raw: { rooms?: Array<{ name?: string; areaM2?: number; polygon?: Vec2[] }> }): RoomProposal[] {
  const clamp = (v: number) => Math.min(1, Math.max(0, Number(v) || 0));
  return (raw.rooms ?? []).map((r) => ({
    name: String(r.name ?? 'Room').slice(0, 40),
    areaM2: typeof r.areaM2 === 'number' && r.areaM2 > 0.5 && r.areaM2 < 2000 ? r.areaM2 : undefined,
    polygon: (r.polygon ?? []).map((p) => ({ x: clamp(p.x), y: clamp(p.y) })),
  })).filter((r) => r.polygon.length >= 3 && Math.abs(shoelace(r.polygon)) > 1e-4);
}

/**
 * Metres per image pixel from printed areas: the median of sqrt(printed / outline area).
 * Needs two rooms with a printed area.
 */
export function scaleFromAreas(rooms: RoomProposal[], pxW: number, pxH: number): number | null {
  const k = rooms.filter((r) => r.areaM2).map((r) => {
    const px = Math.abs(shoelace(r.polygon.map((p) => ({ x: p.x * pxW, y: p.y * pxH }))));
    return Math.sqrt(r.areaM2! / px);
  }).sort((a, b) => a - b);
  return k.length >= 2 ? k[Math.floor(k.length / 2)] : null;
}

export function buildFromProposals(rooms: RoomProposal[], o: { pxW: number; pxH: number; mPerPx: number; imageUrl?: string; name: string; page: number; now?: number }): { model: SpaceModel; rooms: RoomReport[] } {
  const now = o.now ?? Date.now();
  const toPx = (p: Vec2) => ({ x: p.x * o.pxW * o.mPerPx, y: p.y * o.pxH * o.mPerPx });
  const all = rooms.flatMap((r) => r.polygon.map(toPx));
  const minX = Math.min(...all.map((p) => p.x)), minY = Math.min(...all.map((p) => p.y));
  const evidence: Evidence[] = [];
  const reports: RoomReport[] = [];
  const spaces: Space[] = rooms.map((r, i) => {
    let norm = r.polygon;
    if (shoelace(norm) < 0) norm = [...norm].reverse();
    const poly = norm.map(toPx).map((p) => ({ x: Math.round((p.x - minX) * 1000) / 1000, y: Math.round((p.y - minY) * 1000) / 1000 }));
    const area = Math.abs(shoelace(poly));
    const id = `room-${i + 1}`;
    const xs = norm.map((p) => p.x), ys = norm.map((p) => p.y);
    const ev: Evidence = { id: `ev-${id}`, kind: 'image', label: `${o.name}: ${r.name} as proposed by the vision model and confirmed by you`, imageUrl: o.imageUrl, page: o.page, bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)], note: r.areaM2 ? `Printed ${r.areaM2} m², outline ${area.toFixed(2)} m².` : `Outline ${area.toFixed(2)} m².`, createdAt: now };
    evidence.push(ev);
    const errorPct = r.areaM2 ? ((area - r.areaM2) / r.areaM2) * 100 : undefined;
    const p = purposeOf(r.name);
    reports.push({ spaceId: id, name: r.name, purpose: p?.purpose, printedArea: r.areaM2, computedArea: Math.round(area * 100) / 100, errorPct: errorPct != null ? Math.round(errorPct * 10) / 10 : undefined, status: 'estimated', windows: 0, doors: 0, outline: norm, centre: poly.reduce((s, q) => ({ x: s.x + q.x / poly.length, y: s.y + q.y / poly.length }), { x: 0, y: 0 }) });
    return { id, name: r.name, purpose: p?.purpose, polygon: poly, walls: poly.map(() => ({ thicknessM: 0.1, sourceKind: 'photo-inferred' as const, status: 'estimated' as const })) };
  });
  const model: SpaceModel = {
    id: `drawing-${now}`, name: o.name.replace(/\.(png|jpe?g)$/i, ''), version: 1, units: 'm', ceilingM: 2.6,
    sourceLabel: `Picture: ${o.name}, rooms proposed by a vision model`, spaces, openings: [], furniture: [], measurements: [], evidence,
  };
  return { model, rooms: reports };
}
