// Top-down plan symbol for a generated object: the outline of every visible part, drawn in
// metres in the item's local frame (x right, plan y = +z, front edge at +d/2). Higher parts are
// filled so they hide what lies beneath, like a real top view. Moving parts show their open
// position dashed.
import type { ObjectPart, ObjectSpec } from '../../core/types';
import { longestAxis, partBounds, partsBounds, posedParts, rotMatrix } from './spec';

const ROUND = new Set(['cylinder', 'cone', 'sphere', 'lathe', 'tube']);

function Outline({ p, sx, sz, dashed }: { p: ObjectPart; sx: number; sz: number; dashed?: boolean }) {
  const R = rotMatrix(p.rot);
  const flatY = Math.abs(R[4]) > 0.999; // only rotated about y
  const b = partBounds(p);
  const dash = dashed ? { strokeDasharray: '0.04 0.03', fill: 'none' } : {};
  const x = p.pos[0] * sx, z = p.pos[2] * sz;
  if (!flatY) {
    return <rect x={b.min[0] * sx} y={b.min[2] * sz} width={(b.max[0] - b.min[0]) * sx} height={(b.max[2] - b.min[2]) * sz} {...dash} />;
  }
  const yaw = (Math.atan2(R[2], R[0]) * 180) / Math.PI; // rotation about y, plan degrees
  const w = p.size[0] * sx, d = p.size[2] * sz;
  if (ROUND.has(p.shape) && (p.shape !== 'tube' || longestAxis(p.size) === 1)) {
    return <ellipse cx={x} cy={z} rx={w / 2} ry={d / 2} transform={yaw ? `rotate(${-yaw} ${x} ${z})` : undefined} {...dash} />;
  }
  const soft = p.shape === 'cushion' || p.shape === 'rounded' || p.shape === 'tube';
  const rx = soft ? Math.min(p.radius ?? Math.min(w, d) * 0.25, Math.min(w, d) / 2) : p.shape === 'leg' ? Math.min(w, d) * 0.2 : 0;
  return <rect x={x - w / 2} y={z - d / 2} width={w} height={d} rx={rx} transform={yaw ? `rotate(${-yaw} ${x} ${z})` : undefined} {...dash} />;
}

/**
 * Plan symbol as an SVG group. Pass `w`/`d` to draw at an item's size when the spec was not
 * fitted to it; by default the spec's own size is used.
 */
export function SpecSymbol({ spec, w, d, showOpen = true }: { spec: ObjectSpec; w?: number; d?: number; showOpen?: boolean }) {
  if (!spec.parts.length) return null;
  const b = partsBounds(spec.parts);
  const sx = w ? w / Math.max(1e-6, b.max[0] - b.min[0]) : 1;
  const sz = d ? d / Math.max(1e-6, b.max[2] - b.min[2]) : 1;
  // Draw lowest tops first so higher parts cover them; skip specks.
  const order = spec.parts
    .map((p, i) => ({ p, i, top: partBounds(p).max[1] }))
    .filter(({ p }) => { const pb = partBounds(p); return (pb.max[0] - pb.min[0]) * (pb.max[2] - pb.min[2]) > 0.0003; })
    .sort((a, c) => a.top - c.top || a.i - c.i);
  // Where each moving group ends up when fully open, as one dashed outline.
  const openBoxes = showOpen && spec.motions?.length
    ? spec.motions.map((m) => posedParts(spec, 1).filter((p) => p.group === m.group)).filter((ps) => ps.length).map((ps) => partsBounds(ps))
    : [];
  return (
    <g className="forge-symbol" fill="var(--bg, #fff)">
      {order.map(({ p, i }) => <Outline key={i} p={p} sx={sx} sz={sz} />)}
      {openBoxes.map((ob, i) => (
        <rect key={`open${i}`} className="forge-symbol-open" x={ob.min[0] * sx} y={ob.min[2] * sz} width={(ob.max[0] - ob.min[0]) * sx} height={(ob.max[2] - ob.min[2]) * sz}
          fill="none" strokeDasharray="0.05 0.035" />
      ))}
    </g>
  );
}
