// One conversational turn: the person's words + a compact picture of the room go to the model,
// which streams back {say, sketch, actions}. The first finished sentence is spoken while the rest
// is still arriving, sketches appear as soon as each is complete, then actions run one by one,
// each sketched before it changes the plan.
import { ai, aiReady, classify } from '../../core/ai';
import { partialJson } from '../../core/ai/partialJson';
import { uid } from '../../core/geometry';
import { getState } from '../../core/store';
import type { StoreListing } from '../../core/types';
import { CATALOG } from '../furniture/catalog';
import { ACTION_TYPES, applyRoomOps, cleanReply, extraSketch, looksLikeEdit, wantsNewRoom, cleanSay, cleanSketch, execute, sketchMarks, type Action, type AgentReply, type Ctx } from './actions';
import { useAgent } from './agentStore';
import { describeMark, refersToSketch } from './deixis';
import { loadMod, loadedMod } from './mods';
import { answerWithHighlight, detectLang } from './answer';
import { refineRoom, refineRoomOffline } from '../intent/refine';
import { signedArea } from '../referee/geom';
import { validateLayout } from '../referee/validate';
import { totalFor } from '../budget/plan';
import { budgetVerdict, compareFacts, D, goalsBrief, hasGoals, mergeGoals, parseGoals, parseWhatIf, planTurn, sayParts, stretchPolygon, tidy, type RoomFacts } from './conversation';
import type { SpaceModel } from '../../core/types';
import { offlineReply } from './offline';
import { latestMark, useSketch } from './sketchStore';
import { speak, stopSpeaking, takeSentences } from './speech';
import { buildWorld, makeRefs, type Refs } from './world';

// ---------- prompt ----------

const CATALOG_LINES = CATALOG.map((c) => `${c.id} ${Math.round(c.w * 100)}x${Math.round(c.d * 100)}`).join(', ');

export const SYSTEM = `You are the design partner inside SpaceLens, talking out loud with a person while you sketch on their floor plan. You may be helping a company furnish an office, a builder deciding internal walls, or a child designing a dream room: match their words and tone (warm and simple with children, precise with professionals).

Reply as JSON {say, sketch, actions}.
- say: what you speak. One or two short sentences, plain spoken English (or the person's language), no lists, no markdown, never refs like i3 or m2; name things ("the sofa"). Say what you are doing while you do it ("Putting the desk under the window, facing the light.").
- sketch: marks drawn on the plan in plan metres (x right, y down, origin top-left). Kinds: zone (translucent region, 3+ points or 2 opposite corners, with text), arrow (2+ points: movement or a walking route), label (1 point + text, e.g. a dimension "90 cm"), ghost (1 centre point + w, d, rotation in degrees: a footprint you propose), circle, stroke, rect. Instead of points you may give at: a ref ("i2", "m1", "here", "w3"). Actions are illustrated automatically, so sketch only what they do not show: zones, routes, dimension labels, ideas you propose but do not apply yet. Use at most 6 marks.
- actions (run in order, after the sketch):
  create_object{prompt, place?}: make a custom object from a description (anything not in the catalog, or with special shape, size or style).
  add_catalog{catalogId, place?, w?, d?, h?, color?}: add a catalog piece.
  add_wall{from?, to?}: a partition wall; with no from/to it follows the person's latest line.
  move{id, place | x,y}; rotate{id, angle degrees clockwise}; resize{id, w?, d?, h?, color?}; remove{id}.
  design_room{brief}: full layout for the whole room from a brief (people, purpose, style, budget). Use for "design/furnish my room", and for themed or personal rooms ("make a room for my cat named Gerard", "build me a Barbie room", "a gaming room for two"): pass the whole sentence as brief; custom pieces, posters and names are made for it.
  apply_layout{candidateId}: apply a previewed layout (c1...).
  explain{id?, topic: price|choice|layout|direction}: say WHY using world.design and item data. Put the answer in say; the action only highlights.
  compare{a, b}: two items or two layouts.
  check_safety{}; find_products{query}: real store listings; measure{from?, to?}: distance between refs or along the latest line.
  set_view{view: 2d|3d|split|walk}; undo{}.
- place / from / to accept: "here" (the person's latest sketch), a sketch ref (m1), an item ref (i3, meaning next to it), a wall ref (w2) or side (north, south, east, west), "window", "door", "centre", or "x,y".
- Use refs exactly as given in the world (i1 items, m1 sketches, c1 layouts, w1 walls). "here", "this", "there" mean the person's latest sketch when they just drew one; "it"/"this one" otherwise means the selected item.
- Act when asked or clearly implied. If a request is ambiguous, ask one short question and do nothing. Never invent prices or store names. Keep things inside the room, clear of doors.
Catalog ids (cm): ${CATALOG_LINES}.`;

