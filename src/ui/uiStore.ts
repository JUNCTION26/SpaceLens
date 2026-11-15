import { create } from 'zustand';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { OPTIONAL_PANELS } from './sections';

export type CaptureKind = 'scan' | 'photos' | 'draw' | 'import';
type WorkMode = 'capture' | 'design' | 'experience' | 'deliver';

export interface NavItem { key: string; label: string; icon: string; mode: WorkMode; group: string; hint: string }
const ALL_NAV: NavItem[] = [
  { key: 'capture', label: 'Measure', icon: 'camera', mode: 'capture', group: 'Space', hint: 'Measure the room' },
  { key: 'drawings', label: 'Drawings', icon: 'file', mode: 'capture', group: 'Space', hint: 'Import a plan' },
  { key: 'building', label: 'Floor', icon: 'grid', mode: 'capture', group: 'Space', hint: 'Plan a whole floor' },
  { key: 'describe', label: 'Describe', icon: 'sparkles', mode: 'design', group: 'Design', hint: 'Say what you need' },
  { key: 'layouts', label: 'Layouts', icon: 'layout', mode: 'design', group: 'Design', hint: 'Compare layouts' },
  { key: 'inspire', label: 'Style', icon: 'palette', mode: 'design', group: 'Design', hint: 'Style from a photo' },
  { key: 'furniture', label: 'Library', icon: 'sofa', mode: 'design', group: 'Furnish', hint: 'Add furniture' },
  { key: 'create', label: 'Create', icon: 'cube', mode: 'design', group: 'Furnish', hint: 'Make a custom piece' },
  { key: 'shop', label: 'Shop', icon: 'search', mode: 'design', group: 'Furnish', hint: 'Find real products' },
  { key: 'budget', label: 'Budget', icon: 'check', mode: 'design', group: 'Furnish', hint: 'Stay on budget' },
  { key: 'walk', label: 'Walk', icon: 'walk', mode: 'experience', group: 'Review', hint: 'Walk through' },
  { key: 'safety', label: 'Safety', icon: 'shield', mode: 'experience', group: 'Review', hint: 'Exits and hazards' },
  { key: 'export', label: 'Export', icon: 'download', mode: 'deliver', group: 'Share', hint: 'Plans and lists' },
  { key: 'movein', label: 'Move in', icon: 'door', mode: 'deliver', group: 'Share', hint: 'Carry-in check' },
  { key: 'render', label: 'Render', icon: 'image', mode: 'deliver', group: 'Share', hint: 'Picture of the room' },
];
/** Top-level destinations in the sidebar; each holds a few sections shown as a segmented control. */
export const GROUPS: Array<{ key: string; icon: string }> = [
  { key: 'Space', icon: 'ruler' }, { key: 'Design', icon: 'sparkles' }, { key: 'Furnish', icon: 'sofa' },
  { key: 'Review', icon: 'walk' }, { key: 'Share', icon: 'share' },
];
/** Every workspace section, in sidebar order. Optional sections appear once their panel exists. */
export const NAV: NavItem[] = ALL_NAV.filter((n) => !(n.key in OPTIONAL_PANELS) || OPTIONAL_PANELS[n.key]);
const ALIAS: Record<string, string> = { forge: 'create', store: 'shop', stores: 'shop', request: 'describe', intent: 'describe', simulate: 'walk', sim: 'walk', vision: 'inspire', library: 'furniture' };

/** Resolve the active section for a mode from the remembered tab key. */
export function resolveNav(mode: string, key: string | undefined): NavItem {
  const k = key ? ALIAS[key] ?? key : undefined;
  return NAV.find((n) => n.key === k && n.mode === mode) ?? NAV.find((n) => n.mode === mode) ?? NAV[0];
}

function readCollapsed() { try { return localStorage.getItem('spacelens:navCollapsed') === '1'; } catch { return false; } }

interface UiState {
  tabByMode: Record<string, string>;
  captureKind: CaptureKind | null;
  settingsOpen: boolean;
  inspectorOpen: boolean;
  mobilePane: 'side' | 'inspector';
  navCollapsed: boolean;
  /** Last section opened in each sidebar group, so a group reopens where the person left it. */
  lastByGroup: Record<string, string>;
  openGroup: (group: string) => void;
  setTab: (mode: string, key: string) => void;
  openSection: (key: string) => void;
  openCapture: (kind: CaptureKind) => void;
  setSettingsOpen: (on: boolean) => void;
  toggleInspector: () => void;
  setMobilePane: (p: 'side' | 'inspector') => void;
  toggleNav: () => void;
}

export const useUi = create<UiState>((set, get) => ({
  tabByMode: {},
  captureKind: null,
  settingsOpen: false,
  inspectorOpen: true,
  mobilePane: 'side',
  navCollapsed: readCollapsed(),
  lastByGroup: {},
  openGroup: (group) => {
    const key = get().lastByGroup[group] ?? NAV.find((n) => n.group === group)?.key;
    if (key) get().openSection(key);
  },
  setTab: (mode, key) => set({ tabByMode: { ...get().tabByMode, [mode]: resolveNav(mode, key).key } }),
  openSection: (key) => {
    const n = NAV.find((x) => x.key === (ALIAS[key] ?? key)) ?? NAV[0];
    set({ mobilePane: 'side', tabByMode: { ...get().tabByMode, [n.mode]: n.key }, lastByGroup: { ...get().lastByGroup, [n.group]: n.key } });
    useStore.getState().setMode(n.mode);
  },
  openCapture: (kind) => {
    set({ captureKind: kind });
    get().openSection(kind === 'import' ? 'drawings' : 'capture');
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleInspector: () => set({ inspectorOpen: !get().inspectorOpen }),
  setMobilePane: (mobilePane) => set({ mobilePane }),
  toggleNav: () => {
    const navCollapsed = !get().navCollapsed;
    try { localStorage.setItem('spacelens:navCollapsed', navCollapsed ? '1' : '0'); } catch { /* ignore */ }
    set({ navCollapsed });
  },
}));

/**
 * Deep links for demos and review: ?start=<plan|villa|room>&nav=<section>&sample=1&view=<2d|split|3d>&theme=<dark|light|system>&coach=0&open=<settings|command|checks|demo>
 * Runs once before the first render.
 */
export function applyDeepLink(search: string = typeof location !== 'undefined' ? location.search : '') {
  const q = new URLSearchParams(search);
  if (![...q.keys()].length) return;
  const s = useStore.getState();
  const theme = q.get('theme');
  if (theme === 'dark' || theme === 'light' || theme === 'system') s.setSettings({ theme });
  if (q.get('coach') === '0') { try { localStorage.setItem('spacelens.coach.done.v1', '1'); } catch { /* blocked */ } }
  if (q.get('sample') === '1') s.dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
  const view = q.get('view');
  if (view === '2d' || view === 'split' || view === '3d') s.setView(view);
  const nav = q.get('nav');
  if (nav) useUi.getState().openSection(nav);
  const start = q.get('start');
  if (start) setTimeout(() => { void import('../features/demo/starts').then((m) => m.runStart(start)); }, 0);
  const open = q.get('open');
  if (open === 'settings') useUi.getState().setSettingsOpen(true);
  else if (open) setTimeout(() => window.dispatchEvent(new Event(`spacelens:${open}`)), 300);
}
