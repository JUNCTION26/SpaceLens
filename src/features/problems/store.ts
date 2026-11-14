import { create } from 'zustand';
import { useStore } from '../../core/store';
import type { FurnitureItem, Op, ValidationResult } from '../../core/types';
import { notify } from '../../ui/notify';
import { useUi } from '../../ui/uiStore';
import { rankProblems } from './collect';
import { runProblems, type EngineMessage, type RunInput } from './engine';
import { applyOps } from './fixes';
import { SEVERITY_ORDER, type Fix, type Problem } from './types';

export interface ProblemsState {
  problems: Problem[];
  /** Every referee result, passes included, for the detailed list. */
  checks: ValidationResult[];
  /** Model version the list was computed for. */
  version: number;
  /** Fixes are still being worked out for some problems. */
  finding: boolean;
  /** Fix whose result is drawn as a ghost on the plan. */
  preview: Fix | null;
  /** Problem being pointed at in a list; its items get a ring on the plan. */
  focusId: string | null;
  fixingAll: boolean;
  /** Time the last remaining problem was fixed, for a short "All clear" moment. */
  clearedAt: number;
  setPreview: (f: Fix | null) => void;
  setFocus: (id: string | null) => void;
  refresh: (now?: boolean) => void;
  applyFix: (problem: Problem, fix: Fix) => void;
  fixAll: () => Promise<void>;
}

/** Counts toward "to fix": errors and warnings. Tips are listed but do not nag. */
export const counts = (p: Problem) => p.severity !== 'tip';

const shownFurniture = (): FurnitureItem[] => {
  const s = useStore.getState();
  if (s.activeCandidateId) { const c = s.candidates.find((x) => x.id === s.activeCandidateId); if (c) return c.furniture; }
  return s.model.furniture;
};
const reduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- Engine plumbing: a worker when the browser has one, otherwise the main thread in small steps.
let gen = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let worker: Worker | null = null;
let workerFailed = false;
/** Escape route problems from the last full run, kept until the next one lands so counts do not flicker. */
let lastSafety: Problem[] = [];
const coreWaiters: Array<{ gen: number; resolve: () => void }> = [];

function onMessage(m: EngineMessage) {
  if (m.gen !== gen) return;
  const st = useProblems.getState();
  if (m.type === 'problems') {
    let list = m.problems;
    if (m.withSafety) lastSafety = m.problems.filter((p) => p.source === 'safety');
    else {
      const ids = new Set(shownFurniture().map((f) => f.id));
      list = rankProblems([...m.problems, ...lastSafety.filter((p) => p.itemIds.every((id) => ids.has(id)))]);
    }
    const before = st.problems.filter(counts).length, after = list.filter(counts).length;
    useProblems.setState({
      problems: list, checks: m.checks, version: useStore.getState().model.version, finding: true,
      clearedAt: before > 0 && after === 0 && !m.withSafety ? Date.now() : st.clearedAt,
    });
  } else if (m.type === 'fixes') {
    useProblems.setState({ problems: st.problems.map((p) => (p.id === m.id ? { ...p, fixes: m.fixes } : p)) });
  } else if (m.type === 'core-done') {
    for (let i = coreWaiters.length - 1; i >= 0; i--) if (coreWaiters[i].gen <= m.gen) { coreWaiters[i].resolve(); coreWaiters.splice(i, 1); }
  } else if (m.type === 'done') {
    useProblems.setState({ finding: false });
  }
}

function post(input: RunInput) {
  if (!worker && !workerFailed && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<EngineMessage>) => onMessage(e.data);
      worker.onerror = () => { worker?.terminate(); worker = null; workerFailed = true; post(input); };
    } catch { worker = null; workerFailed = true; }
  }
  if (worker) { worker.postMessage(input); return; }
  void runProblems(input, onMessage, () => input.gen !== gen);
}

function start(): number {
  const s = useStore.getState();
  gen++;
  // Photos and scans are not needed for checking and would be copied to the worker on every edit.
  post({ gen, model: { ...s.model, evidence: [] }, furniture: shownFurniture(), req: s.requirements, safety: true });
  return gen;
}

const waitCore = (g: number) => new Promise<void>((resolve) => {
  coreWaiters.push({ gen: g, resolve });
  setTimeout(resolve, 8000); // never hang Fix all
});

