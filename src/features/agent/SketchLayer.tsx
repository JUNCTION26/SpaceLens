// Marks on the plan: the agent's proposals (ghost footprints, arrows, zones, labels) drawing
// themselves on, and the person's own pencil strokes. Works two ways:
//  - <SketchLayer /> inside the plan's <svg> (plan-metre coordinates, no transform needed);
//  - <SketchOverlay /> anywhere: it finds the plan svg and lays a matching svg on top of it,
//    following pan and zoom through the plan's screen transform.
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { uid } from '../../core/geometry';
import type { Vec2 } from '../../core/types';
import { classifyStroke, markGeometry, simplify } from './deixis';
import { useSketch, type AgentMark } from './sketchStore';

const PLAN_SVG = '.pane-2d svg.plan2d-svg, .pane-2d svg[viewBox]';

const pathOf = (pts: Vec2[], close = false) =>
  pts.length ? `M${pts.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join('L')}${close ? 'Z' : ''}` : '';

/** CSS delay so a mark that is re-mounted continues where it was instead of replaying. */
const delayOf = (m: AgentMark) => `${m.createdAt + (m.delayMs ?? 0) - Date.now()}ms`;

function MarkView({ m, mpp }: { m: AgentMark; mpp: number }) {
  const agent = m.by === 'agent';
  const color = m.color ?? (agent ? 'var(--accent)' : 'var(--sketch-you, var(--text))');
  const anim = { animationDuration: `${m.drawMs ?? 0}ms`, animationDelay: delayOf(m) } as React.CSSProperties;
  const font = 12 * mpp;
  const label = (p: Vec2, text: string, dy = 0) => (
    <text x={p.x} y={p.y + dy} fontSize={font} className="sk-label" style={{ ...anim, animationDuration: '220ms', strokeWidth: 3 * mpp }} fill={color}>
      {text}
    </text>
  );
  const g = markGeometry(m);

  switch (m.kind) {
    case 'ghost': {
      const c = m.points[0];
      const w = m.w ?? 0.5, d = m.d ?? 0.5;
      const deg = ((m.rotation ?? 0) * 180) / Math.PI;
      return (
        <g className="sk-mark">
          <g transform={`translate(${c.x} ${c.y}) rotate(${deg})`}>
            <g className="sk-pop" style={anim}>
              <rect x={-w / 2} y={-d / 2} width={w} height={d} rx={0.03} fill={color} fillOpacity={0.12} stroke={color} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" strokeWidth={1.5} />
              <path d={`M${-w / 2 + 0.06} ${d / 2 - 0.04}L${w / 2 - 0.06} ${d / 2 - 0.04}`} stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
            </g>
          </g>
          {m.text && label({ x: c.x, y: c.y - d / 2 - 0.08 }, m.text)}
        </g>
      );
    }
    case 'label':
      return m.points[0] && m.text ? <g className="sk-mark">{label(m.points[0], m.text)}</g> : null;
    case 'zone':
    case 'rect':
      return (
        <g className="sk-mark">
          <path d={pathOf(m.points, true)} className="sk-fade" style={anim} fill={color} fillOpacity={m.kind === 'zone' ? 0.09 : 0} stroke="none" />
          <path d={pathOf(m.points, true)} pathLength={1} className="sk-draw" style={anim} fill="none" stroke={color} strokeOpacity={0.7} strokeDasharray="1" vectorEffect="non-scaling-stroke" strokeWidth={1.25} />
          {m.text && g && label({ x: g.bbox.minX + 0.1, y: g.bbox.minY + 0.1 + font }, m.text)}
        </g>
      );
    case 'arrow': {
      const pts = m.points;
      const a = pts[pts.length - 2] ?? pts[0], b = pts[pts.length - 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x), L = 10 * mpp;
      const head = [
        { x: b.x - L * Math.cos(ang - 0.45), y: b.y - L * Math.sin(ang - 0.45) }, b,
        { x: b.x - L * Math.cos(ang + 0.45), y: b.y - L * Math.sin(ang + 0.45) },
      ];
      const headAnim = { ...anim, animationDuration: '160ms', animationDelay: `${m.createdAt + (m.delayMs ?? 0) + (m.drawMs ?? 0) - Date.now()}ms` };
      return (
        <g className="sk-mark">
          <path d={pathOf(pts)} pathLength={1} className="sk-draw" style={anim} fill="none" stroke={color} strokeDasharray="1" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          <path d={pathOf(head)} className="sk-fade" style={headAnim} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {m.text && label({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, m.text, -6 * mpp)}
        </g>
      );
    }
    default: {
      // stroke / circle
      const closed = m.kind === 'circle';
      return (
        <g className="sk-mark">
          <path d={pathOf(m.points, closed && m.by === 'agent')} pathLength={1} className={m.drawMs ? 'sk-draw' : undefined} style={anim}
            fill="none" stroke={color} strokeDasharray={m.drawMs ? '1' : undefined} strokeWidth={agent ? 2 : 2.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" strokeOpacity={agent ? 1 : 0.85} />
          {m.text && g && label({ x: g.centroid.x, y: g.bbox.minY - 0.08 }, m.text)}
        </g>
      );
    }
  }
}

/** Freehand input in plan metres; `toPlan` maps client coordinates to the plan. */
function useDrawInput(toPlan: (x: number, y: number) => Vec2 | null) {
  const [live, setLive] = useState<Vec2[] | null>(null);
  const pts = useRef<Vec2[]>([]);
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation(); e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      const p = toPlan(e.clientX, e.clientY); if (!p) return;
      pts.current = [p]; setLive([p]);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!pts.current.length) return;
      e.stopPropagation();
      const p = toPlan(e.clientX, e.clientY); if (!p) return;
      pts.current.push(p); setLive([...pts.current]);
    },
    onPointerUp: (e: React.PointerEvent) => {
      if (!pts.current.length) return;
      e.stopPropagation();
      const raw = pts.current; pts.current = []; setLive(null);
      const points = simplify(raw, 0.02);
      const kind = points.length < 2 ? 'stroke' : classifyStroke(points);
      useSketch.getState().add({ id: uid('sk'), by: 'you', kind, points, createdAt: Date.now() });
    },
  };
  return { live, handlers };
}

