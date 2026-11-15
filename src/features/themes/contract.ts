// The completeness contract of a themed room: which pieces it cannot be called finished without,
// how many pieces a room of this size should hold, and how the plan shrinks for a small room.
// Pure functions over a brief and the room's outline; the layout step checks the result against it.
import type { SpaceModel } from '../../core/types';
import { catalogEntry } from '../furniture/catalog';
import { findNames, withNamePosters, type ThemeBrief, type ThemeObject } from './brief';

export interface Contract {
  /** Every required piece is in the room and the piece count is met. */
  complete: boolean;
  /** The room is smaller than 10 m2, so the piece count and set were scaled down. */
  scaled: boolean;
  minPieces: number;
  pieces: number;
  /** Names of the objects the room must hold. */
  required: string[];
  missing: string[];
  /** What was left out or replaced and why, for the layout card. */
  compromises: string[];
}

export interface Plan {
  brief: ThemeBrief;
  required: string[];
  minPieces: number;
  scaled: boolean;
  compromises: string[];
}

export function roomArea(model: SpaceModel): number {
  const poly = model.spaces[0]?.polygon ?? [];
  let a = 0;
  poly.forEach((p, i) => { const q = poly[(i + 1) % poly.length]; a += p.x * q.y - q.x * p.y; });
  return Math.abs(a / 2);
}

/** Pieces a room of this floor area should hold: 8 from 10 m2, scaled down (never below 4) under that. */
export const minPiecesFor = (areaM2: number): number => (areaM2 >= 10 ? 8 : Math.max(4, Math.min(8, Math.round((8 * areaM2) / 10))));

const isRug = (o: ThemeObject) => /^rug/.test(o.catalogId ?? '') || /\b(rug|carpet|mat)\b/i.test(o.name) && !o.recipe;
const OPTIONAL_RECIPES = new Set(['toy-basket', 'window-perch', 'wallshelf', 'clock']);
const isOptional = (o: ThemeObject) => isRug(o) || (o.recipe !== undefined && OPTIONAL_RECIPES.has(o.recipe)) || (!o.recipe && /lamp|plant|toy/i.test(`${o.catalogId ?? ''} ${o.name}`));
const printsName = (o: ThemeObject, names: string[]) => !!o.text && names.some((n) => n.toLowerCase() === o.text!.toLowerCase());

/** A piece the room is incomplete without: the floor pieces that define it plus the name poster. */
export function isEssential(o: ThemeObject, names: string[]): boolean {
  if (o.mount === 'wall' || (o.recipe && ['poster', 'sign', 'banner', 'wallshelf', 'clock', 'neon'].includes(o.recipe))) return printsName(o, names) && o.recipe === 'poster';
  return !isOptional(o);
}

const qtyOf = (o: ThemeObject) => Math.max(1, Math.min(12, o.qty ?? 1));
const isWall = (o: ThemeObject) => o.mount === 'wall';
const foot = (o: ThemeObject) => {
  if (isRug(o)) return 0;
  const c = o.catalogId ? catalogEntry(o.catalogId) : undefined;
  const base = o.sizeCm ? (o.sizeCm[0] * o.sizeCm[1]) / 1e4 : c ? c.w * c.d : 0.5;
  return base * 1.3;
};
const total = (o: ThemeObject) => foot(o) * qtyOf(o);
const countPieces = (objs: ThemeObject[]) => objs.reduce((s, o) => s + qtyOf(o), 0);

const wallFiller = (name: string, recipe: 'poster' | 'wallshelf' | 'clock', size: [number, number, number], palette: string[]): ThemeObject => ({
  source: 'custom', name, recipe, sizeCm: size, mount: 'wall', place: 'wall', style: 'star', color: palette[3] ?? '#f4ecdf', accent: palette[2] ?? '#c46b4b', eyeM: 1.5,
  prompt: `${name}, ${size[0]} x ${size[1]} x ${size[2]} cm`,
});
const FILLERS = (palette: string[]): ThemeObject[] => [
  wallFiller('Wall shelf', 'wallshelf', [80, 22, 30], palette),
  wallFiller('Wall clock', 'clock', [30, 3, 30], palette),
  wallFiller('Accent poster', 'poster', [50, 3, 70], palette),
  { source: 'catalogue', name: 'Floor lamp', catalogId: 'floor-lamp', mount: 'floor', place: 'corner' },
  { source: 'catalogue', name: 'Plant', catalogId: 'plant', mount: 'floor', place: 'corner' },
  { source: 'catalogue', name: 'Bench', catalogId: 'bench', mount: 'floor', place: 'wall' },
  wallFiller('Second shelf', 'wallshelf', [60, 20, 25], palette),
  wallFiller('Second poster', 'poster', [40, 3, 60], palette),
];