const POINT = { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] };
const S = { type: 'STRING' }, N = { type: 'NUMBER' };

export const SCHEMA = {
  type: 'OBJECT',
  properties: {
    say: S,
    sketch: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['zone', 'arrow', 'label', 'ghost', 'circle', 'stroke', 'rect'] },
          points: { type: 'ARRAY', items: POINT }, at: S, text: S, w: N, d: N, rotation: N,
        },
        required: ['kind'],
        propertyOrdering: ['kind', 'points', 'at', 'text', 'w', 'd', 'rotation'],
      },
    },
    actions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          type: { type: 'STRING', enum: [...ACTION_TYPES] },
          id: S, prompt: S, catalogId: S, place: S, x: N, y: N, angle: N, w: N, d: N, h: N, color: S,
          brief: S, candidateId: S, topic: S, a: S, b: S, query: S, from: S, to: S,
          view: { type: 'STRING', enum: ['2d', '3d', 'split', 'walk'] },
        },
        required: ['type'],
      },
    },
  },
  required: ['say', 'sketch', 'actions'],
  propertyOrdering: ['say', 'sketch', 'actions'],
};

/** The user message for one turn. */
export function buildPrompt(text: string, refs: Refs, world: Record<string, unknown>): string {
  let hint = '';
  if (refersToSketch(text)) {
    const latest = latestMark([...refs.marks.values()], 'you');
    if (latest) {
      const ref = refs.back.get(latest.id)!;
      hint = `\n("here/this/there" = the person's sketch ${ref}: ${JSON.stringify(describeMark(latest, ref))})`;
    }
  }
  return `World: ${JSON.stringify(world)}\n\nPerson: "${text.replace(/"/g, "'")}"${hint}`;
}

// ---------- streaming ----------

/** Turns the growing JSON text into spoken sentences and finished sketch marks. */
export class ReplyStream {
  spokenTo = 0;
  sketchCount = 0;
  say = '';
  firstSentenceAt: number | null = null;
  constructor(private ctx: Ctx, private out: { speak: (s: string) => void; caption: (s: string) => void; marks: (m: ReturnType<typeof sketchMarks>) => void }) {}

  feed(raw: string) {
    const obj = partialJson<Record<string, unknown>>(raw);
    if (obj && typeof obj === 'object') this.take(obj, false);
  }

  /** Process the final object; returns the cleaned reply. */
  finish(data: unknown): AgentReply {
    const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    this.take(obj, true);
    return cleanReply(obj);
  }

  private take(obj: Record<string, unknown>, final: boolean) {
    const say = cleanSay(obj.say);
    const sayDone = final || 'sketch' in obj || 'actions' in obj;
    if (say !== this.say) { this.say = say; this.out.caption(say); }
    const { sentences, next } = takeSentences(say, this.spokenTo, sayDone);
    for (const s of sentences) {
      if (this.firstSentenceAt === null) this.firstSentenceAt = performance.now();
      this.out.speak(s);
    }
    this.spokenTo = next;
    const arr = Array.isArray(obj.sketch) ? obj.sketch : [];
    const done = final || 'actions' in obj ? arr.length : Math.max(0, arr.length - 1);
    if (done > this.sketchCount) {
      const specs = arr.slice(this.sketchCount, done).map(cleanSketch).filter((s): s is NonNullable<typeof s> => !!s);
      const ms = sketchMarks(specs, this.ctx, this.sketchCount);
      if (ms.length) this.out.marks(ms);
      this.sketchCount = done;
    }
  }
}

// ---------- the turn ----------

let current: AbortController | null = null;

/** Stop the current turn (barge-in or a new request). */
export function interrupt() {
  current?.abort();
  current = null;
  stopSpeaking();
  useAgent.getState().set({ thinking: false, status: '' });
}

/** Whether this action's result carries facts the model's own words could not have. */
function worthSaying(a: Action, reply: AgentReply, ok: boolean): boolean {
  if (!ok || !reply.say) return true;
  if (['measure', 'find_products', 'check_safety', 'design_room'].includes(a.type)) return true;
  if (a.type === 'explain' || a.type === 'compare') return reply.say.length < 30;
  return false;
}

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Open floor and failed checks of a room as it stands (or as a copy would stand). */
function factsOf(model: SpaceModel): RoomFacts {
  const floor = model.spaces.reduce((a, sp) => a + Math.abs(signedArea(sp.polygon)), 0);
  const used = model.furniture.reduce((a, f) => a + f.w * f.d, 0);
  const fails = validateLayout(model, model.furniture, getState().requirements).filter((v) => v.result === 'fail').length;
  return { openM2: Math.max(0, floor - used), fails };
}

