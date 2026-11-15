import { useMemo } from 'react';
import type { SpaceModel, Vec2 } from '../../core/types';
import './minimap.css';

/** Small plan chip for the corner of the 3D view: rooms, the visitor and the way they face. */
export function Minimap({ model, pos, yaw, trail }: { model: SpaceModel; pos: Vec2; yaw: number; trail?: Vec2[] }) {
  const box = useMemo(() => {
    const pts = model.spaces.flatMap((s) => s.polygon);
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const minX = Math.min(...xs), minY = Math.min(...ys);
    return { minX, minY, w: Math.max(0.5, Math.max(...xs) - minX), h: Math.max(0.5, Math.max(...ys) - minY) };
  }, [model.spaces]);
  const pad = Math.max(box.w, box.h) * 0.06;
  const u = Math.max(box.w, box.h) / 60;
  // heading on the plan: the walk camera looks along (-sin yaw, -cos yaw)
  const hx = -Math.sin(yaw), hy = -Math.cos(yaw);
  return (
    <svg className="sim-mini" role="img" aria-label="Minimap" viewBox={`${box.minX - pad} ${box.minY - pad} ${box.w + pad * 2} ${box.h + pad * 2}`} preserveAspectRatio="xMidYMid meet">
      {model.spaces.map((s) => <polygon key={s.id} points={s.polygon.map((p) => `${p.x},${p.y}`).join(' ')} className="sim-mini-room" />)}
      {trail && trail.length > 1 && <polyline points={trail.map((p) => `${p.x},${p.y}`).join(' ')} className="sim-mini-trail" />}
      <g transform={`translate(${pos.x} ${pos.y})`}>
        <path d={`M${hx * 3.2 * u},${hy * 3.2 * u} L${(-hy * 1.6 - hx * 1.4) * u},${(hx * 1.6 - hy * 1.4) * u} L${(hy * 1.6 - hx * 1.4) * u},${(-hx * 1.6 - hy * 1.4) * u} Z`} className="sim-mini-me" />
      </g>
    </svg>
  );
}
