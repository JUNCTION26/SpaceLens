import type { SpaceModel } from '../../core/types';

export type StepId = 'size' | 'describe' | 'view' | 'followup' | 'create' | 'walk' | 'drill' | 'share' | 'done';

export interface GuideStep {
  id: StepId;
  /** Sidebar section opened before the step points at anything; null keeps the current one. */
  section: string | null;
  /** `data-guide` values to ring, first visible one wins. */
  target: string[];
  /** Where the arrow lands when it differs from the ring. */
  aim?: string;
  text: string;
}

export const STEPS: GuideStep[] = [
  { id: 'size', section: 'capture', target: ['size'], text: 'Type the room size, for example 4.2 x 3.6' },
  { id: 'describe', section: 'describe', target: ['example', 'describe'], text: 'Describe the room, or tap an example' },
  { id: 'view', section: 'describe', target: ['stage'], aim: 'view3d', text: 'Drag to orbit the 3D view, scroll to zoom' },
  { id: 'followup', section: 'describe', target: ['describe'], text: 'Try: move the desk to the window' },
  { id: 'create', section: 'create', target: ['create'], text: 'Describe a piece, for example oak desk 140 wide with two drawers, then Place' },
  { id: 'walk', section: 'walk', target: ['walk'], text: 'Press Walk, then try the keys' },
  { id: 'drill', section: 'safety', target: ['drill'], text: 'Run a fire drill' },
  { id: 'share', section: 'export', target: ['share'], text: 'Export or share a link' },
  { id: 'done', section: null, target: [], text: 'Done' },
];

/** Keys shown while the walk step is on. */
export const WALK_KEYS: Array<[string[], string]> = [
  [['W', 'A', 'S', 'D'], 'Move'], [['Arrows', 'Drag'], 'Look'], [['Shift'], 'Run'], [['Esc'], 'Stop'],
];

/** What the guide watches to tell that a step's action happened. Taken at step entry and on every change. */
export interface Snap {
  size: string;
  furniture: number;
  /** Which pieces exist. */
  pieces: string;
  /** Where every piece stands. */
  places: string;
  custom: number;
  drills: number;
  viewPokes: number;
  walkStops: number;
}

export interface SnapExtras { drills: number; viewPokes: number; walkStops: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

export function snapOf(model: SpaceModel, x: SnapExtras): Snap {
  const f = model.furniture;
  return {
    size: JSON.stringify(model.spaces.map((s) => s.polygon)) + `|${model.ceilingM}`,
    furniture: f.length,
    pieces: f.map((i) => i.id).sort().join(','),
    places: f.map((i) => `${i.id}:${r2(i.x)}:${r2(i.y)}:${r2(i.rotation)}`).sort().join(','),
    custom: f.filter((i) => !!i.custom).length,
    ...x,
  };
}

/** True once the action a step asks for shows up between the step's start and now. */
export function stepDone(id: StepId, start: Snap, now: Snap): boolean {
  switch (id) {
    case 'size': return now.size !== start.size;
    case 'describe': return now.furniture > 0 && now.pieces !== start.pieces;
    case 'view': return now.viewPokes - start.viewPokes >= 2;
    case 'followup': return now.furniture > 0 && now.places !== start.places;
    case 'create': return now.custom > start.custom;
    case 'walk': return now.walkStops > start.walkStops;
    case 'drill': return now.drills > start.drills;
    default: return false;
  }
}

/** Step index after moving by `dir`, kept inside the tour. */
export function moveStep(i: number, dir: number): number {
  return Math.max(0, Math.min(STEPS.length - 1, i + dir));
}

export interface Box { left: number; top: number; right: number; bottom: number }

/**
 * A curved arrow from the instruction card to the target, leaving and arriving square to the edges it joins.
 * Returns an SVG path, or null when the two overlap and the ring alone is enough.
 */
export function arrowPath(card: Box, t: Box, gap = 8): string | null {
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const tx = (t.left + t.right) / 2, ty = (t.top + t.bottom) / 2;
  const f = (n: number) => Math.round(n);
  const right = t.left >= card.right + gap;
  const below = t.top >= card.bottom + gap;
  const above = t.bottom <= card.top - gap;
  if (right) {
    const x1 = card.right, y1 = clamp(ty, card.top + 12, card.bottom - 12);
    if (above || below) {
      // Out to the side, then up or down into the target.
      const y2 = above ? t.bottom + gap : t.top - gap;
      return `M${f(x1)} ${f(y1)} Q${f(tx)} ${f(y1)} ${f(tx)} ${f(y2)}`;
    }
    const x2 = t.left - gap, y2 = clamp(y1, t.top + 8, t.bottom - 8);
    const mx = (x1 + x2) / 2;
    return `M${f(x1)} ${f(y1)} C${f(mx)} ${f(y1)} ${f(mx)} ${f(y2)} ${f(x2)} ${f(y2)}`;
  }
  if (!below && !above) return null;
  const x1 = clamp(tx, card.left + 12, card.right - 12), y1 = below ? card.bottom : card.top;
  const x2 = clamp(x1, t.left + 8, t.right - 8), y2 = below ? t.top - gap : t.bottom + gap;
  const my = (y1 + y2) / 2;
  return `M${f(x1)} ${f(y1)} C${f(x1)} ${f(my)} ${f(x2)} ${f(my)} ${f(x2)} ${f(y2)}`;
}
