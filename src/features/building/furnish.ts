// Furnish a whole floor with the single-room designer: each room is cut out as its own model,
// laid out from a brief that follows its purpose (rooms run side by side), and the furniture is
// moved back into building coordinates. With a model key each room goes through the full design
// pipeline (planner, solver, rules); without one, through the rule-based layout solver.
import { aiReady } from '../../core/ai';
import { area, centroid, pointInPolygon } from '../../core/geometry';
import type { FurnitureItem, Requirements, Space, SpaceModel, Vec2 } from '../../core/types';
import { compileIntent } from '../intent/compile';
import { purposeOf } from '../drawings/purpose';
import { buildDesignItems } from '../design/pipeline';
import { planProgram } from '../design/planner';
import { solveRoomAsync } from './solveAsync';
import { mergeFurniture, subModelFor } from './submodel';

export { mergeFurniture, subModelFor, type SubModel } from './submodel';

const KNOWN = new Set(['bedroom', 'living', 'kitchen', 'dining', 'workspace', 'office', 'meeting', 'reception', 'cafe', 'clinic', 'staff',
  'hall', 'hallway', 'entrance', 'study', 'phone', 'counter', 'storage', 'utility', 'balcony', 'bathroom', 'wc', 'stair']);

/**
 * What a room is for: its stated purpose when it is one we furnish, else read from its printed
 * name in any of the plan languages (Stanza, Zimmer, Chambre, Cucina, Küche, Bagno, Bad, Corridoio,
 * Soggiorno...). Trailing room numbers such as "5.02" are ignored.
 */
export function roomPurpose(space: Pick<Space, 'name' | 'purpose'>): string {
  const p = (space.purpose ?? '').toLowerCase();
  if (KNOWN.has(p)) return p;
  const name = space.name.replace(/[\s\d.,/-]+$/, '').trim();
  return purposeOf(name)?.purpose ?? purposeOf(space.name)?.purpose ?? p;
}

/** Why a room gets no furniture, in a few plain words (null when it gets a brief). */
export function skipReason(space: Space): string | null {
  if (defaultBrief(space)) return null;
  const p = roomPurpose(space);
  if (p === 'bathroom' || p === 'wc') return 'No bathroom fixtures yet';
  if (p === 'stair') return 'Stairs';
  if (area(space.polygon) < 4) return 'Too small';
  return 'Nothing to furnish';
}

/** A furnishing brief from a room's purpose and size; null for rooms left empty. */
export function defaultBrief(space: Space): string | null {
  const a = area(space.polygon);
  const p = roomPurpose(space);
  // rooms too small for the brief's main piece stay empty rather than failing to fit
  const min: Record<string, number> = { bedroom: 6, living: 8, kitchen: 4, dining: 5, office: 4, study: 4, meeting: 6, workspace: 8 };
  if (a < (min[p] ?? 0)) return null;
  const n = (per: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(a / per)));
  switch (p) {
    case 'bedroom': return a >= 12 ? 'bedroom with a double bed, wardrobe and two lamps' : 'bedroom with a bed, wardrobe and a desk';
    case 'living': return 'living room with a sofa, armchair, coffee table and rug';
    case 'kitchen': return `dining table for ${n(3.5, 2, 8)} people`;
    case 'dining': return `dining table for ${n(2.5, 4, 10)} people`;
    case 'workspace': return `office with ${n(6, 2, 12)} desks and chairs`;
    case 'office': return `office with ${n(8, 1, 3)} desk${a >= 16 ? 's' : ''} and a bookshelf`;
    case 'meeting': return `meeting room with a table for ${n(2.2, 4, 14)} people`;
    case 'reception': return 'reception with a desk and a sofa for waiting';
    case 'cafe': return `cafe with tables for ${n(1.5, 4, 60)} people`;
    case 'clinic': return 'clinic treatment room with a treatment bed, desk and two chairs';
    case 'staff': return `dining table for ${n(2.5, 2, 8)} people`;
    case 'hall': case 'hallway': case 'entrance': return a >= 4 ? 'shoe cabinet with seat and a plant' : null;
    case 'balcony': return a >= 3 ? 'small cafe table and two chairs' : null;
    case 'study': return 'office with a desk, an office chair and a bookshelf';
    case 'phone': return 'small desk and a desk chair';
    case 'counter': return 'counter and two bar stools';
    case 'storage': case 'utility': return a >= 3 ? 'storage cabinet' : null;
    default: return null;
  }
}

export type RoomStatus = 'waiting' | 'running' | 'done' | 'skipped' | 'failed';
export interface RoomProgress { spaceId: string; name: string; status: RoomStatus; items?: number; message?: string }

export interface FurnishOptions {
  onRoom?: (p: RoomProgress) => void;
  /** Rooms laid out at the same time (default 3). */
  parallel?: number;
  signal?: AbortSignal;
  seed?: number;
  timeBudgetMs?: number;
  /** Override the brief reader (defaults to compileIntent). */
  compile?: (brief: string, sub: SpaceModel) => Promise<Requirements>;
  /** Override the layout solver (defaults to generateLayouts). */
  solve?: (sub: SpaceModel, req: Requirements, brief?: string) => Promise<FurnitureItem[] | null>;
}

