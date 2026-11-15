import { useStore } from '../../core/store';
import type { AppState } from '../../core/store';
import type { FurnitureItem } from '../../core/types';
import { anchorOf, layoutFeatures, roomOf, wallGap, windowDist } from './features';
import type { LayoutFeatures } from './features';

export type Signal =
  | { t: number; k: 'apply' | 'skip'; f: LayoutFeatures }
  | { t: number; k: 'move'; cat: string; gap: number; win: number | null; winBefore: number | null }
  | { t: number; k: 'add' | 'remove'; cat: string }
  | { t: number; k: 'color' | 'material'; v: string; cat: string }
  | { t: number; k: 'budget'; sek: number }
  | { t: number; k: 'clear'; m: number }
  | { t: number; k: 'custom'; cat: string; color: string; material?: string };

const KEY = 'spacelens.taste.log.v1';
const CAP = 400;
let cache: Signal[] | null = null;
const listeners = new Set<() => void>();

export const onTasteChange = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };

export function readSignals(): Signal[] {
  if (cache) return cache;
  try { const s = localStorage.getItem(KEY); cache = s ? (JSON.parse(s) as Signal[]) : []; } catch { cache = []; }
  return cache;
}
export function logSignal(s: Signal) {
  cache = [...readSignals(), s].slice(-CAP);
  try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch { /* storage full or blocked */ }
  listeners.forEach((fn) => fn());
}
export function clearSignals() {
  cache = [];
  try { localStorage.removeItem(KEY); } catch { /* blocked */ }
  listeners.forEach((fn) => fn());
}

/** Turn one store change into signals. Pure apart from `log`, so tests can drive it directly. */
export function observe(s: AppState, prev: AppState, log: (x: Signal) => void = logSignal, now = Date.now()) {
  const last = s.changes[s.changes.length - 1];
  const fresh = s.changes.length > prev.changes.length ? last : undefined;
  if (s.requirements?.budgetSek && s.requirements.budgetSek !== prev.requirements?.budgetSek) log({ t: now, k: 'budget', sek: s.requirements.budgetSek });
  if (!fresh || s.model === prev.model) return;

  if (fresh.op === 'SET_FURNITURE') {
    const name = /^Applied "(.*)"$/.exec(fresh.label)?.[1];
    if (!name) return;
    for (const c of prev.candidates) log({ t: now, k: c.name === name ? 'apply' : 'skip', f: layoutFeatures(prev.model, c.furniture) });
    return;
  }
  const before = new Map(prev.model.furniture.map((f) => [f.id, f]));
  const after = new Map(s.model.furniture.map((f) => [f.id, f]));
  const room = roomOf(s.model);
  for (const f of after.values()) {
    const o = before.get(f.id);
    if (!o) {
      log({ t: now, k: 'add', cat: f.category });
      if (f.custom) log({ t: now, k: 'custom', cat: f.category, color: f.color, material: f.material });
      continue;
    }
    if (Math.hypot(f.x - o.x, f.y - o.y) > 0.05) {
      log({ t: now, k: 'move', cat: f.category, gap: wallGap(room, f), win: windowDist(room, f), winBefore: windowDist(room, o) });
    }
    if (f.color !== o.color) log({ t: now, k: 'color', v: f.color, cat: f.category });
    if (f.material && f.material !== o.material) log({ t: now, k: 'material', v: f.material, cat: f.category });
    const cl = (x: FurnitureItem) => (x.clearance.front + x.clearance.back + x.clearance.left + x.clearance.right) / 4;
    if (Math.abs(cl(f) - cl(o)) > 0.01) log({ t: now, k: 'clear', m: cl(f) });
  }
  for (const o of before.values()) if (!after.has(o.id)) log({ t: now, k: 'remove', cat: o.category });
}

let started = false;
export function startTasteLogging() {
  if (started) return;
  started = true;
  useStore.subscribe((s, prev) => { try { observe(s, prev); } catch { /* never break the app */ } });
}
export { anchorOf };
