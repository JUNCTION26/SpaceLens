import { useMemo, useState } from 'react';
import { useStore, useShownFurniture } from '../../core/store';
import { Icon, type IconName } from '../../ui/icons';
import { planMoveIn, VERDICT_LABEL, type MoveItem, type Verdict } from './plan';
import './movein.css';

const VERDICT_ICON: Record<Verdict, IconName> = { fits: 'check', tilt: 'rotate', assemble: 'ruler', wont: 'x' };

export function MoveInPanel() {
  const model = useStore((s) => s.model);
  const furniture = useShownFurniture();
  const [flat, setFlat] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<string | null>(null);
  const plan = useMemo(() => planMoveIn(model, furniture, { flat }), [model, furniture, flat]);

  const play = (m: MoveItem) => {
    setPicked(m.id);
    const step = m.steps.find((s) => s.openingId === m.tightId) ?? m.steps[0];
    if (step) useStore.getState().setAnalysis({ passage: { ...step.result, itemId: m.id } });
  };
  const toggleFlat = (id: string) => setFlat((cur) => { const n = new Set(cur); if (!n.delete(id)) n.add(id); return n; });

  if (!plan.items.length) return <div className="movein"><p className="movein-empty" aria-label="No items"><Icon name="sofa" size={20} /></p></div>;
  return (
    <div className="movein">
      <ol className="movein-list">
        {plan.items.map((m, i) => (
          <li key={m.id} className={`movein-row v-${m.verdict}${picked === m.id ? ' on' : ''}`}>
            <button className="movein-main" onClick={() => play(m)} aria-label={`${m.name}, ${VERDICT_LABEL[m.verdict]}, ${m.tight}`}>
              <span className="movein-n">{i + 1}</span>
              <Icon name={m.name.toLowerCase().includes('sofa') ? 'sofa' : 'cube'} size={16} />
              <span className="movein-name">{m.name}</span>
              <span className="movein-tag"><Icon name={VERDICT_ICON[m.verdict]} size={12} />{VERDICT_LABEL[m.verdict]}</span>
              {m.verdict !== 'fits' && <span className="movein-door"><Icon name="door" size={12} />{m.tight}</span>}
            </button>
            <button className="btn btn-sm btn-ghost" aria-pressed={m.flat} onClick={() => toggleFlat(m.id)}>Flat-pack</button>
          </li>
        ))}
      </ol>
    </div>
  );
}
