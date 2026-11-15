import { bounds, fmtSek } from '../../core/geometry';
import type { FurnitureItem, LayoutCandidate, SpaceModel } from '../../core/types';
import type { Case } from './caseFor';

const pose = (f: FurnitureItem) => `${f.x.toFixed(2)},${f.y.toFixed(2)},${f.rotation.toFixed(2)}`;

/** Crisp mini plan: room outline, items as rounded rects in their own colours. Items listed in `diff` are outlined. */
export function PlanThumb({ model, cand, size, diff }: { model: SpaceModel; cand: LayoutCandidate; size: number; diff?: Set<string> }) {
  const sp = model.spaces[0]; if (!sp) return null;
  const b = bounds(sp.polygon);
  const s = size / Math.max(b.maxX - b.minX, b.maxY - b.minY, 0.1);
  const W = (b.maxX - b.minX) * s, H = (b.maxY - b.minY) * s, pad = 2;
  const P = (p: { x: number; y: number }) => `${((p.x - b.minX) * s + pad).toFixed(1)},${((p.y - b.minY) * s + pad).toFixed(1)}`;
  return (
    <svg className="layout-thumb" width={W + pad * 2} height={H + pad * 2} role="img" aria-label={cand.name}>
      <polygon points={sp.polygon.map(P).join(' ')} fill="var(--panel)" stroke="var(--muted)" strokeWidth={1.2} strokeLinejoin="round" />
      {cand.furniture.map((f) => {
        const hot = diff?.has(f.id);
        return (
          <g key={f.id} transform={`translate(${((f.x - b.minX) * s + pad).toFixed(1)} ${((f.y - b.minY) * s + pad).toFixed(1)}) rotate(${(f.rotation * 180 / Math.PI).toFixed(1)})`}>
            <rect x={(-f.w * s) / 2} y={(-f.d * s) / 2} width={f.w * s} height={f.d * s} rx={Math.min(3, f.d * s * 0.3)} fill={f.color}
              opacity={diff && !hot ? 0.3 : 0.9} stroke={hot ? 'var(--accent)' : 'none'} strokeWidth={hot ? 1.6 : 0} />
          </g>
        );
      })}
    </svg>
  );
}

/** Passed checks out of total, as a thin ring. */
export function CheckRing({ passed, total, degraded }: { passed: number; total: number; degraded?: boolean }) {
  const r = 12, c = 2 * Math.PI * r, frac = total ? passed / total : 0;
  const tone = degraded ? 'var(--warn)' : frac >= 1 ? 'var(--ok)' : frac >= 0.75 ? 'var(--warn)' : 'var(--bad)';
  return (
    <svg className="layout-ring" width={32} height={32} viewBox="0 0 32 32" role="img" aria-label={`${passed} of ${total} checks passed`}>
      <circle cx={16} cy={16} r={r} fill="none" stroke="var(--line)" strokeWidth={2} />
      <circle cx={16} cy={16} r={r} fill="none" stroke={tone} strokeWidth={2} strokeLinecap="round" strokeDasharray={`${c * frac} ${c}`} transform="rotate(-90 16 16)" />
      <text x={16} y={16} textAnchor="middle" dominantBaseline="central" fontSize={10} fill="currentColor">{passed}</text>
    </svg>
  );
}

export function Chips({ c, degraded }: { c: Case; degraded?: boolean }) {
  return (
    <div className="layout-chips">
      {c.chips.map((x) => <span key={x} className="lchip">{x}</span>)}
      {c.leftOut.length > 0 && <span className="lchip lchip-left" title={c.leftOut.join(', ')} tabIndex={0} aria-label={`Left out: ${c.leftOut.join(', ')}`}>Left out {c.leftOut.length}</span>}
      {degraded && !c.leftOut.length && <span className="lchip lchip-left" title="Reduced clearances">Tight fit</span>}
      {c.tradeoff && <span className="lchip lchip-trade">{c.tradeoff}</span>}
    </div>
  );
}

const freeOf = (c: LayoutCandidate) => c.metrics.openAreaM2;

/** Two layouts side by side: only what differs is lit, and three numbers with the better one bold. */
export function CompareView({ model, a, b, ca, cb }: { model: SpaceModel; a: LayoutCandidate; b: LayoutCandidate; ca: Case; cb: Case }) {
  const pa = new Map(a.furniture.map((f) => [f.id, pose(f)])), pb = new Map(b.furniture.map((f) => [f.id, pose(f)]));
  const diffA = new Set(a.furniture.filter((f) => pb.get(f.id) !== pa.get(f.id)).map((f) => f.id));
  const diffB = new Set(b.furniture.filter((f) => pa.get(f.id) !== pb.get(f.id)).map((f) => f.id));
  const rows: Array<{ k: string; va: string; vb: string; winA: boolean; winB: boolean }> = [
    { k: 'Free', va: `${freeOf(a).toFixed(1)} m²`, vb: `${freeOf(b).toFixed(1)} m²`, winA: freeOf(a) > freeOf(b), winB: freeOf(b) > freeOf(a) },
    { k: 'Price', va: fmtSek(a.metrics.costSek), vb: fmtSek(b.metrics.costSek), winA: a.metrics.costSek < b.metrics.costSek, winB: b.metrics.costSek < a.metrics.costSek },
    { k: 'Checks', va: `${ca.passed}/${ca.total}`, vb: `${cb.passed}/${cb.total}`, winA: ca.passed > cb.passed, winB: cb.passed > ca.passed },
  ];
  return (
    <div className="layout-vs">
      <div className="layout-vs-col"><PlanThumb model={model} cand={a} size={120} diff={diffA} /><strong>{ca.title}</strong></div>
      <div className="layout-vs-col"><PlanThumb model={model} cand={b} size={120} diff={diffB} /><strong>{cb.title}</strong></div>
      <table className="layout-table">
        <tbody>
          {rows.map((r) => (
            <tr key={r.k}><td className={r.winA ? 'best' : ''}>{r.va}</td><th scope="row">{r.k}</th><td className={r.winB ? 'best' : ''}>{r.vb}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A ring of points around an item, for sketch marks. */
export function ringAround(f: Pick<FurnitureItem, 'x' | 'y' | 'w' | 'd'>) {
  const r = Math.hypot(f.w, f.d) / 2 + 0.15;
  return Array.from({ length: 18 }, (_, i) => ({ x: f.x + r * Math.cos((i / 18) * Math.PI * 2), y: f.y + r * Math.sin((i / 18) * Math.PI * 2) }));
}