/** The room on a copy, one axis longer; the real room is never touched. */
function whatIfCopy(model: SpaceModel, axis: 'x' | 'y', deltaM: number): SpaceModel {
  return { ...model, spaces: model.spaces.map((sp, i) => (i === 0 ? { ...sp, polygon: stretchPolygon(sp.polygon, axis, deltaM) } : sp)) };
}

export interface TurnOptions {
  /** Force the rule path (tests, or no network). */
  offline?: boolean;
}

/** A spoken follow-up that adjusts the room: applied at once, one undo step, a short confirmation. */
async function tryEdit(words: string, model: ReturnType<typeof getState>['model'], offline: boolean): Promise<{ say: string } | null> {
  try {
    const previous = getState().past.at(-1)?.furniture;
    const memory = useAgent.getState().memory;
    const r = offline ? refineRoomOffline(model, words, { previous, memory }) : await refineRoom(model, words, { previous, memory });
    if (r?.memory) useAgent.getState().set({ memory: r.memory });
    if (!r || !r.ok || r.noChange) return null;
    if (r.undo && !r.ops.length) getState().undo();
    else if (r.ops.length) applyRoomOps(r.ops, r.label);
    else return null;
    return { say: r.label };
  } catch { return null; }
}

export async function runTurn(text: string, opts: TurnOptions = {}): Promise<void> {
  const words = text.trim();
  if (!words) return;
  interrupt();
  const ac = new AbortController();
  current = ac;
  const agent = useAgent.getState();
  const previous = agent.turns.map((t) => ({ who: t.who, text: t.text }));
  const turnId = uid('turn');
  agent.push({ id: uid('t'), who: 'you', text: words, at: Date.now() });
  agent.set({ thinking: true, caption: '', status: '', error: null });
  useSketch.getState().supersede(turnId);
  { const an = getState().analysis; if (an.highlights.length || an.routes.length) getState().setAnalysis({ highlights: [], routes: [] }); }
  await loadMod('reports');

  const st = getState();
  const conv0 = useAgent.getState().conv;
  const lang = detectLang(words, conv0.lang);
  const parsedGoals = parseGoals(words);
  const goals = mergeGoals(conv0.goals, parsedGoals);
  useAgent.getState().set({ conv: { ...conv0, lang, goals } });
  const marks = useSketch.getState().marks;
  const refs = makeRefs(st.model, marks, st.candidates.map((c) => c.id));
  const ctx: Ctx = { refs, turnId, utterance: words, signal: ac.signal, status: (s) => useAgent.getState().set({ status: s }), goals: hasGoals(goals) ? goals : undefined };
  const say = (s: string) => { void speak(s); };
  const caption = (s: string) => useAgent.getState().set({ caption: s });
  const stream = new ReplyStream(ctx, { speak: say, caption, marks: (ms) => useSketch.getState().addMany(ms) });

  let reply: AgentReply;
  let meta: string;
  let plan: Plan | null = null;
  const verdicts: string[] = [];
  const recentSketch = marks.some((m) => m.by === 'you' && Date.now() - m.createdAt < 10 * 60_000);
  const inRoom = (cat: string) => st.model.furniture.some((f) => f.category === cat || f.name.toLowerCase().includes(cat));
  const rules = () => {
    const r = offlineReply(words, recentSketch, inRoom, st, lang);
    return stream.finish(r);
  };

  const whatIf = parseWhatIf(words);
  const goalsOnly = hasGoals({ avoid: [], ...parsedGoals }) && wordCount(words) <= 12 && !/(?<![\p{L}])(add|put|move|place|remove|delete|rotate|make|show|why|how|what|where|design|furnish|check|find|lägg|flytta|inred|visa|kolla|sisusta|näytä)(?![\p{L}])/u.test(words.toLowerCase());
  plan = !whatIf ? planTurn(words, conv0.goals) : null;
  const instant = !whatIf && !plan ? answerWithHighlight(words, st, lang) : null;
  const edit = !whatIf && !plan && !instant && st.model.furniture.length > 0 && !wantsNewRoom(words) && looksLikeEdit(words)
    ? await tryEdit(words, st.model, !!opts.offline) : null;
  if (ac.signal.aborted) return;
  if (whatIf && st.model.spaces.length) {
    const before = factsOf(st.model);
    const after = factsOf(whatIfCopy(st.model, whatIf.axis, whatIf.deltaM));
    reply = stream.finish({ say: compareFacts(lang, before, after), sketch: [], actions: [] });
    meta = 'What if';
  } else if (plan) {
    useAgent.getState().set({ memory: { last: [] } });
    const checks = plan.checks.filter((c) => c !== 'budget');
    const actions: Action[] = [{ type: 'design_room', brief: plan.brief }, { type: 'apply_layout' }];
    if (checks.length) actions.push({ type: 'check_safety' });
    reply = stream.finish({ say: D(lang, 'designing'), sketch: [], actions });
    meta = 'Plan';
  } else if (instant) {
    const h = instant.highlight;
    if (h) {
      const ids = [...(h.spaceIds ?? []), ...(h.openingIds ?? [])];
      const routes = h.route && h.route.length > 1
        ? [{ id: 'answer', profile: 'adult' as const, points: h.route, ok: true, lengthM: null, narrowestM: null, label: '' }] : [];
      getState().setAnalysis({ highlights: ids.length ? [{ ids, color: 'var(--accent, #3b82f6)', label: '' }] : [], routes });
    }
    reply = stream.finish({ say: instant.text, sketch: [], actions: [] });
    meta = 'Instant';
  } else if (edit) {
    reply = stream.finish({ say: edit.say, sketch: [], actions: [] });
    meta = 'Edit';
  } else if (goalsOnly) {
    reply = stream.finish({ say: D(lang, 'goalSaved'), sketch: [], actions: [] });
    meta = 'Goals';
  } else if (aiReady() && !opts.offline) {
    try {
      const sid = st.activeCandidateId ?? st.candidates[0]?.id;
      const report = (sid && loadedMod('reports')?.useReports.getState().reports[sid]) || null;
      const world = buildWorld({ state: st, marks, turns: previous, report }, refs);
      const res = await ai<unknown>({
        task: 'fast', system: SYSTEM, schema: SCHEMA, signal: ac.signal, temperature: 0.5,
        parts: [{ text: buildPrompt(words, refs, world) + (hasGoals(goals) ? `
(The person's lasting goals: ${goalsBrief(goals)}. Reply in at most 20 words.)` : '
(Reply in at most 20 words.)') }],
        onPartial: (raw) => { if (!ac.signal.aborted) stream.feed(raw); },
      });
      if (ac.signal.aborted) return;
      reply = stream.finish(res.data);
      meta = `Gemini · ${res.model.replace(/^models\//, '').replace(/^gemini-/, '')}`;
    } catch (e) {
      if (ac.signal.aborted) return;
      reply = rules();
      meta = 'Offline rules';
      useAgent.getState().set({ error: `${classify(e).message} Answering with offline rules.` });
    }
  } else {
    reply = rules();
    meta = 'Offline rules';
  }
  if (ac.signal.aborted) return;
  reply = { ...reply, say: tidy(reply.say) };
  if (hasGoals({ avoid: [], ...parsedGoals }) && !reply.say && !reply.actions.length) reply = { ...reply, say: D(lang, 'goalSaved') };

  const agentTurnId = uid('t');
  useAgent.getState().push({ id: agentTurnId, who: 'agent', text: reply.say, at: Date.now(), meta });
  useAgent.getState().set({ caption: reply.say, thinking: reply.actions.length > 0 });

  const extra = extraSketch(reply.actions, ctx);
  if (extra.length) useSketch.getState().addMany(extra);
  const done: string[] = [];
  let products: StoreListing[] | undefined;
  let spokenExtra = '';
  for (const a of reply.actions) {
    if (ac.signal.aborted) break;
    let r;
    try { r = await execute(a, ctx); } catch (e) { r = { ok: false, line: `${a.type} failed: ${(e as Error).message.slice(0, 60)}` }; }
    if (ac.signal.aborted) break;
    if (r.line) done.push(r.line);
    if (r.products) products = r.products;
    const room = 20 - wordCount(`${reply.say} ${spokenExtra}`) - (plan?.checks.includes('budget') ? 8 : 0);
    if (r.speak && (plan ? a.type === 'check_safety' || !r.ok : worthSaying(a, reply, r.ok)) && room >= 3) {
      const piece = tidy(r.speak, room);
      say(piece);
      spokenExtra = `${spokenExtra} ${piece}`.trim();
      useAgent.getState().set({ caption: `${reply.say} ${spokenExtra}`.trim() });
    }
  }
  if (ac.signal.aborted) return;
  if (plan?.checks.includes('budget')) {
    const furniture = getState().model.furniture;
    verdicts.push(budgetVerdict(lang, totalFor(furniture), goals.budgetSek));
    const line = sayParts([reply.say, spokenExtra, ...verdicts]);
    const added = line.slice(`${reply.say} ${spokenExtra}`.trim().length).trim();
    if (added) { say(added); spokenExtra = `${spokenExtra} ${added}`.trim(); useAgent.getState().set({ caption: line }); }
  }
  useAgent.getState().patchTurn(agentTurnId, { text: `${reply.say} ${spokenExtra}`.trim(), done: done.length ? done : undefined, products });
  useAgent.getState().set({ thinking: false, status: '' });
  if (current === ac) current = null;
}
