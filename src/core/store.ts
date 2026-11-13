import { create } from 'zustand';
import { applyOp, describeOp } from './ops';
import { sampleRoom } from './sample';
import type {
  Analysis, FurnitureItem, Infeasibility, Layers, LayoutCandidate, Mode, Op, Requirements, Selection, Settings, SpaceModel,
} from './types';

export interface ChangeEntry { version: number; label: string; at: number; op: Op['type'] }

export interface Toast { id: number; text: string; tone: 'info' | 'ok' | 'warn' | 'error' }

export interface AppState {
  model: SpaceModel;
  past: SpaceModel[];
  future: SpaceModel[];
  changes: ChangeEntry[];
  mode: Mode;
  view: '2d' | '3d' | 'split';
  selection: Selection | null;
  requirements: Requirements | null;
  candidates: LayoutCandidate[];
  /** Candidate being previewed (not yet applied to the model). */
  activeCandidateId: string | null;
  infeasibility: Infeasibility | null;
  analysis: Analysis;
  layers: Layers;
  settings: Settings;
  toasts: Toast[];
  busy: string | null;

  dispatch: (op: Op) => void;
  undo: () => void;
  redo: () => void;
  setMode: (m: Mode) => void;
  setView: (v: AppState['view']) => void;
  select: (s: Selection | null) => void;
  setRequirements: (r: Requirements | null) => void;
  setCandidates: (c: LayoutCandidate[], inf?: Infeasibility | null) => void;
  previewCandidate: (id: string | null) => void;
  applyCandidate: (id: string) => void;
  setAnalysis: (patch: Partial<Analysis>) => void;
  toggleLayer: (k: keyof Layers, on?: boolean) => void;
  setSettings: (patch: Partial<Settings>) => void;
  toast: (text: string, tone?: Toast['tone']) => void;
  dismissToast: (id: number) => void;
  setBusy: (label: string | null) => void;
}

const LS_MODEL = 'spacelens.model.v1';
const LS_SETTINGS = 'spacelens.settings.v1';

function load<T>(key: string): T | null {
  try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : null; } catch { return null; }
}
function save(key: string, value: unknown) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
}

const emptyAnalysis = (version: number): Analysis => ({ version, routes: [], passage: null, heat: null, sightlines: [], highlights: [] });

const initialModel = load<SpaceModel>(LS_MODEL) ?? sampleRoom();
// VITE_GEMINI_KEY is only read from a local, gitignored .env.local during development.
const devKey = import.meta.env.DEV ? ((import.meta.env.VITE_GEMINI_KEY as string | undefined) ?? '') : '';
const storedSettings = load<Settings>(LS_SETTINGS);
const initialSettings: Settings = {
  geminiModel: 'gemini-3.5-flash-lite',
  theme: 'system',
  ...(storedSettings ?? {}),
  geminiKey: storedSettings?.geminiKey || devKey,
};
// Older defaults were retired or too slow for interactive use.
if (['gemini-2.5-flash', 'gemini-flash-latest'].includes(initialSettings.geminiModel)) initialSettings.geminiModel = 'gemini-3.5-flash-lite';

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => ({
  model: initialModel,
  past: [],
  future: [],
  changes: [],
  mode: load<SpaceModel>(LS_MODEL) ? 'design' : 'home',
  view: 'split',
  selection: null,
  requirements: null,
  candidates: [],
  activeCandidateId: null,
  infeasibility: null,
  analysis: emptyAnalysis(initialModel.version),
  layers: { dimensions: true, clearance: false, routes: true, provenance: false, heat: false, sightlines: false },
  settings: initialSettings,
  toasts: [],
  busy: null,

  dispatch: (op) => {
    const { model, past, changes } = get();
    const next = applyOp(model, op);
    // Candidates are tied to the version they were generated for; geometry edits mark them stale.
    set({
      model: next,
      past: [...past.slice(-99), model],
      future: [],
      changes: [...changes.slice(-199), { version: next.version, label: describeOp(op), at: Date.now(), op: op.type }],
    });
  },
  undo: () => {
    const { past, model, future } = get();
    if (!past.length) return;
    set({ model: { ...past[past.length - 1], version: model.version + 1 }, past: past.slice(0, -1), future: [model, ...future] });
  },
  redo: () => {
    const { past, model, future } = get();
    if (!future.length) return;
    set({ model: { ...future[0], version: model.version + 1 }, past: [...past, model], future: future.slice(1) });
  },
  setMode: (mode) => set({ mode }),
  setView: (view) => set({ view }),
  select: (selection) => set({ selection }),
  setRequirements: (requirements) => set({ requirements }),
  setCandidates: (candidates, infeasibility = null) => set({ candidates, infeasibility, activeCandidateId: candidates[0]?.id ?? null }),
  previewCandidate: (activeCandidateId) => set({ activeCandidateId }),
  applyCandidate: (id) => {
    const c = get().candidates.find((x) => x.id === id);
    if (!c) return;
    get().dispatch({ type: 'SET_FURNITURE', items: c.furniture, label: `Applied "${c.name}"` });
    set({ activeCandidateId: null });
  },
  setAnalysis: (patch) => set({ analysis: { ...get().analysis, ...patch, version: get().model.version } }),
  toggleLayer: (k, on) => set({ layers: { ...get().layers, [k]: on ?? !get().layers[k] } }),
  setSettings: (patch) => { const settings = { ...get().settings, ...patch }; save(LS_SETTINGS, settings); set({ settings }); },
  toast: (text, tone = 'info') => {
    const id = toastSeq++;
    set({ toasts: [...get().toasts, { id, text, tone }] });
    setTimeout(() => get().dismissToast(id), 4500);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setBusy: (busy) => set({ busy }),
}));

// Autosave the model (debounced).
let saveTimer: ReturnType<typeof setTimeout> | undefined;
useStore.subscribe((s, prev) => {
  if (s.model === prev.model) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save(LS_MODEL, s.model), 300);
});

/** Furniture currently shown: the previewed candidate if any, otherwise the model's own. */
export function useShownFurniture(): FurnitureItem[] {
  return useStore((s) => {
    if (s.activeCandidateId) {
      const c = s.candidates.find((x) => x.id === s.activeCandidateId);
      if (c) return c.furniture;
    }
    return s.model.furniture;
  });
}

export const getState = () => useStore.getState();
