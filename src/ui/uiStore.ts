import { create } from 'zustand';
import { useStore } from '../core/store';

export type CaptureKind = 'scan' | 'photos' | 'draw' | 'import';

interface UiState {
  tabByMode: Record<string, string>;
  captureKind: CaptureKind | null;
  settingsOpen: boolean;
  inspectorOpen: boolean;
  mobilePane: 'side' | 'inspector';
  setTab: (mode: string, key: string) => void;
  openCapture: (kind: CaptureKind) => void;
  setSettingsOpen: (on: boolean) => void;
  toggleInspector: () => void;
  setMobilePane: (p: 'side' | 'inspector') => void;
}

export const useUi = create<UiState>((set, get) => ({
  tabByMode: {},
  captureKind: null,
  settingsOpen: false,
  inspectorOpen: true,
  mobilePane: 'side',
  setTab: (mode, key) => set({ tabByMode: { ...get().tabByMode, [mode]: key } }),
  openCapture: (kind) => {
    set({ captureKind: kind, mobilePane: 'side', tabByMode: { ...get().tabByMode, capture: kind === 'import' ? 'drawings' : 'capture' } });
    useStore.getState().setMode('capture');
  },
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  toggleInspector: () => set({ inspectorOpen: !get().inspectorOpen }),
  setMobilePane: (mobilePane) => set({ mobilePane }),
}));
