import { Icon } from '../../ui/icons';
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
    <div className="row object-actions" role="toolbar" aria-label={`Actions for ${item.name}`} style={{ display: 'flex', gap: 4 }}>
      <button className="icon-btn" title="Snap to wall" aria-label="Snap to wall" disabled={locked} onClick={() => {
        const p = snapToWall(model, item, 0.6);
        if (p) update(p); else toast('No wall nearby', 'warn');
      }}><Icon name="maximize" size={16} /></button>
      <button className="icon-btn" title="Find free spot" aria-label="Find free spot" disabled={locked} onClick={() => update(findFreeSpot(model, item))}><Icon name="grid" size={16} /></button>
      <button className="icon-btn" title="Rotate 90 degrees" aria-label="Rotate 90 degrees" disabled={locked} onClick={() => update({ rotation: (item.rotation + Math.PI / 2) % (Math.PI * 2) })}><Icon name="rotate" size={16} /></button>
      <button className="icon-btn" title="Duplicate" aria-label="Duplicate" onClick={() => {
        const copy = { ...item, id: uid('f'), locked: false };
        dispatch({ type: 'PLACE_OBJECT', item: { ...copy, ...findFreeSpot(model, copy) } });
      }}><Icon name="copy" size={16} /></button>
    </div>
  );
}