export const useProblems = create<ProblemsState>((set, get) => ({
  problems: [],
  checks: [],
  version: -1,
  finding: false,
  preview: null,
  focusId: null,
  fixingAll: false,
  clearedAt: 0,
  setPreview: (preview) => { if (get().preview !== preview) set({ preview }); },
  setFocus: (focusId) => { if (get().focusId !== focusId) set({ focusId }); },

  refresh: (now = false) => {
    clearTimeout(timer);
    if (now) start(); else timer = setTimeout(start, 200);
  },

  applyFix: (problem, fix) => {
    const steps = commit(fix);
    if (steps < 0) return;
    set({ preview: null });
    get().refresh(true);
    const st = useStore.getState();
    if (steps > 0) notify(fix.kind === 'remove' ? `${fix.label.replace(/^Remove /, '')} removed.` : 'Fixed.', {
      tone: 'ok', actions: [{ label: 'Undo', run: () => { for (let i = 0; i < steps; i++) st.undo(); } }],
    });
    void problem;
  },

  fixAll: async () => {
    if (get().fixingAll) return;
    set({ fixingAll: true, preview: null });
    let done = 0, steps = 0;
    const tried = new Set<string>();
    try {
      await waitCore(start());
      for (let i = 0; i < 15; i++) {
        const next = get().problems
          .filter((p) => counts(p) && !tried.has(p.id))
          .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
          .map((p) => ({ p, f: p.fixes.find((x) => x.safe) }))
          .find((x) => x.f);
        if (!next?.f) break;
        tried.add(next.p.id);
        // Show where it will go, then move it there.
        set({ focusId: next.p.id, preview: next.f });
        await sleep(reduced() ? 60 : 420);
        const n = commit(next.f, true);
        set({ preview: null });
        if (n < 0) break;
        steps += n; done++;
        await sleep(reduced() ? 40 : 380);
        await waitCore(start());
      }
    } finally {
      set({ fixingAll: false, focusId: null, preview: null });
    }
    const left = get().problems.filter(counts).length;
    const st = useStore.getState();
    const undo = { label: 'Undo all', run: () => { for (let i = 0; i < steps; i++) st.undo(); } };
    if (!done) notify(left ? 'Each of these needs your choice.' : 'Nothing to fix.', { tone: 'info' });
    else notify(left ? `Fixed ${done}. ${left} need your choice.` : `Fixed ${done}. All clear.`, { tone: 'ok', actions: [undo] });
  },
}));

/** Applies a fix as one undoable step (two when a previewed layout has to be applied first). Returns undo steps, or -1. */
function commit(fix: Fix, quiet = false): number {
  if (fix.kind === 'go' && fix.go) { useUi.getState().openSection(fix.go); return 0; }
  if (!fix.ops.length) return -1;
  const st = useStore.getState();
  let steps = 0;
  if (st.activeCandidateId) {
    st.applyCandidate(st.activeCandidateId); steps++;
    if (!quiet) notify('Layout applied.', { tone: 'info', ttl: 2500 });
  }
  const s = useStore.getState();
  const furnitureOnly = fix.ops.every((o: Op) => o.type === 'UPDATE_OBJECT' || o.type === 'REMOVE_OBJECT' || o.type === 'PLACE_OBJECT');
  if (furnitureOnly) {
    s.dispatch({ type: 'SET_FURNITURE', items: applyOps(s.model, fix.ops).furniture, label: fix.label });
    steps++;
  } else {
    for (const op of fix.ops) { useStore.getState().dispatch(op); steps++; }
  }
  return steps;
}

/** Problems that mention an item, worst first. */
export const problemsFor = (problems: Problem[], itemId: string) => problems.filter((p) => p.itemIds.includes(itemId));

// Recompute after every change (debounced). Started once, in the browser only.
let started = false;
export function startProblems() {
  if (started || typeof window === 'undefined') return;
  started = true;
  useStore.subscribe((s, prev) => {
    if (s.model !== prev.model || s.activeCandidateId !== prev.activeCandidateId || s.candidates !== prev.candidates || s.requirements !== prev.requirements) {
      if (!useProblems.getState().fixingAll) useProblems.getState().refresh();
    }
  });
  useProblems.getState().refresh(true);
}
