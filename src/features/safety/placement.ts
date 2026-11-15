// Where safety equipment goes: smoke alarms, extinguishers, exit signs, a fire blanket.
// Each suggestion names the assumption behind it. Settings that exist in the active rule pack or the
// planning defaults come from there; the rest are named planning assumptions listed below, not rules.
import { area, centroid, convexOverlap, distPointPolygonEdges, itemCorners, pointInPolygon, add, mul, dist } from '../../core/geometry';
import type { FurnitureItem, Highlight, Op, SpaceModel, Vec2 } from '../../core/types';
import { applyPack, GENERIC_PACK, type RulePack } from '../jurisdiction/rulepacks';
import { assumptionFor, type AssumptionRef } from './access';
import { resolveConfig, swingZone, doorZone, type SafetyConfig } from './assess';
import { describeDoors } from './field';
import { isRug } from '../sim/grid';

export type PlacementKind = 'smoke-alarm' | 'extinguisher' | 'exit-sign' | 'fire-blanket';

export interface PlanningAssumption { id: string; title: string; value: number; unit: string; basis: string }

/** Named planning assumptions for placement. Planning guidance only; none of these is a regulation. */
export const PLACEMENT_ASSUMPTIONS: Record<string, PlanningAssumption> = {
  'plan-alarm-wall': { id: 'plan-alarm-wall', title: 'Alarm distance from walls', value: 0.5, unit: 'm', basis: 'Planning assumption: keeps the alarm out of the dead-air corner where ceiling meets wall.' },
  'plan-alarm-cooker': { id: 'plan-alarm-cooker', title: 'Alarm distance from a cooker', value: 1.0, unit: 'm', basis: 'Planning assumption: cooking fumes should not set it off.' },
  'plan-ext-side': { id: 'plan-ext-side', title: 'Extinguisher beside exit', value: 0.35, unit: 'm', basis: 'Planning assumption: offset from the door frame, on the room side.' },
  'plan-ext-height': { id: 'plan-ext-height', title: 'Extinguisher mounting height', value: 1.0, unit: 'm', basis: 'Planning assumption: handle within easy reach, off the floor.' },
  'plan-sign-above': { id: 'plan-sign-above', title: 'Exit sign above door', value: 0.15, unit: 'm', basis: 'Planning assumption: height of the sign above the door opening.' },
  'plan-blanket-reach': { id: 'plan-blanket-reach', title: 'Fire blanket reach', value: 0.8, unit: 'm', basis: 'Planning assumption: an arm’s length from the cooker edge, not above it.' },
  'plan-alarm-ceiling': { id: 'plan-alarm-ceiling', title: 'Alarm drop from ceiling', value: 0.05, unit: 'm', basis: 'Planning assumption: fixed on the ceiling surface.' },
};

export interface PlacementSuggestion {
  id: string;
  kind: PlacementKind;
  /** 1-3 words. */
  label: string;
  at: Vec2;
  spaceId: string;
  doorId?: string;
  mount: 'wall' | 'ceiling';
  elevationM: number;
  /** Id of the rule-pack rule, planning default or named planning assumption this rests on. */
  assumptionId: string;
}

export interface PlacementResult {
  suggestions: PlacementSuggestion[];
  highlights: Highlight[];
  points: Array<{ id: string; at: Vec2; kind: PlacementKind; label: string }>;
  assumptions: Array<AssumptionRef | PlanningAssumption>;
}

export interface PlacementOptions { pack?: RulePack; config?: Partial<SafetyConfig>; exitOverrides?: Record<string, boolean> }

const COOKER = /cooker|stove|oven|hob|range/i, KITCHENISH = /kitchen|counter|sink/i, DRY = /bath|wc|toilet|shower|sauna/i;

const solids = (furniture: FurnitureItem[]) => furniture.filter((f) => !isRug(f) && f.mount !== 'wall' && f.mount !== 'ceiling').map((f) => itemCorners(f));
const inFurniture = (p: Vec2, polys: Vec2[][], margin = 0) => polys.some((q) => pointInPolygon(p, q) || (margin > 0 && distPointPolygonEdges(p, q) < margin));

