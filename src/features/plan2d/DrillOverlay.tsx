import { useEffect, useState } from 'react';
import { personAt } from '../safety/drill';
import { useDrill } from '../safety/DrillButton';

const SPEED = 4;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Lives inside the plan svg (plan metres): people walking out, queues and smoke. */
export function DrillOverlay() {
  const result = useDrill((s) => s.result);
  const runKey = useDrill((s) => s.runKey);
  const [t, setT] = useState(0);

  useEffect(() => {
    if (!result) { setT(0); return; }
    if (reduced()) { setT(result.totalS); return; }
    let raf = 0, last = performance.now(), sim = 0;
    setT(0);
    const tick = (now: number) => {
      sim = Math.min(result.totalS, sim + ((now - last) / 1000) * SPEED); last = now;
      setT(sim);
      if (sim < result.totalS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [result, runKey]);

  if (!result) return <g />;
  const smoke = Math.min(4, 0.6 + 0.08 * t);
  const b = result.bottleneck;
  const dots = result.people.map((p) => {
    const at = personAt(p, t, result.dt);
    if (!at) return null;
    const before = personAt(p, Math.max(0, t - 0.5), result.dt) ?? at;
    return { id: p.id, at, wait: Math.hypot(at.x - before.x, at.y - before.y) < 0.12 && t > 0.6 };
  });
  return (
    <g className="drill-layer" aria-hidden="true">
      <circle className="drill-smoke" cx={result.fire.x} cy={result.fire.y} r={smoke} />
      <circle className="drill-flame" cx={result.fire.x} cy={result.fire.y} r={0.22} strokeWidth={0.05} />
      {result.exits.filter((e) => e.blocked).map((e) => (
        <path key={e.id} className="drill-shut" strokeWidth={0.09} d={`M${e.at.x - 0.3} ${e.at.y - 0.3}L${e.at.x + 0.3} ${e.at.y + 0.3}M${e.at.x + 0.3} ${e.at.y - 0.3}L${e.at.x - 0.3} ${e.at.y + 0.3}`} />
      ))}
      {b && <circle className="drill-bottleneck" cx={b.at.x} cy={b.at.y} r={Math.max(0.5, b.widthM / 2 + 0.3)} strokeWidth={0.04} />}
      {dots.map((d) => d && <circle key={d.id} className={`drill-dot${d.wait ? ' wait' : ''}`} cx={d.at.x} cy={d.at.y} r={0.17} strokeWidth={0.03} />)}
    </g>
  );
}
