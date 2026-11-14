import { create } from 'zustand';
import { useStore } from '../core/store';

export type CaptureKind = 'scan' | 'photos' | 'draw' | 'import';
type WorkMode = 'capture' | 'design' | 'experience' | 'deliver';

export interface NavItem { key: string; label: string; icon: string; mode: WorkMode; group: string }
/** Every workspace section, in sidebar order. Mode is derived from the section. */
export const NAV: NavItem[] = [
  { key: 'capture', label: 'Capture', icon: 'camera', mode: 'capture', group: 'Space' },
  { key: 'drawings', label: 'Drawings', icon: 'file', mode: 'capture', group: 'Space' },
  { key: 'describe', label: 'Describe', icon: 'sparkles', mode: 'design', group: 'Design' },
  { key: 'layouts', label: 'Layouts', icon: 'layout', mode: 'design', group: 'Design' },
  { key: 'furniture', label: 'Furniture', icon: 'sofa', mode: 'design', group: 'Design' },
  { key: 'inspire', label: 'Inspire', icon: 'palette', mode: 'design', group: 'Design' },
  { key: 'walk', label: 'Walk & test', icon: 'walk', mode: 'experience', group: 'Experience' },
  { key: 'export', label: 'Export', icon: 'download', mode: 'deliver', group: 'Deliver' },
];
const ALIAS: Record<string, string> = { request: 'describe', intent: 'describe', simulate: 'walk', sim: 'walk', vision: 'inspire', library: 'furniture' };

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
