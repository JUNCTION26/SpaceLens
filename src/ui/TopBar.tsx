import { useStore } from '../core/store';
import type { Mode } from '../core/types';

const MODES: Array<[Mode, string]> = [['capture', 'Capture'], ['design', 'Design'], ['experience', 'Experience'], ['deliver', 'Deliver']];

export function TopBar() {
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  return (
    <header className="topbar">
      <button className="brand" onClick={() => setMode('home')}>SpaceLens</button>
      <nav>{MODES.map(([m, l]) => <button key={m} className={m === mode ? 'on' : ''} onClick={() => setMode(m)}>{l}</button>)}</nav>
      <div>{(['2d', 'split', '3d'] as const).map((v) => <button key={v} className={v === view ? 'on' : ''} onClick={() => setView(v)}>{v}</button>)}</div>
    </header>
  );
}
