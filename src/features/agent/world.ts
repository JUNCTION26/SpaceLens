// The compact picture of the room the agent sees each turn. Ids are replaced by short refs
// (i1, m1, c1) because models copy short tokens reliably and long ids waste tokens.
import { area, bounds, wallInwardNormal, wallLength } from '../../core/geometry';
import type { AppState } from '../../core/store';
import type { FurnitureItem, SketchMark, SpaceModel } from '../../core/types';
import { wallCompass } from '../objects/placement';
import { describeMark } from './deixis';
import type { PipelineReport } from './mods';

export interface Refs {
  items: Map<string, string>;
  marks: Map<string, SketchMark>;
  candidates: Map<string, string>;
  /** Real id -> ref. */
  back: Map<string, string>;
}

export interface WorldInput {
  state: Pick<AppState, 'model' | 'selection' | 'candidates' | 'activeCandidateId' | 'requirements' | 'view' | 'mode'>;
  marks: SketchMark[];
  turns: Array<{ who: 'you' | 'agent'; text: string }>;
  report?: PipelineReport | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const deg = (rad: number) => ((Math.round((rad * 180) / Math.PI) % 360) + 360) % 360;

export function makeRefs(model: SpaceModel, marks: SketchMark[], candidateIds: string[]): Refs {
  const refs: Refs = { items: new Map(), marks: new Map(), candidates: new Map(), back: new Map() };
  model.furniture.forEach((f, i) => { refs.items.set(`i${i + 1}`, f.id); refs.back.set(f.id, `i${i + 1}`); });
  marks.slice(-8).forEach((m, i) => { refs.marks.set(`m${i + 1}`, m); refs.back.set(m.id, `m${i + 1}`); });
  candidateIds.forEach((id, i) => { refs.candidates.set(`c${i + 1}`, id); refs.back.set(id, `c${i + 1}`); });
  return refs;
}

export function wallsOf(model: SpaceModel) {
  const out: Array<{ ref: string; side: string; lengthM: number; door: boolean; window: boolean; spaceId: string; index: number }> = [];
  for (const s of model.spaces) {
    for (let i = 0; i < s.polygon.length; i++) {
      out.push({
        ref: `w${out.length + 1}`, side: wallCompass(wallInwardNormal(s, i)), lengthM: r2(wallLength(s, i)), spaceId: s.id, index: i,
        door: model.openings.some((o) => o.spaceId === s.id && o.wallIndex === i && o.kind === 'door'),
        window: model.openings.some((o) => o.spaceId === s.id && o.wallIndex === i && o.kind === 'window'),
      });
    }
  }
  return out;
}

function itemLine(f: FurnitureItem, ref: string) {
  const o: Record<string, unknown> = {
    ref, name: f.name, cat: f.category, size: [r2(f.w), r2(f.d), r2(f.h)], at: [r2(f.x), r2(f.y)], rotDeg: deg(f.rotation),
  };
  if (f.priceSek) o.priceSek = Math.round(f.priceSek);
  if (f.locked) o.locked = true;
  if (f.owned) o.owned = true;
  if (f.listing) o.store = f.listing.store;
  return o;
}

/** A short trail of why the current design looks the way it does. */
export function reportSummary(r: PipelineReport, refs: Refs): Record<string, unknown> {
  const ref = (id: string) => refs.back.get(id) ?? id;
  const out: Record<string, unknown> = {};
  if (r.conceptName) out.concept = r.conceptName;
  if (r.idea) out.idea = r.idea;
  if (typeof r.finalScore === 'number') out.score = Math.round(r.finalScore);
  if (r.program?.zones?.length) out.zones = r.program.zones.map((z) => `${z.name}: ${z.purpose}`).slice(0, 5);
  if (r.program?.relations?.length) out.why = r.program.relations.slice(0, 10).map((x) => `${ref(x.subject)} ${x.kind}${x.target ? ` ${ref(x.target)}` : ''}: ${x.reason}`);
  const failing = (r.verdicts ?? []).filter((v) => !v.pass).slice(0, 4).map((v) => v.message);
  if (failing.length) out.issues = failing;
  if (r.critique?.summary) out.critic = r.critique.summary;
  return out;
}

export function buildWorld(input: WorldInput, refs: Refs): Record<string, unknown> {
  const { model, selection, candidates, activeCandidateId, requirements, view, mode } = input.state;
  const pts = model.spaces.flatMap((s) => s.polygon);
  const b = pts.length ? bounds(pts) : null;
  const world: Record<string, unknown> = {
    room: {
      name: model.name,
      floorM2: r2(model.spaces.reduce((a, s) => a + area(s.polygon), 0)),
      extent: b ? { x: [r2(b.minX), r2(b.maxX)], y: [r2(b.minY), r2(b.maxY)] } : null,
      ceilingM: model.ceilingM,
      walls: wallsOf(model).map((w) => `${w.ref} ${w.side} ${w.lengthM} m${w.door ? ' door' : ''}${w.window ? ' window' : ''}`),
    },
    items: model.furniture.map((f) => itemLine(f, refs.back.get(f.id)!)),
    view: mode === 'experience' ? 'walk' : view,
  };
  if (selection?.kind === 'furniture') world.selected = refs.back.get(selection.id) ?? null;
  if (candidates.length) {
    world.layouts = candidates.slice(0, 4).map((c) => ({
      ref: refs.back.get(c.id), name: c.name, score: Math.round(c.metrics.score), costSek: Math.round(c.metrics.costSek), previewing: c.id === activeCandidateId || undefined,
    }));
  }
  if (input.report) world.design = reportSummary(input.report, refs);
  if (requirements) world.brief = { purpose: requirements.purpose, people: requirements.people, budgetSek: requirements.budgetSek, style: requirements.style };
  const marks = [...refs.marks.entries()].map(([ref, m]) => describeMark(m, ref));
  if (marks.length) world.sketches = marks;
  const latest = [...refs.marks.entries()].reverse().find(([, m]) => m.by === 'you');
  if (latest) world.latestPersonSketch = latest[0];
  if (input.turns.length) world.recent = input.turns.slice(-6).map((t) => `${t.who}: ${t.text.slice(0, 200)}`);
  return world;
}
