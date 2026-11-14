import { uid } from '../../core/geometry';
import { useStore } from '../../core/store';
import { findFreeSpot, snapToWall } from './placement';
import type { FurnitureItem } from '../../core/types';

/** Compact toolbar of common actions for one furniture item. */
export function ObjectActions({ itemId }: { itemId: string }) {
  const item = useStore((s) => s.model.furniture.find((f) => f.id === itemId));
  const dispatch = useStore((s) => s.dispatch);
  const toast = useStore((s) => s.toast);
  if (!item) return null;
  const { model } = useStore.getState();
  const locked = item.locked;
  const update = (patch: Partial<FurnitureItem>) =>
    dispatch({ type: 'UPDATE_OBJECT', id: item.id, patch });

  return (
    <div className="row" role="toolbar" aria-label={`Actions for ${item.name}`} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      <button className="btn btn-sm" disabled={locked} onClick={() => {
        const p = snapToWall(model, item, 0.6);
        if (p) update(p); else toast('No wall close enough to snap to', 'warn');
      }}>Snap to wall</button>
      <button className="btn btn-sm" disabled={locked} onClick={() => update(findFreeSpot(model, item))}>Find free spot</button>
      <button className="btn btn-sm" disabled={locked} onClick={() => update({ rotation: (item.rotation + Math.PI / 2) % (Math.PI * 2) })}>Rotate 90°</button>
      <button className="btn btn-sm" onClick={() => {
        const copy = { ...item, id: uid('f'), locked: false };
        dispatch({ type: 'PLACE_OBJECT', item: { ...copy, ...findFreeSpot(model, copy) } });
      }}>Duplicate</button>
      <button className="btn btn-sm" aria-pressed={locked} onClick={() => update({ locked: !locked })}>{locked ? 'Unlock' : 'Lock'}</button>
      <button className="btn btn-sm btn-ghost" disabled={locked} onClick={() => dispatch({ type: 'REMOVE_OBJECT', id: item.id })}>Delete</button>
    </div>
  );
}
