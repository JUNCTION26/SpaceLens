// Move-in day: can each item be carried in through the entrance and every door on the way to its room,
// and in which order should things arrive.
import { pointInPolygon, centroid } from '../../core/geometry';
import type { FurnitureItem, PassageResult, SpaceModel } from '../../core/types';
import { buildingRoutes } from '../building/connectivity';
import { testPassage } from '../sim/passage';
import { isRug } from '../sim/grid';

export type Verdict = 'fits' | 'tilt' | 'assemble' | 'wont';
export const VERDICT_LABEL: Record<Verdict, string> = { fits: 'Fits', tilt: 'Tilt', assemble: 'Assemble inside', wont: "Won't fit" };

export interface DoorStep { openingId: string; name: string; widthM: number; heightM: number; ok: boolean; result: PassageResult }
export interface MoveItem {
  id: string;
  name: string;
  verdict: Verdict;
  /** The door that decides the verdict: the first one that fails, else the narrowest. */
  tight: string;
  tightId: string | null;
  steps: DoorStep[];
  roomId: string | null;
  depth: number;
  flat: boolean;
}
export interface MoveInPlan { items: MoveItem[] }

/** Carried size: flat-pack halves every side. */
export const carried = (f: Pick<FurnitureItem, 'w' | 'd' | 'h'>, flat: boolean) => {
  const k = flat ? 0.5 : 1;
  return { w: f.w * k, d: f.d * k, h: f.h * k };
};

const SLACK = 0.02;
/** Stood on edge, an item's two smallest sides have to pass the door's width and height. */
const passesTilted = (dims: { w: number; d: number; h: number }, door: { widthM: number; heightM: number }) => {
  const s = [dims.w, dims.d, dims.h].sort((a, b) => a - b);
  return s[0] <= door.widthM - SLACK && s[1] <= door.heightM - SLACK;
};

const roomOf = (model: SpaceModel, f: FurnitureItem): string | null => {
  const p = { x: f.x, y: f.y };
  const hit = model.spaces.find((s) => pointInPolygon(p, s.polygon));
  if (hit) return hit.id;
  let best: string | null = null, bd = Infinity;
  for (const s of model.spaces) {
    const c = centroid(s.polygon), d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bd) { bd = d; best = s.id; }
  }
  return best;
};

interface Door { openingId: string; name: string; widthM: number; heightM: number }

/** The doors an item crosses, entrance first, and how many rooms deep it ends up. */
function doorsTo(model: SpaceModel, net: ReturnType<typeof buildingRoutes>, roomId: string | null) {
  const exit = [...net.graph.exits].sort((a, b) => b.widthM - a.widthM)[0];
  let entranceSpace: string | undefined = exit?.spaceId;
  let entranceId: string | undefined = exit?.id;
  if (!entranceId) {
    const o = model.openings.find((x) => x.kind === 'door') ?? model.openings.find((x) => x.kind === 'opening');
    entranceId = o?.id; entranceSpace = o?.spaceId;
  }
  const open = (id: string) => model.openings.find((o) => o.id === id);
  const first = entranceId ? open(entranceId) : undefined;
  const doors: Door[] = first ? [{ openingId: first.id, name: 'Entrance', widthM: first.widthM, heightM: first.heightM }] : [];
  if (!first || !entranceSpace || !roomId) return { doors, depth: 0, reachable: !!first };
  const route = net.route(entranceSpace, roomId);
  if (!route) return { doors, depth: 0, reachable: false };
  for (let i = 1; i < route.spaceIds.length; i++) {
    const a = route.spaceIds[i - 1], b = route.spaceIds[i];
    const link = net.graph.links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
    const half = link?.openingIds.map(open).find((o) => o?.spaceId === b);
    if (!half || !link) continue;
    const room = model.spaces.find((s) => s.id === b);
    doors.push({ openingId: half.id, name: `${room?.name ?? 'Room'} door`, widthM: link.widthM, heightM: half.heightM });
  }
  return { doors, depth: route.spaceIds.length - 1, reachable: true };
}

