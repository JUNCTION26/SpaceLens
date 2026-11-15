// One-click starts that land on a finished state in seconds, with or without a Gemini key.
// Deep links: ?start=plan | villa | room
import { useStore } from '../../core/store';
import { sampleRoom } from '../../core/sample';
import { notify } from '../../ui/notify';
import { useUi } from '../../ui/uiStore';

export type StartKind = 'plan' | 'villa' | 'room';
export const START_KINDS: StartKind[] = ['plan', 'villa', 'room'];

/** The Italian-labelled sample plan: two flats on one floor, drawn at 1:100. */
export const SAMPLE_PLAN = { file: 'site1102_bldg2242_floor10281.pdf', name: 'Swiss apartment floor (Italian labels)' };
export const OFFICE_BRIEF = 'Home office for two, keep my desk, clear route to the window, under 12 000 kr';

/** A brief waiting for the Describe panel to mount and run it. */
let pendingBrief: string | null = null;
export function takePendingBrief(): string | null { const b = pendingBrief; pendingBrief = null; return b; }
/**
 * Hands a brief to Describe: an open panel runs it at once, otherwise it waits until the panel mounts,
 * however long the workspace takes to load.
 */
export function queueBrief(brief: string): void {
  if (typeof document !== 'undefined' && document.querySelector('.intent')) {
    pendingBrief = null;
    window.dispatchEvent(new CustomEvent('spacelens:request', { detail: brief }));
    return;
  }
  pendingBrief = brief;
}

const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

export interface PlanBuild { rooms: number; verified: number; withPrinted: number; medianErrorPct: number | null; examples: Array<{ name: string; printed?: number; computed: number }> }
let lastPlan: PlanBuild | null = null;
/** Summary of the last plan opened with startPlan, for captions. */
export const lastPlanBuild = () => lastPlan;

/** Reads the sample PDF, finds walls, doors and rooms, and opens the building in 3D. */
export async function startPlan(): Promise<boolean> {
  const st = useStore.getState();
  st.setBusy('Reading plan');
  try {
    const [{ loadPdf }, { drawingToBuilding }] = await Promise.all([import('../drawings/drawingIndex'), import('../drawings/toBuilding')]);
    const res = await fetch(`${import.meta.env.BASE_URL}samples/stoa/${SAMPLE_PLAN.file}`);
    if (!res.ok) throw new Error('missing sample');
    const doc = await withTimeout(loadPdf(await res.arrayBuffer(), SAMPLE_PLAN.name), 30000);
    const out = drawingToBuilding(doc, 0, { imageUrl: doc.pages[0]?.dataUrl });
    if (!out.report.ok) throw new Error(out.report.reason ?? 'no rooms');
    useStore.getState().dispatch({ type: 'REPLACE_MODEL', model: { ...out.model, name: SAMPLE_PLAN.name } });
    const s = useStore.getState();
    s.setMode('design'); s.setView('3d');
    useUi.getState().openSection('building');
    const rep = out.report;
    lastPlan = {
      rooms: rep.rooms.length, verified: rep.verified, withPrinted: rep.withPrintedArea, medianErrorPct: rep.medianAreaErrorPct,
      examples: rep.rooms.filter((r) => r.printedArea).slice(0, 3).map((r) => ({ name: r.name, printed: r.printedArea, computed: r.computedArea })),
    };
    notify(`${rep.rooms.length} rooms built`, {
      tone: 'ok', ttl: 9000, actions: [{ label: 'See plan', run: () => useStore.getState().setView('split') }, { label: 'Furnish', run: () => void startRoomIn() }],
    });
    return true;
  } catch (e) {
    console.error(e);
    notify('Plan not read', { tone: 'warn', actions: [{ label: 'Try villa', primary: true, run: () => void startVilla() }, { label: 'Drawings', run: () => useUi.getState().openSection('drawings') }] });
    return false;
  } finally { useStore.getState().setBusy(null); }
}

/** Plans a three-bedroom villa on a 10 x 12 m plot, furnishes every room and shows it in 3D. */
export async function startVilla(): Promise<boolean> {
  const st = useStore.getState();
  st.setBusy('Planning villa');
  try {
    const { loadDemo } = await import('../building/demo');
    const ok = await withTimeout(loadDemo('villa', true), 30000);
    if (!ok) throw new Error('no plan');
    const s = useStore.getState();
    s.dispatch({ type: 'RENAME', name: 'Villa, 3 bedrooms' });
    s.setMode('design'); s.setView('3d');
    // Already furnished and in 3D, so the next step is the walk.
    useUi.getState().openSection('walk');
    const m = useStore.getState().model;
    notify(`Villa ready, ${m.spaces.length} rooms`, { tone: 'ok', ttl: 8000, actions: [{ label: 'Walk', run: () => useUi.getState().openSection('walk') }, { label: 'See plan', run: () => useStore.getState().setView('split') }] });
    return true;
  } catch (e) {
    console.error(e);
    notify('Villa took too long', { tone: 'warn', actions: [{ label: 'Try again', primary: true, run: () => void startVilla() }, { label: 'Try a room', run: () => void startRoom() }] });
    return false;
  } finally { useStore.getState().setBusy(null); }
}

/** Runs the office brief in the room that is open now. */
async function startRoomIn(): Promise<void> {
  useStore.getState().setMode('design');
  useStore.getState().setView('split');
  useUi.getState().openSection('describe');
  queueBrief(OFFICE_BRIEF);
}

/** The sample room with a short office brief: layouts appear in seconds, each with its reasons. */
export async function startRoom(): Promise<boolean> {
  useStore.getState().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
  await startRoomIn();
  return true;
}

export function runStart(kind: string): Promise<boolean> {
  if (kind === 'plan') return startPlan();
  if (kind === 'villa') return startVilla();
  if (kind === 'room') return startRoom();
  return Promise.resolve(false);
}