function Marks({ mpp, toPlan }: { mpp: number; toPlan: (x: number, y: number) => Vec2 | null }) {
  const marks = useSketch((s) => s.marks);
  const drawing = useSketch((s) => s.drawing);
  const { live, handlers } = useDrawInput(toPlan);
  const liveMark = useMemo<AgentMark | null>(() => (live ? { id: 'live', by: 'you', kind: 'stroke', points: live, createdAt: 0 } : null), [live]);
  return (
    <>
      {drawing && (
        <rect x={-1e4} y={-1e4} width={2e4} height={2e4} fill="transparent" className="sk-capture" style={{ pointerEvents: 'all', cursor: 'crosshair' }} {...handlers} />
      )}
      <g style={{ pointerEvents: 'none' }}>
        {marks.map((m) => <MarkView key={m.id} m={m} mpp={mpp} />)}
        {liveMark && <MarkView m={liveMark} mpp={mpp} />}
      </g>
    </>
  );
}

/** Inline version: render as a child of the plan's own <svg>. */
export function SketchLayer() {
  const ref = useRef<SVGGElement>(null);
  const [mpp, setMpp] = useState(0.01);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const m = ref.current?.ownerSVGElement?.getScreenCTM();
      if (m && m.a) setMpp((prev) => (Math.abs(prev - 1 / m.a) / prev > 0.01 ? 1 / m.a : prev));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  const toPlan = (x: number, y: number) => {
    const svg = ref.current?.ownerSVGElement; const m = svg?.getScreenCTM();
    if (!svg || !m) return null;
    const p = new DOMPoint(x, y).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  return <g ref={ref} className="sk-layer"><Marks mpp={mpp} toPlan={toPlan} /></g>;
}

/** Overlay version: finds the plan svg and draws on top of it, following pan and zoom. */
export function SketchOverlay() {
  const [host, setHost] = useState<{ pane: HTMLElement; svg: SVGSVGElement } | null>(null);
  const [matrix, setMatrix] = useState<string>('');
  const [mpp, setMpp] = useState(0.01);
  const ov = useRef<SVGSVGElement>(null);
  const drawing = useSketch((s) => s.drawing);

  useEffect(() => {
    let raf = 0, last = '';
    const tick = () => {
      let h = host;
      if (!h || !h.svg.isConnected) {
        const svg = document.querySelector<SVGSVGElement>(PLAN_SVG);
        const pane = svg?.closest<HTMLElement>('.pane-2d') ?? null;
        const next = svg && pane ? { pane, svg } : null;
        if (next?.svg !== host?.svg) { setHost(next); return; }
        h = next;
      }
      if (h && ov.current) {
        const a = h.svg.getScreenCTM(), b = ov.current.getScreenCTM();
        if (a && b) {
          const m = b.inverse().multiply(a);
          const key = [m.a, m.b, m.c, m.d, m.e, m.f].map((n) => n.toFixed(4)).join(',');
          if (key !== last) { last = key; setMatrix(`matrix(${key})`); setMpp(1 / (a.a || 1)); }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [host]);

  if (!host) return null;
  const toPlan = (x: number, y: number) => {
    const m = host.svg.getScreenCTM(); if (!m) return null;
    const p = new DOMPoint(x, y).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  return createPortal(
    <svg ref={ov} className={`sk-overlay${drawing ? ' sk-overlay-drawing' : ''}`} aria-hidden={!drawing}>
      {matrix && <g transform={matrix}><Marks mpp={mpp} toPlan={toPlan} /></g>}
    </svg>,
    host.pane,
  );
}