/**
 * Turn a brief into a plan the room can actually hold: the named poster and sign present, essentials
 * marked, enough pieces, and for a small room a set scaled to the floor area (optional pieces and
 * copies go first, essentials last, never fewer than three floor pieces).
 */
export function planContract(model: SpaceModel, text: string, base: ThemeBrief, extraNames: string[] = []): Plan {
  const area = roomArea(model);
  const names = [...new Set([...findNames(text), ...extraNames])];
  const compromises: string[] = [];
  const palette = base.palette;
  let objs = withNamePosters(base.objects, names, palette).map((o) => ({ ...o }));
  for (const n of names) {
    const printed = objs.some((o) => o.recipe === 'sign' && o.text && o.text.toLowerCase() === n.toLowerCase());
    if (!printed) objs.push({ source: 'custom', name: `${n} name sign`, recipe: 'sign', sizeCm: [70, 2.5, 22], mount: 'wall', place: 'wall', text: n, style: 'paw', color: palette[3] ?? '#c79a63', accent: palette[4] ?? '#3b2a1a', eyeM: 1.5, prompt: `${n} name sign, 70 x 2.5 x 22 cm, with the words "${n}" printed on it` });
  }
  objs = objs.map((o) => (isEssential(o, names) ? { ...o, essential: true } : { ...o, essential: undefined }));
  const scaled = area < 10;
  const minPieces = minPiecesFor(area);

  // Small rooms: fit the floor pieces into about 42 % of the floor so people can still walk.
  const budget = area * 0.42;
  const floorFoot = () => objs.filter((o) => !isWall(o)).reduce((s, o) => s + total(o), 0);
  const floorCount = () => objs.filter((o) => !isWall(o) && !isRug(o)).length;
  const left: string[] = [];
  for (let guard = 0; guard < 40 && floorFoot() > budget; guard++) {
    const floor = objs.filter((o) => !isWall(o));
    const copies = floor.filter((o) => qtyOf(o) > 1).sort((a, b) => qtyOf(b) - qtyOf(a))[0];
    if (copies) { left.push(`extra ${copies.name}`); copies.qty = qtyOf(copies) - 1 || undefined; continue; }
    const rug = floor.find(isRug);
    const optional = floor.filter((o) => !o.essential && !isRug(o)).sort((a, b) => total(b) - total(a))[0];
    const victim = rug && area < 8 ? rug : optional ?? floor.filter((o) => !isRug(o)).sort((a, b) => total(b) - total(a))[0];
    if (!victim || (victim.essential && floorCount() <= 3)) break;
    left.push(victim.name);
    objs = objs.filter((o) => o !== victim);
  }
  if (left.length) compromises.push(`Left out for the size of the room: ${left.join(', ')}.`);

  // Enough pieces: add small fillers (wall decor first, then lamp, plant, bench).
  const fill = FILLERS(palette);
  const added: string[] = [];
  for (const f of fill) {
    if (countPieces(objs) >= minPieces) break;
    if (!isWall(f) && floorFoot() + total(f) > Math.max(budget, 1.5) && scaled) continue;
    if (objs.some((o) => o.name === f.name)) continue;
    objs.push(f); added.push(f.name);
  }
  if (added.length) compromises.push(`Added to reach ${minPieces} pieces: ${added.join(', ')}.`);
  if (scaled) compromises.push(`Small room (${area.toFixed(1)} m2): the set was scaled down to ${minPieces} pieces or more.`);

  const required = objs.filter((o) => o.essential).map((o) => o.name);
  return { brief: { ...base, objects: objs, names }, required, minPieces, scaled, compromises };
}

/** Check a laid-out room against the plan. `placed` holds the names of the objects that made it onto the floor or wall. */
export function checkContract(plan: Plan, placed: string[], pieceCount: number): Contract {
  const have = new Set(placed);
  const missing = plan.required.filter((n) => !have.has(n));
  return {
    complete: missing.length === 0 && pieceCount >= plan.minPieces, scaled: plan.scaled, minPieces: plan.minPieces, pieces: pieceCount,
    required: plan.required, missing, compromises: [...plan.compromises],
  };
}

/** Plan with only what the contract needs: required pieces, the name sign and the fillers. */
export function essentialsOnly(plan: Plan, model: SpaceModel, text: string): Plan {
  const keep = plan.brief.objects.filter((o) => o.essential || (o.recipe === 'sign' && o.text) || (o.mount === 'wall' && o.hero));
  const base: ThemeBrief = { ...plan.brief, objects: keep.map((o) => ({ ...o, qty: undefined })) };
  const p = planContract(model, text, base, plan.brief.names);
  return { ...p, compromises: [...plan.compromises, ...p.compromises, 'Reduced to the essential pieces to make the layout fit.'] };
}
