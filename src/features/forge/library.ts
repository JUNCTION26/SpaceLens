// "My objects": everything the person has built, kept in this browser so it can be placed
// again, renamed, varied or deleted. Also turns an object into a placed room item.

import { create } from 'zustand';
import { uid } from '../../core/geometry';
import { getState } from '../../core/store';
import type { FurnitureItem, MaterialId, ObjectSpec } from '../../core/types';
import { findFreeSpot, snapToWall } from '../objects/placement';
import { editObject, type GenerateOpts } from './generate';

/** Fired by voice commands that built an object, so the forge panel shows it. */
export const FORGE_RESULT_EVENT = 'spacelens:forge-result';

const LS_KEY = 'spacelens.forge.library.v1';
const MAX_ITEMS = 60;

function read(): ObjectSpec[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((s): s is ObjectSpec => !!s && typeof s === 'object' && Array.isArray((s as ObjectSpec).parts) && !!(s as ObjectSpec).size) : [];
  } catch { return []; }
}
function write(list: ObjectSpec[]) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* storage full or blocked */ }
}

interface LibraryState {
  items: ObjectSpec[];
  save: (spec: ObjectSpec) => void;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
}

export const useForgeLibrary = create<LibraryState>((set, get) => ({
  items: read(),
  save: (spec) => {
    const items = [spec, ...get().items.filter((s) => s.id !== spec.id)].slice(0, MAX_ITEMS);
    write(items); set({ items });
  },
  rename: (id, name) => {
    const n = name.trim(); if (!n) return;
    const items = get().items.map((s) => (s.id === id ? { ...s, name: n.slice(0, 80) } : s));
    write(items); set({ items });
  },
  remove: (id) => { const items = get().items.filter((s) => s.id !== id); write(items); set({ items }); },
}));

/** A variation of a saved object ("make it 20 cm wider", "in walnut", "add a shelf"); returns a new object. */
export function variation(spec: ObjectSpec, instruction: string, opts: GenerateOpts = {}): Promise<ObjectSpec> {
  return editObject(spec, instruction, opts);
}

const MATERIAL_HEX: Partial<Record<MaterialId, string>> = {
  oak: '#b08a5a', walnut: '#6e4f36', pine: '#d9b98c', birch: '#d8c7a8', 'white-laminate': '#f2efe9', 'black-laminate': '#2f2f2f',
  'black-metal': '#2b2b2b', steel: '#b8bec4', brass: '#b89553', chrome: '#d6d9dc', fabric: '#6d7f8f', linen: '#b7a58f',
  velvet: '#4f6b55', leather: '#8c4a3b', wool: '#b7a58f', glass: '#cfe3ea', marble: '#e8e4de', concrete: '#9a9a96',
  plastic: '#e6e6e6', mattress: '#f4f1ea', rattan: '#c8a46a', ceramic: '#e9e2d6', plant: '#4f7d4a',
};

/** Colour of the largest part, for 2D plans and lists. */
export function dominantColor(spec: ObjectSpec): string {
  let best = { v: -1, c: '#9aa3ad' };
  for (const p of spec.parts) {
    const v = p.size[0] * p.size[1] * p.size[2];
    if (v > best.v) best = { v, c: p.color ?? MATERIAL_HEX[p.material] ?? '#9aa3ad' };
  }
  return best.c;
}

export function mainMaterial(spec: ObjectSpec): string {
  const vol = new Map<string, number>();
  for (const p of spec.parts) vol.set(p.material, (vol.get(p.material) ?? 0) + p.size[0] * p.size[1] * p.size[2]);
  return [...vol.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.replace('-', ' ') ?? '';
}

/** Room item for an object at exact size, with clearances from its semantics. */
export function specToItem(spec: ObjectSpec, at: { x: number; y: number; rotation?: number } = { x: 1, y: 1 }): FurnitureItem {
  const s = spec.semantics;
  const openD = spec.openSize && spec.openSize.d > spec.size.d + 0.05 ? spec.openSize.d : undefined;
  return {
    id: uid('f'), catalogId: 'generated', name: spec.name, category: s.category,
    x: at.x, y: at.y, rotation: at.rotation ?? 0,
    w: spec.size.w, d: spec.size.d, h: spec.size.h,
    clearance: { front: s.frontClearanceM, back: 0, left: s.sideClearanceM, right: s.sideClearanceM },
    ...(openD ? { unfoldedD: openD } : {}),
    locked: false, owned: false, priceSek: 0, priceStatus: 'estimated',
    color: dominantColor(spec), material: mainMaterial(spec), sourceKind: 'generated', custom: spec,
  };
}

/** Place an object in the room: a free spot, flush to a wall when it wants one; selects it. */
export function placeSpec(spec: ObjectSpec, at?: { x: number; y: number }): FurnitureItem {
  const st = getState();
  const model = st.model;
  const item = specToItem(spec);
  if (at) Object.assign(item, at);
  else Object.assign(item, findFreeSpot(model, item));
  if (spec.semantics.wallBacked) {
    const p = snapToWall(model, item, at ? 0.4 : 0.6);
    if (p) Object.assign(item, p);
  }
  st.dispatch({ type: 'PLACE_OBJECT', item });
  st.select({ kind: 'furniture', id: item.id });
  return item;
}
