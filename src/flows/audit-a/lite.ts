// Light store helpers for the audit flows that do not need the design pipeline (keeps test start-up short).
import { convexOverlap, itemCorners, polygonInside } from '../../core/geometry';
import { sampleRoom } from '../../core/sample';
import { useStore } from '../../core/store';
import type { FurnitureItem, SpaceModel } from '../../core/types';

export const st = () => useStore.getState();

export function resetStore(model: SpaceModel = sampleRoom()) {
  useStore.setState({
    model, past: [], future: [], changes: [], selection: null, requirements: null, candidates: [],
    activeCandidateId: null, infeasibility: null,
  });
}

const floorItems = (items: FurnitureItem[]) =>
  items.filter((f) => (f.mount ?? 'floor') === 'floor' && f.category !== 'rug' && !(f.elevationM && f.elevationM > 0.5));

export function outside(model: SpaceModel, items: FurnitureItem[] = model.furniture): string[] {
  return items.filter((f) => !model.spaces.some((s) => polygonInside(itemCorners(f), s.polygon))).map((f) => f.name);
}

export function overlaps(items: FurnitureItem[], tol = 0.02): string[] {
  const fl = floorItems(items);
  const out: string[] = [];
  for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
    if (convexOverlap(itemCorners(fl[i]), itemCorners(fl[j])) > tol) out.push(`${fl[i].name} x ${fl[j].name}`);
  }
  return out;
}
