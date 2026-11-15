// Move-in day as a timeline: one slot per item, in delivery order.
import type { FurnitureItem } from '../../core/types';
import type { MoveInPlan, MoveItem, Verdict } from './plan';

export const SECONDS_PER_ITEM = 1.2;

export interface MoveSlot {
  id: string;
  index: number;
  start: number;
  end: number;
  verdict: Verdict;
  /** Blocked items stop at the door and never enter. */
  enters: boolean;
  tilt: boolean;
  flatPack: boolean;
  tightId: string | null;
}
export interface MoveTimeline { slots: MoveSlot[]; total: number }

export function buildMoveTimeline(plan: MoveInPlan, secondsPerItem = SECONDS_PER_ITEM): MoveTimeline {
  const slots = plan.items.map((m: MoveItem, index): MoveSlot => ({
    id: m.id, index, start: index * secondsPerItem, end: (index + 1) * secondsPerItem,
    verdict: m.verdict, enters: m.verdict !== 'wont', tilt: m.verdict === 'tilt',
    flatPack: m.flat || m.verdict === 'assemble', tightId: m.tightId,
  }));
  return { slots, total: slots.length * secondsPerItem };
}

export interface Frame {
  /** Slot being carried now, or null when finished or empty. */
  slot: MoveSlot | null;
  /** 0..1 progress inside the slot. */
  p: number;
  /** Items already standing in the room. */
  placed: string[];
  /** Items that have reached the door and stopped. */
  stopped: string[];
  done: boolean;
}

export function frameAt(tl: MoveTimeline, t: number): Frame {
  const time = Math.min(Math.max(t, 0), tl.total);
  const done = tl.slots.length > 0 && time >= tl.total;
  const placed: string[] = [], stopped: string[] = [];
  let slot: MoveSlot | null = null, p = 0;
  for (const s of tl.slots) {
    if (time >= s.end) { (s.enters ? placed : stopped).push(s.id); continue; }
    if (time >= s.start) { slot = s; p = (time - s.start) / (s.end - s.start); }
    break;
  }
  return { slot, p, placed, stopped, done };
}

export interface MoveSummary { fits: number; tilt: number; assemble: number; wont: number; widest: { name: string; door: string } | null }

/** Counts per verdict, and the widest item with the door that decides its verdict. */
export function summarize(plan: MoveInPlan, furniture: Array<Pick<FurnitureItem, 'id' | 'w' | 'd'>>): MoveSummary {
  const count = (v: Verdict) => plan.items.filter((m) => m.verdict === v).length;
  const size = new Map(furniture.map((f) => [f.id, Math.max(f.w, f.d)]));
  let widest: MoveSummary['widest'] = null, best = -1;
  for (const m of plan.items) {
    const w = size.get(m.id) ?? 0;
    if (w > best) { best = w; widest = { name: m.name, door: m.tight }; }
  }
  return { fits: count('fits'), tilt: count('tilt'), assemble: count('assemble'), wont: count('wont'), widest };
}
