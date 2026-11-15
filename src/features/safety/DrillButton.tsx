import type { ReactNode } from 'react';
import { create } from 'zustand';
import { useStore } from '../../core/store';
import { Icon } from '../../ui/icons';
import { fmtClock, runDrill, type DrillResult } from './drill';
import './drill.css';

interface DrillState {
  result: DrillResult | null;
  /** Bumps on every start so the overlay restarts its clock. */
  runKey: number;
  block: boolean;
  /** null = from room areas. */
  people: number | null;
  setBlock: (b: boolean) => void;
  setPeople: (n: number | null) => void;
  set: (r: DrillResult | null) => void;
  replay: () => void;
}

export const useDrill = create<DrillState>((set) => ({
  result: null, runKey: 0, block: false, people: null,
  setBlock: (block) => set({ block }),
  setPeople: (people) => set({ people }),
  set: (result) => set((s) => ({ result, runKey: s.runKey + 1 })),
  replay: () => set((s) => ({ runKey: s.runKey + 1 })),
}));

export function DrillButton({ onStart, extra }: { onStart?: () => void; extra?: ReactNode }) {
  const model = useStore((s) => s.model);
  const select = useStore((s) => s.select);
  const { result, block, people, setBlock, setPeople } = useDrill();

  const start = (blockNow = block, n = people) => {
    useDrill.getState().set(runDrill(model, model.furniture, { blockExit: blockNow, occupants: n ?? undefined }));
  };
  const shown = people ?? result?.occupants ?? 0;
  const step = (d: number) => {
    const base = people ?? result?.occupants ?? 4;
    const n = Math.max(1, Math.min(200, base + d));
    setPeople(n);
    if (result) start(block, n);
  };
  const fix = result?.fix;
  const pickFix = () => {
    if (!fix) return;
    if (fix.itemId) select({ kind: 'furniture', id: fix.itemId });
    else if (fix.openingId) select({ kind: 'opening', id: fix.openingId });
  };
  const go = () => { if (result) useDrill.getState().replay(); else start(); onStart?.(); };

  return (
    <div className="drill" role="group" aria-label="Fire drill">
      <div className="drill-main">
        <button type="button" className="btn btn-primary drill-go" onClick={go} aria-label={result ? 'Replay drill' : 'Start drill'}>
          <Icon name="play" size={14} /> <span>Drill</span>
        </button>
        <span className="drill-step" role="group" aria-label="People">
          <button type="button" className="btn" aria-label="Fewer people" onClick={() => step(-1)}>{'−'}</button>
          <output aria-live="polite">{shown || 'Auto'}</output>
          <button type="button" className="btn" aria-label="More people" onClick={() => step(1)}>+</button>
        </span>
        <button type="button" className={`btn drill-block${block ? ' on' : ''}`} aria-pressed={block} aria-label="Block an exit" onClick={() => { setBlock(!block); if (result) start(!block); }}>
          Block exit
        </button>
        {result && <button type="button" className="btn btn-ghost drill-clear" aria-label="Clear drill" title="Clear" onClick={() => useDrill.getState().set(null)}><Icon name="x" size={14} /></button>}
      </div>
      {(result || extra) && (
        <div className="safety-chips drill-chips" aria-live="polite">
          {result && <span className={`safety-chip ${result.pass && result.allOut ? 'ok' : 'bad'}`} title="Time out">{fmtClock(result.totalS)}</span>}
          {extra}
        </div>
      )}
      {fix && <button type="button" className="btn drill-fix" onClick={pickFix}>{clipWords(fix.label)}</button>}
    </div>
  );
}

const clipWords = (t: string, n = 4) => { const w = t.split(/\s+/); return w.length > n ? `${w.slice(0, n).join(' ')}…` : t; };
