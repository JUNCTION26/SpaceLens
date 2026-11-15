import { Icon } from '../../ui/icons';
import { MIN_C } from './apply';
import { clearSignals } from './signals';
import { setTasteEnabled, useTasteOn, useTasteProfile } from './state';
import './taste.css';

export function TastePanel() {
  const p = useTasteProfile();
  const on = useTasteOn();
  const win = (['desk', 'bed', 'sofa'] as const).map((a) => p.window[a]);
  const wc = win.reduce((s, r) => s + r.c, 0);
  const winV = wc > 0 ? win.reduce((s, r) => s + r.v * r.c, 0) / wc : 0.5;
  const rows: Array<{ icon: string; hi: string; lo: string; v: number; c: number }> = [
    { icon: 'maximize', hi: 'Open', lo: 'Full', v: p.traits.open.v, c: p.traits.open.c },
    { icon: 'layout', hi: 'Walls', lo: 'Floating', v: p.traits.hug.v, c: p.traits.hug.c },
    { icon: 'copy', hi: 'Symmetric', lo: 'Loose', v: p.traits.sym.v, c: p.traits.sym.c },
    { icon: 'sun', hi: 'Window', lo: 'Away', v: winV, c: Math.max(...win.map((r) => r.c)) },
    { icon: 'sofa', hi: 'Dense', lo: 'Sparse', v: p.traits.density.v, c: p.traits.density.c },
    { icon: 'sparkles', hi: 'Premium', lo: 'Thrifty', v: p.traits.spend.v, c: p.traits.spend.c },
  ];
  return (
    <div className="taste" aria-label="Taste">
      <div className="taste-head">
        <label className="taste-toggle">
          <input type="checkbox" checked={on} aria-label="Use my taste" title="Use my taste" onChange={(e) => setTasteEnabled(e.target.checked)} />
          <Icon name="sparkles" size={14} />
        </label>
        <button className="taste-reset" aria-label="Reset" title="Reset" onClick={clearSignals} disabled={!p.events}><Icon name="rotate" size={14} /></button>
      </div>
      {rows.filter((r) => r.c >= MIN_C).map((r) => (
        <div key={r.hi} className="taste-row">
          <Icon name={r.icon} size={14} />
          <span className="taste-name">{r.v >= 0.5 ? r.hi : r.lo}</span>
          <span className="taste-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.v * 100)} aria-label={`${r.hi} or ${r.lo}`}>
            <i style={{ width: `${Math.round(r.v * 100)}%`, opacity: 0.35 + 0.65 * r.c }} />
          </span>
        </div>
      ))}
      {(p.palette.length > 0 || p.materials.length > 0) && (
        <div className="taste-row">
          <Icon name="palette" size={14} />
          <span className="taste-name">{p.materials[0]?.name ?? ''}</span>
          <span className="taste-dots">{p.palette.slice(0, 4).map((c) => <i key={c.name} style={{ background: c.name }} title={c.name} />)}</span>
        </div>
      )}
    </div>
  );
}