export function planPlacement(model: SpaceModel, furniture: FurnitureItem[], opts: PlacementOptions = {}): PlacementResult {
  const pack = opts.pack ?? GENERIC_PACK;
  const cfg = resolveConfig({ ...applyPack(pack), ...opts.config });
  const polys = solids(furniture);
  const wallClear = PLACEMENT_ASSUMPTIONS['plan-alarm-wall'].value;
  const cookerClear = PLACEMENT_ASSUMPTIONS['plan-alarm-cooker'].value;
  const alarmRef = assumptionFor(pack, 'alarmRadiusM', cfg), extRef = assumptionFor(pack, 'extinguisherTravelM', cfg);
  const out: PlacementSuggestion[] = [];
  const cookers = furniture.filter((f) => COOKER.test(`${f.category} ${f.name}`));
  const ceil = model.ceilingM;

  // Smoke alarms: ceiling, clear of walls and cookers; more when part of a big room lies beyond the alarm's reach.
  model.spaces.forEach((s) => {
    if (s.polygon.length < 3 || DRY.test(`${s.name} ${s.purpose ?? ''}`)) return;
    const xs = s.polygon.map((p) => p.x), ys = s.polygon.map((p) => p.y);
    const pts: Array<{ p: Vec2; e: number }> = [];
    for (let x = Math.min(...xs); x <= Math.max(...xs); x += 0.1) for (let y = Math.min(...ys); y <= Math.max(...ys); y += 0.1) {
      const p = { x, y };
      if (pointInPolygon(p, s.polygon)) pts.push({ p, e: distPointPolygonEdges(p, s.polygon) });
    }
    if (!pts.length) return;
    const c = centroid(s.polygon);
    const okAt = (q: { p: Vec2; e: number }, strict: boolean) =>
      !inFurniture(q.p, polys) && (!strict || (q.e >= wallClear && cookers.every((k) => dist(k, q.p) >= cookerClear + Math.max(k.w, k.d) / 2)));
    const placed: Vec2[] = [];
    for (let n = 0; n < 4; n++) {
      const unc = pts.filter((q) => !placed.some((a) => dist(a, q.p) <= alarmRef.value));
      if (n > 0 && !unc.length) break;
      let pool = pts.filter((q) => okAt(q, true));
      if (!pool.length) pool = pts.filter((q) => okAt(q, false));
      if (!pool.length) break;
      const target = n === 0 ? c : unc[Math.floor(unc.length / 2)].p;
      let best = pool[0], bs = Infinity;
      for (const q of pool) { const sc = dist(q.p, target) - Math.min(q.e, 1) * 0.3; if (sc < bs) { bs = sc; best = q; } }
      if (n === 0 && area(s.polygon) < 1) break;
      placed.push(best.p);
    }
    placed.forEach((p, i) => out.push({
      id: `smoke:${s.id}:${i}`, kind: 'smoke-alarm', label: 'Smoke alarm', at: p, spaceId: s.id, mount: 'ceiling',
      elevationM: Math.max(0, ceil - PLACEMENT_ASSUMPTIONS['plan-alarm-ceiling'].value), assumptionId: i === 0 ? 'plan-alarm-wall' : alarmRef.id,
    }));
  });

  // Extinguisher and sign at each exit door.
  const exits = describeDoors(model, opts.exitOverrides ?? {}).filter((d) => d.exit);
  for (const d of exits) {
    const zones = [doorZone(d, 0.3, 0.05), swingZone(model, d)].filter((z): z is Vec2[] => !!z);
    const side = PLACEMENT_ASSUMPTIONS['plan-ext-side'].value;
    let spot: Vec2 | null = null;
    for (const gap of [0.2, 0.3, 0.45]) for (const s of [1, -1] as const) for (const off of [side, side + 0.15, side + 0.3]) {
      if (spot) break;
      const p = add(add(d.c, mul(d.dir, s * (d.widthM / 2 + off))), mul(d.inward, gap));
      if (!pointInPolygon(p, d.space.polygon) || inFurniture(p, polys, 0.05)) continue;
      if (zones.some((z) => pointInPolygon(p, z) || convexOverlap(z, [p, add(p, { x: 0.01, y: 0 }), add(p, { x: 0.01, y: 0.01 })]) > 0)) continue;
      spot = p;
    }
    if (spot) out.push({ id: `ext:${d.id}`, kind: 'extinguisher', label: 'Extinguisher', at: spot, spaceId: d.space.id, doorId: d.id, mount: 'wall', elevationM: PLACEMENT_ASSUMPTIONS['plan-ext-height'].value, assumptionId: extRef.id });
    const sp = add(d.c, mul(d.inward, 0.1));
    out.push({ id: `sign:${d.id}`, kind: 'exit-sign', label: 'Exit sign', at: sp, spaceId: d.space.id, doorId: d.id, mount: 'wall', elevationM: Math.min(ceil - 0.2, d.opening.heightM + PLACEMENT_ASSUMPTIONS['plan-sign-above'].value), assumptionId: 'plan-sign-above' });
  }

  // Fire blanket near a cooker (or other kitchen item), within arm's reach but not over it.
  const kit = cookers[0] ?? furniture.find((f) => KITCHENISH.test(`${f.category} ${f.name}`));
  if (kit) {
    const reach = PLACEMENT_ASSUMPTIONS['plan-blanket-reach'].value, r = model.spaces.find((s) => pointInPolygon(kit, s.polygon));
    if (r) {
      const half = Math.max(kit.w, kit.d) / 2;
      let spot: Vec2 | null = null;
      for (const rad of [half + 0.3, half + 0.5, half + reach]) for (let a = 0; a < 8 && !spot; a++) {
        const p = add(kit, mul({ x: Math.cos((a * Math.PI) / 4), y: Math.sin((a * Math.PI) / 4) }, rad));
        if (pointInPolygon(p, r.polygon) && distPointPolygonEdges(p, r.polygon) >= 0.05 && !inFurniture(p, polys, 0.05)) spot = p;
      }
      if (spot) out.push({ id: `blanket:${kit.id}`, kind: 'fire-blanket', label: 'Fire blanket', at: spot, spaceId: r.id, mount: 'wall', elevationM: 1.2, assumptionId: 'plan-blanket-reach' });
    }
  }

  const colour: Record<PlacementKind, string> = { 'smoke-alarm': '#3b82f6', extinguisher: '#d64545', 'exit-sign': '#22a06b', 'fire-blanket': '#e0a800' };
  const names: Record<PlacementKind, string> = { 'smoke-alarm': 'Alarms', extinguisher: 'Extinguishers', 'exit-sign': 'Signs', 'fire-blanket': 'Blanket' };
  const highlights: Highlight[] = (Object.keys(colour) as PlacementKind[]).flatMap((k) => {
    const ids = out.filter((x) => x.kind === k).map((x) => x.id);
    return ids.length ? [{ ids, color: colour[k], label: names[k] }] : [];
  });
  const used = new Set(out.map((x) => x.assumptionId));
  const assumptions: PlacementResult['assumptions'] = [
    ...[alarmRef, extRef].filter((a) => used.has(a.id)),
    ...Object.values(PLACEMENT_ASSUMPTIONS).filter((a) => used.has(a.id)),
  ];
  return { suggestions: out, highlights, points: out.map((x) => ({ id: x.id, at: x.at, kind: x.kind, label: x.label })), assumptions };
}

/**
 * Turns suggestions into wall or ceiling mounted items, using a catalogue entry per kind when the
 * caller has one. Without a template for a kind there is nothing to place and it stays a highlight.
 */
export function applyPlacement(suggestions: PlacementSuggestion[], templates: Partial<Record<PlacementKind, FurnitureItem>> = {}, newId: (s: PlacementSuggestion) => string = (s) => `safety:${s.id}`): Op[] {
  const ops: Op[] = [];
  for (const s of suggestions) {
    const t = templates[s.kind]; if (!t) continue;
    ops.push({ type: 'PLACE_OBJECT', item: { ...t, id: newId(s), x: s.at.x, y: s.at.y, mount: s.mount, elevationM: s.elevationM, locked: false } });
  }
  return ops;
}
