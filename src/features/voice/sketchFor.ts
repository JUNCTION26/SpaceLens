// Maps the assistant's actions to sketch marks so the plan is drawn while the reply is spoken.
// Pure: item and place lookups are passed in, nothing reads a store.
import type { Vec2 } from '../../core/types';
import type { Action } from '../agent/actions';
import type { AgentMark } from '../agent/sketchStore';

export interface Footprint { x: number; y: number; w: number; d: number; rotation: number; name?: string }

export interface SketchWorld {
  /** An item by the id or name the action used. */
  item(ref: string | undefined): Footprint | undefined;
  /** A spot by the place words the action used. */
  place(spec: string | undefined): Vec2 | undefined;
}

export interface SketchOpts { turnId: string; now?: number; /** Delay before the first mark, ms. */ startMs?: number }

const circlePts = (c: Vec2, r: number, n = 24): Vec2[] =>
  Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + Math.cos((i / n) * Math.PI * 2) * r, y: c.y + Math.sin((i / n) * Math.PI * 2) * r }));

export const STEP_MS = 320;

/** Marks for one action: circle the item, an arrow from old to new, a dashed outline where it will go. */
export function sketchFor(a: Action, world: SketchWorld, opts: SketchOpts): AgentMark[] {
  const now = opts.now ?? Date.now();
  const out: AgentMark[] = [];
  const add = (kind: AgentMark['kind'], points: Vec2[], extra: Partial<AgentMark> = {}) => {
    const i = out.length;
    out.push({
      id: `vs-${opts.turnId}-${i}`, by: 'agent', kind, points, createdAt: now, drawMs: kind === 'ghost' ? 450 : 600,
      delayMs: (opts.startMs ?? 0) + i * STEP_MS, turnId: opts.turnId, ...extra,
    });
  };
  const ring = (f: Footprint) => add('circle', circlePts({ x: f.x, y: f.y }, Math.max(f.w, f.d) / 2 + 0.2));
  const spot = (): Vec2 | undefined =>
    a.x !== undefined && a.y !== undefined ? { x: a.x, y: a.y } : world.place(a.place ?? a.near ?? a.wall);

  switch (a.type) {
    case 'move': {
      const f = world.item(a.id);
      if (!f) break;
      ring(f);
      const to = spot();
      if (to) {
        add('arrow', [{ x: f.x, y: f.y }, { x: to.x, y: to.y }]);
        add('ghost', [{ x: to.x, y: to.y }], { w: f.w, d: f.d, rotation: f.rotation, text: f.name });
      }
      break;
    }
    case 'add_catalog': case 'create_object': {
      const p = spot();
      if (p && a.w && a.d) add('ghost', [p], { w: a.w, d: a.d, rotation: 0 });
      break;
    }
    case 'rotate': {
      const f = world.item(a.id);
      if (!f) break;
      ring(f);
      const deg = a.angle ?? 90;
      add('ghost', [{ x: f.x, y: f.y }], { w: f.w, d: f.d, rotation: f.rotation + (deg * Math.PI) / 180, text: `${Math.round(deg)} deg` });
      break;
    }
    case 'resize': {
      const f = world.item(a.id);
      if (!f) break;
      ring(f);
      add('ghost', [{ x: f.x, y: f.y }], { w: a.w ?? f.w, d: a.d ?? f.d, rotation: f.rotation });
      break;
    }
    case 'remove': {
      const f = world.item(a.id);
      if (f) ring(f);
      break;
    }
    case 'explain': case 'measure': case 'compare': {
      for (const ref of [a.id, a.a, a.b, a.from, a.to]) { const f = ref ? world.item(ref) : undefined; if (f) ring(f); }
      break;
    }
    default: break;
  }
  return out;
}

/** Marks for several actions, drawn one after another. */
export function sketchForAll(actions: Action[], world: SketchWorld, opts: SketchOpts): AgentMark[] {
  const all: AgentMark[] = [];
  for (const a of actions) {
    const ms = sketchFor(a, world, { ...opts, startMs: (opts.startMs ?? 0) + all.length * STEP_MS });
    ms.forEach((m, i) => { m.id = `vs-${opts.turnId}-${all.length + i}`; });
    all.push(...ms);
  }
  return all;
}
