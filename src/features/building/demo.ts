// Ready-made buildings for review links (?demo=villa, ?demo=office, ?demo=lshape) and the
// development handle window.__spacelensBuilding used by the browser test scripts.
import { getState } from '../../core/store';
import type { SpaceModel } from '../../core/types';
import { toSpaceModel } from './assemble';
import { furnishBuilding } from './furnish';
import { lShell, planBuilding, rectShell } from './partition';
import { officeProgramme, villaProgramme } from './programme';

export type DemoKind = 'villa' | 'office' | 'lshape';

/** A planned building as a SpaceModel (deterministic: seed 1, best option). */
export function demoBuilding(kind: DemoKind): SpaceModel | null {
  const [shell, entrance, programme] =
    kind === 'office' ? [rectShell(20, 15), { wallIndex: 2, offsetM: 10 }, officeProgramme(24)] as const
    : kind === 'lshape' ? [lShell(14, 12, 6, 6), { wallIndex: 0, offsetM: 9 }, villaProgramme(3)] as const
    : [rectShell(10, 12), { wallIndex: 2, offsetM: 5 }, villaProgramme(3)] as const;
  const plans = planBuilding(shell, [entrance], [], programme, { count: 1, seed: 1 });
  return plans[0] ? toSpaceModel(plans[0], undefined, { now: 0 }) : null;
}

/** Load a demo building into the app, optionally furnishing every room with the rule engine. */
export async function loadDemo(kind: DemoKind, furnish = false): Promise<boolean> {
  const m = demoBuilding(kind);
  if (!m) return false;
  const st = getState();
  st.dispatch({ type: 'REPLACE_MODEL', model: m });
  if (furnish) {
    const res = await furnishBuilding(getState().model, {}, { parallel: 3, timeBudgetMs: 900 });
    getState().dispatch({ type: 'SET_FURNITURE', items: res.furniture, label: 'Furnished every room' });
  }
  return true;
}

let ran = false;
/** Apply ?demo=<kind>[&furnish=1] once per page load. */
export function applyDemoLink(search: string = typeof location !== 'undefined' ? location.search : '') {
  if (ran) return;
  ran = true;
  const q = new URLSearchParams(search);
  const kind = q.get('demo');
  if (kind === 'villa' || kind === 'office' || kind === 'lshape') void loadDemo(kind, q.get('furnish') === '1');
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as unknown as { __spacelensBuilding: unknown }).__spacelensBuilding = { demoBuilding, loadDemo, furnishBuilding };
}