export interface FurnishResult { furniture: FurnitureItem[]; rooms: RoomProgress[] }

/** Lay out every room that has a brief. Returns the whole building's furniture. */
export async function furnishBuilding(model: SpaceModel, briefByRoom: Record<string, string> = {}, opts: FurnishOptions = {}): Promise<FurnishResult> {
  const compile = opts.compile ?? ((b: string, sub: SpaceModel) => compileIntent(b, sub));
  const online = aiReady();
  const seed = opts.seed ?? 1;
  // The solving runs in a worker, so the page keeps responding while a whole floor is furnished.
  const solve = opts.solve ?? (async (sub: SpaceModel, req: Requirements, brief?: string) => {
    if (online) {
      // the planner (a model call) decides the intent here; the exact solve happens in the worker
      const items = buildDesignItems(sub, req);
      if (items.length) {
        const program = await planProgram(sub, items, req, { brief, signal: opts.signal });
        const best = await solveRoomAsync({ kind: 'program', sub, req, seed, items, program });
        if (best?.length) return best;
      }
    }
    return solveRoomAsync({ kind: 'layout', sub, req, seed, timeBudgetMs: opts.timeBudgetMs ?? 1200 });
  });
  const progress: RoomProgress[] = model.spaces.map((s) => ({ spaceId: s.id, name: s.name, status: 'waiting' }));
  const emit = (i: number, patch: Partial<RoomProgress>) => { progress[i] = { ...progress[i], ...patch }; opts.onRoom?.({ ...progress[i] }); };
  const results = new Map<string, { items: FurnitureItem[]; offset: Vec2 }>();
  const jobs = model.spaces.map((s, i) => async () => {
    if (opts.signal?.aborted) return;
    const brief = briefByRoom[s.id] ?? defaultBrief(s);
    if (!brief) { emit(i, { status: 'skipped', message: skipReason(s) ?? 'Nothing to furnish' }); return; }
    const sub = subModelFor(model, s.id);
    if (!sub) { emit(i, { status: 'failed', message: 'Room not found' }); return; }
    emit(i, { status: 'running', message: brief });
    try {
      const req = await compile(brief, sub.model);
      const items = await solve(sub.model, req, brief);
      if (!items?.length) { emit(i, { status: 'failed', message: 'No layout fits this room' }); return; }
      results.set(s.id, { items, offset: sub.offset });
      emit(i, { status: 'done', items: items.length });
    } catch (e) {
      emit(i, { status: 'failed', message: (e as Error).message.slice(0, 80) });
    }
  });
  const width = Math.max(1, opts.parallel ?? 3);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => { while (next < jobs.length) await jobs[next++](); }));
  let furniture = model.furniture;
  for (const s of model.spaces) {
    const r = results.get(s.id);
    if (r) furniture = mergeFurniture({ ...model, furniture }, s.id, r.items, r.offset);
  }
  return { furniture, rooms: progress };
}

export interface BillLine { catalogId: string; name: string; category: string; qty: number; unitSek: number; totalSek: number; rooms: string[] }
export interface Bill { lines: BillLine[]; items: number; totalSek: number; byRoom: Array<{ spaceId: string; name: string; items: number; totalSek: number }> }

/** Whole-building bill of furniture: one line per product with quantities, rooms and totals. */
export function buildingBill(model: SpaceModel, furniture: FurnitureItem[] = model.furniture): Bill {
  const roomOf = (f: FurnitureItem) => model.spaces.find((s) => pointInPolygon(f, s.polygon));
  const lines = new Map<string, BillLine>();
  const byRoom = new Map<string, { spaceId: string; name: string; items: number; totalSek: number }>();
  for (const f of furniture) {
    const key = `${f.catalogId}|${f.name}`;
    const room = roomOf(f);
    const price = f.owned ? 0 : f.priceSek || 0;
    const l = lines.get(key) ?? { catalogId: f.catalogId, name: f.name, category: f.category, qty: 0, unitSek: price, totalSek: 0, rooms: [] };
    l.qty++; l.totalSek += price;
    if (room && !l.rooms.includes(room.name)) l.rooms.push(room.name);
    lines.set(key, l);
    if (room) {
      const r = byRoom.get(room.id) ?? { spaceId: room.id, name: room.name, items: 0, totalSek: 0 };
      r.items++; r.totalSek += price;
      byRoom.set(room.id, r);
    }
  }
  const sorted = [...lines.values()].sort((a, b) => b.totalSek - a.totalSek || a.name.localeCompare(b.name));
  return {
    lines: sorted, items: furniture.length, totalSek: sorted.reduce((s, l) => s + l.totalSek, 0),
    byRoom: model.spaces.map((s) => byRoom.get(s.id)).filter((x): x is NonNullable<typeof x> => !!x),
  };
}

/** Centre of a room in building coordinates (for labels and camera targets). */
export const roomCentre = (s: Space) => centroid(s.polygon);
