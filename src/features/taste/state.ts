import { useSyncExternalStore } from 'react';
import { buildProfile } from './profile';
import type { TasteProfile } from './profile';
import { onTasteChange, readSignals } from './signals';

const KEY = 'spacelens.taste.on.v1';
const subs = new Set<() => void>();
let on: boolean | null = null;

export function tasteEnabled(): boolean {
  if (on === null) { try { on = localStorage.getItem(KEY) !== '0'; } catch { on = true; } }
  return on;
}
export function setTasteEnabled(v: boolean) {
  on = v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* blocked */ }
  subs.forEach((f) => f());
}

let snap: { log: unknown; p: TasteProfile } | null = null;
/** Current profile from the saved log. Same object until the log changes. */
export function currentProfile(): TasteProfile {
  const log = readSignals();
  if (!snap || snap.log !== log) snap = { log, p: buildProfile(log) };
  return snap.p;
}
const subscribe = (f: () => void) => { subs.add(f); const off = onTasteChange(f); return () => { subs.delete(f); off(); }; };
export const useTasteProfile = () => useSyncExternalStore(subscribe, currentProfile);
export const useTasteOn = () => useSyncExternalStore(subscribe, tasteEnabled);

/** The profile to apply, or null when the person turned taste off or nothing is learned yet. */
export function activeProfile(): TasteProfile | null {
  const p = currentProfile();
  return tasteEnabled() && p.confidence >= 0.25 ? p : null;
}
