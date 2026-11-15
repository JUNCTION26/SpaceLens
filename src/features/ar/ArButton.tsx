import { useState } from 'react';
import { Icon } from '../../ui/icons';
import type { FurnitureItem, SpaceModel } from '../../core/types';

interface Props {
  model: SpaceModel;
  /** An item to show on its own; without it the whole furnished room is shown. */
  item?: FurnitureItem;
  className?: string;
  label?: string;
  /** Icon-above-label layout for the Files grid. */
  inline?: boolean;
}

/** Plain button: builds the USDZ on demand and opens it in AR (iPhone) or downloads it. */
export function ArButton({ model, item, className, label, inline = true }: Props) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const run = async () => {
    setBusy(true); setFailed(false);
    try {
      const { exportItemUsdz, exportRoomUsdz, openInAR } = await import('./usdz');
      const blob = item ? await exportItemUsdz(item) : await exportRoomUsdz(model);
      openInAR(blob, `${(item?.name ?? model.name) || 'SpaceLens'}.usdz`);
    } catch { setFailed(true); } finally { setBusy(false); }
  };
  return (
    <button type="button" className={className} onClick={run} disabled={busy} aria-live="polite">
      {inline ? <><Icon name={failed ? 'alert' : 'eye'} size={18} /><span>{label ?? 'AR'}</span></> : busy ? '...' : failed ? 'Retry' : label ?? 'AR'}
    </button>
  );
}
