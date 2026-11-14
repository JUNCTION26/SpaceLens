import { create } from 'zustand';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { OPTIONAL_PANELS } from './sections';

export type CaptureKind = 'scan' | 'photos' | 'draw' | 'import';
type WorkMode = 'capture' | 'design' | 'experience' | 'deliver';

export interface NavItem { key: string; label: string; icon: string; mode: WorkMode; group: string; hint: string }
const ALL_NAV: NavItem[] = [
  { key: 'capture', label: 'Capture', icon: 'camera', mode: 'capture', group: 'Space', hint: 'Measure the room by photo, camera or drawing.' },
  { key: 'building', label: 'Building', icon: 'grid', mode: 'capture', group: 'Space', hint: 'Plan the walls across a whole floor.' },
  { key: 'drawings', label: 'Drawings', icon: 'file', mode: 'capture', group: 'Space', hint: 'Import plans and ask questions about them.' },
  { key: 'describe', label: 'Describe', icon: 'sparkles', mode: 'design', group: 'Design', hint: 'Say who uses the space and how.' },
  { key: 'layouts', label: 'Layouts', icon: 'layout', mode: 'design', group: 'Design', hint: 'Compare layouts that fit the room.' },
  { key: 'furniture', label: 'Furniture', icon: 'sofa', mode: 'design', group: 'Design', hint: 'Browse pieces and drag them onto the plan.' },
  { key: 'create', label: 'Create object', icon: 'cube', mode: 'design', group: 'Design', hint: 'Make a custom piece from a description.' },
  { key: 'shop', label: 'Shop', icon: 'search', mode: 'design', group: 'Design', hint: 'Find real products that fit.' },
  { key: 'inspire', label: 'Inspire', icon: 'palette', mode: 'design', group: 'Design', hint: 'Take a style from a photo.' },
  { key: 'walk', label: 'Walk & test', icon: 'walk', mode: 'experience', group: 'Experience', hint: 'Walk through and test every route.' },
  { key: 'safety', label: 'Safety', icon: 'shield', mode: 'experience', group: 'Experience', hint: 'Check exits, reach and hazards.' },
  { key: 'export', label: 'Export', icon: 'download', mode: 'deliver', group: 'Deliver', hint: 'Plans, images and a shopping list.' },
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
  setTab: (mode, key) => set({ tabByMode: { ...get().tabByMode, [mode]: resolveNav(mode, key).key } }),
  openSection: (key) => {
    const n = NAV.find((x) => x.key === (ALIAS[key] ?? key)) ?? NAV[0];
    set({ mobilePane: 'side', tabByMode: { ...get().tabByMode, [n.mode]: n.key } });
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
 * Deep links for demos and review: ?nav=<section>&sample=1&view=<2d|split|3d>&theme=<dark|light|system>&coach=0&open=<settings|command|checks|demo>
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
  const open = q.get('open');
  if (open === 'settings') useUi.getState().setSettingsOpen(true);
  else if (open) setTimeout(() => window.dispatchEvent(new Event(`spacelens:${open}`)), 300);
}
