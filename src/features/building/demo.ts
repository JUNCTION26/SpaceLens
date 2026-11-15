// Ready-made buildings for review links (?demo=villa, ?demo=office, ?demo=lshape) and the
// development handle window.__spacelensBuilding used by the browser test scripts.
import { getState } from '../../core/store';
import type { SpaceModel } from '../../core/types';
import { toSpaceModel } from './assemble';
import { furnishBuilding } from './furnish';
import { lShell, planBuilding, rectShell } from './partition';
import { planBuildingAsync } from './planAsync';
import { officeProgramme, villaProgramme } from './programme';

export type DemoKind = 'villa' | 'office' | 'lshape';

const inputs = (kind: DemoKind) =>
  kind === 'office' ? [rectShell(20, 15), { wallIndex: 2, offsetM: 10 }, officeProgramme(24)] as const
  : kind === 'lshape' ? [lShell(14, 12, 6, 6), { wallIndex: 0, offsetM: 9 }, villaProgramme(3)] as const
  : [rectShell(10, 12), { wallIndex: 2, offsetM: 5 }, villaProgramme(3)] as const;

/** A planned building as a SpaceModel (deterministic: seed 1, best option). */
export function demoBuilding(kind: DemoKind): SpaceModel | null {
  const [shell, entrance, programme] = inputs(kind);
  const plans = planBuilding(shell, [entrance], [], programme, { count: 1, seed: 1 });
  return plans[0] ? toSpaceModel(plans[0], undefined, { now: 0 }) : null;
}

/** Same as demoBuilding, planned in a worker so the page stays responsive while it loads. */
export async function demoBuildingAsync(kind: DemoKind): Promise<SpaceModel | null> {
  const [shell, entrance, programme] = inputs(kind);
  const plans = await planBuildingAsync(shell, [entrance], [], programme, { count: 1, seed: 1 });
  return plans[0] ? toSpaceModel(plans[0], undefined, { now: 0 }) : null;
}

/** Load a demo building into the app, optionally furnishing every room with the rule engine. */
export async function loadDemo(kind: DemoKind, furnish = false): Promise<boolean> {
  const m = await demoBuildingAsync(kind);
  if (!m) return false;
  const st = getState();
  st.dispatch({ type: 'REPLACE_MODEL', model: m });
  if (furnish) {
    const res = await furnishBuilding(getState().model, {}, { parallel: 3, timeBudgetMs: 900 });
    getState().dispatch({ type: 'SET_FURNITURE', items: res.furniture, label: 'Furnished every room' });
  }
  return true;
}

/** The demo kind named by a query string, or null. */
export function demoKindFromSearch(search: string): DemoKind | null {
  const kind = new URLSearchParams(search).get('demo');
  return kind === 'villa' || kind === 'office' || kind === 'lshape' ? kind : null;
}

let ran = false;
/**
 * Apply ?demo=<kind>[&furnish=1] once per page load. Called from an always-mounted component
 * (the 3D view is not mounted for view=2d, so it cannot own this).
 */
export function applyDemoLink(search: string = typeof location !== 'undefined' ? location.search : ''): Promise<boolean> {
  const kind = demoKindFromSearch(search);
  if (ran || !kind) return Promise.resolve(false);
  ran = true;
  return loadDemo(kind, new URLSearchParams(search).get('furnish') === '1');
}

/** Test hook: allow applyDemoLink to run again. */
export function resetDemoLink() { ran = false; }

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __spacelensBuilding: unknown }).__spacelensBuilding = { demoBuilding, loadDemo, furnishBuilding };
}