function passAt(model: SpaceModel, others: FurnitureItem[], f: FurnitureItem, dims: { w: number; d: number; h: number }, door: Door): PassageResult {
  // The cheap test first: a side wider than the door never passes flat, whatever the angle.
  if (Math.min(dims.w, dims.d) > door.widthM) {
    return { itemId: f.id, ok: false, poses: [], details: `Too wide for the ${door.widthM.toFixed(2)} m door.` };
  }
  return testPassage(model, others, { id: f.id, name: f.name, ...dims }, door.openingId);
}

export interface PlanOptions { flat?: ReadonlySet<string> }

/** Verdicts for every item against an empty building, then the delivery order. */
export function planMoveIn(model: SpaceModel, furniture: FurnitureItem[], opts: PlanOptions = {}): MoveInPlan {
  const flatSet = opts.flat ?? new Set<string>();
  const things = furniture.filter((f) => !isRug(f));
  const net = buildingRoutes(model);
  const cache = new Map<string, PassageResult>();
  const items: MoveItem[] = things.map((f) => {
    const flat = flatSet.has(f.id);
    const dims = carried(f, flat);
    const roomId = roomOf(model, f);
    const { doors, depth, reachable } = doorsTo(model, net, roomId);
    const steps: DoorStep[] = doors.map((door) => {
      const key = `${door.openingId}|${dims.w.toFixed(3)}|${dims.d.toFixed(3)}|${dims.h.toFixed(3)}`;
      let result = cache.get(key);
      if (!result) { result = passAt(model, [], f, dims, door); cache.set(key, result); }
      return { openingId: door.openingId, name: door.name, widthM: door.widthM, heightM: door.heightM, ok: result.ok, result };
    });
    const failing = steps.filter((s) => !s.ok);
    const tightStep = failing[0] ?? [...steps].sort((a, b) => a.widthM - b.widthM)[0];
    let verdict: Verdict;
    if (!reachable || !steps.length) verdict = 'wont';
    else if (!failing.length) verdict = 'fits';
    else if (failing.every((s) => passesTilted(dims, s))) verdict = 'tilt';
    else if (!flat && failing.every((s) => passesTilted(carried(f, true), s))) verdict = 'assemble';
    else verdict = 'wont';
    return { id: f.id, name: f.name, verdict, tight: tightStep?.name ?? 'No route', tightId: tightStep?.openingId ?? null, steps, roomId, depth, flat };
  });

  const byId = new Map(things.map((f) => [f.id, f]));
  const size = (m: MoveItem) => { const f = byId.get(m.id)!; return f.w * f.d * Math.max(f.h, 0.3); };
  const rank = (a: MoveItem, b: MoveItem) => b.depth - a.depth || size(b) - size(a) || a.id.localeCompare(b.id);

  // after[b] = items that must wait for b, because once placed they would block b's way in
  const after = new Map<string, Set<string>>(items.map((m) => [m.id, new Set<string>()]));
  for (const m of items) {
    if (m.verdict === 'wont' || !m.steps.length) continue;
    const f = byId.get(m.id)!;
    const dims = carried(f, m.flat);
    const blockedBy = (placed: FurnitureItem[]) => m.steps.some((s) => !passAt(model, placed, f, dims, s).ok);
    const rest = things.filter((o) => o.id !== f.id);
    if (!rest.length || !blockedBy(rest)) continue;
    for (const o of rest) if (blockedBy([o])) after.get(m.id)!.add(o.id);
  }

  const pending = new Set(items.map((m) => m.id));
  const mustWait = (id: string) => items.some((m) => pending.has(m.id) && m.id !== id && after.get(m.id)!.has(id));
  const ordered: MoveItem[] = [];
  const sorted = [...items].sort(rank);
  while (pending.size) {
    const next = sorted.find((m) => pending.has(m.id) && !mustWait(m.id)) ?? sorted.find((m) => pending.has(m.id))!;
    pending.delete(next.id);
    ordered.push(next);
  }
  return { items: ordered };
}
