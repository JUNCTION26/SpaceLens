// Shared helpers for the cross-feature flow tests. No product code lives here.
import { convexOverlap, itemCorners, polygonInside } from '../core/geometry';
import { sampleRoom } from '../core/sample';
import { useStore } from '../core/store';
import type { FurnitureItem, Requirements, SpaceModel } from '../core/types';
import { compileWithMeta } from '../features/intent/refine';
import { designRoom, type DesignResult } from '../features/design/pipeline';
import { showLayouts } from '../features/layout/progress';

export const st = () => useStore.getState();

/** Put the store in a known state, as a fresh page load would. */
export function resetStore(model: SpaceModel = sampleRoom()) {
  useStore.setState({
    model, past: [], future: [], changes: [], selection: null, requirements: null, candidates: [],
    activeCandidateId: null, infeasibility: null,
  });
}

/** What the Describe panel does for a brief: compile, design, show the layouts. */
export async function describeBrief(brief: string): Promise<{ req: Requirements; res: DesignResult }> {
  const { req } = await compileWithMeta(brief, st().model);
  const res = await designRoom(st().model, req, { variants: 1, brief });
  showLayouts(res);
  st().setRequirements(req);
  return { req, res };
}

/** Furniture that stands on the floor (wall items and rugs take no floor space). */
export const floorItems = (items: FurnitureItem[]) =>
  items.filter((f) => (f.mount ?? 'floor') === 'floor' && f.category !== 'rug' && !(f.elevationM && f.elevationM > 0.5));

/** Items whose footprint is not completely inside any room of the model. */
export function outside(model: SpaceModel, items: FurnitureItem[] = model.furniture): string[] {
  return items.filter((f) => !model.spaces.some((s) => polygonInside(itemCorners(f), s.polygon))).map((f) => f.name);
}

/** Pairs of floor items whose footprints overlap by more than `tol` metres. */
export function overlaps(items: FurnitureItem[], tol = 0.02): string[] {
  const fl = floorItems(items);
  const out: string[] = [];
  for (let i = 0; i < fl.length; i++) for (let j = i + 1; j < fl.length; j++) {
    if (convexOverlap(itemCorners(fl[i]), itemCorners(fl[j])) > tol) out.push(`${fl[i].name} x ${fl[j].name}`);
  }
  return out;
}

export const count = (items: FurnitureItem[], re: RegExp) => items.filter((f) => re.test(`${f.category} ${f.name}`)).length;

/** Writes a line to a log file next to the shots board so test output can be read in full. */
export async function note(label: string, data: unknown) {
  const m = 'node:';
  const fs = (await import(/* @vite-ignore */ m + 'fs')) as typeof import('node:fs');
  const dir = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.TEMP ?? '.';
  fs.appendFileSync(`${dir}/spacelens-shots/flows-log.txt`, `${label}: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`);
}
