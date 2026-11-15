// Pure edits of one room inside a building model, used by the floor chips.
import type { FurnitureItem, SpaceModel, Vec2 } from '../../core/types';
import { mergeFurniture } from './submodel';

/** Uses a room can be changed to; the value is the space purpose the furnisher understands. */
export const ROOM_USES: Array<{ purpose: string; label: string }> = [
  { purpose: 'bedroom', label: 'Bedroom' }, { purpose: 'living', label: 'Living' }, { purpose: 'kitchen', label: 'Kitchen' },
  { purpose: 'dining', label: 'Dining' }, { purpose: 'bathroom', label: 'Bathroom' }, { purpose: 'wc', label: 'WC' },
  { purpose: 'office', label: 'Office' }, { purpose: 'workspace', label: 'Workspace' }, { purpose: 'meeting', label: 'Meeting' },
  { purpose: 'reception', label: 'Reception' }, { purpose: 'storage', label: 'Storage' }, { purpose: 'utility', label: 'Utility' },
];

/** Replace the furniture inside one room; every other room keeps its pieces. */
export function refurnishRoom(model: SpaceModel, spaceId: string, items: FurnitureItem[], offset: Vec2 = { x: 0, y: 0 }): SpaceModel {
  if (!model.spaces.some((s) => s.id === spaceId)) return model;
  return { ...model, furniture: mergeFurniture(model, spaceId, items, offset) };
}

/** Rename a room and/or change its use. A new use clears that room's furniture so it can be furnished again. */
export function editRoom(model: SpaceModel, spaceId: string, patch: { name?: string; purpose?: string }): SpaceModel {
  const s = model.spaces.find((x) => x.id === spaceId);
  if (!s) return model;
  const name = patch.name?.trim() ? patch.name.trim().slice(0, 40) : s.name;
  const purpose = patch.purpose ?? s.purpose;
  const spaces = model.spaces.map((x) => (x.id === spaceId ? { ...x, name, purpose } : x));
  const next = { ...model, spaces };
  return patch.purpose && patch.purpose !== s.purpose ? refurnishRoom(next, spaceId, []) : next;
}
