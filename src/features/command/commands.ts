import { emptyModel, sampleRoom } from '../../core/sample';
import { useStore } from '../../core/store';
import type { Layers } from '../../core/types';
import { useUi, NAV } from '../../ui/uiStore';
import { CATALOG, makeItem } from '../furniture/catalog';
import { findFreeSpot } from '../objects/placement';

export interface Cmd {
  id: string;
  group: string;
  /** One to three words. */
  label: string;
  icon: string;
  /** Synonyms searched alongside the label. */
  words?: string;
  hint?: string;
  run: () => void;
}

export const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));
const later = (fn: () => void, ms = 350) => { setTimeout(fn, ms); };
const st = () => useStore.getState();
const short = (s: string) => s.split(' ').slice(0, 3).join(' ');

/** Extra search words per navigation key. */
const NAV_WORDS: Record<string, string> = {
  capture: 'scan camera room measure photo',
  drawings: 'plan import pdf dxf drawing',
  building: 'floor storey building whole',
  describe: 'ask say request chat',
  layouts: 'layout compare options',
  inspire: 'inspire inspiration style taste photo',
  furniture: 'library catalog add furniture',
  create: 'forge custom make piece',
  shop: 'store buy products find',
  budget: 'cost price money',
  walk: 'walkthrough first person',
  safety: 'exits hazards fire',
  export: 'deliver pdf print share',
  movein: 'move in movein carry delivery doorway',
  render: 'picture image photo realistic',
};
const LAYER_LIST: Array<keyof Layers> = ['dimensions', 'clearance', 'routes', 'provenance', 'heat', 'sightlines'];

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
const fileBase = () => st().model.name.replace(/[^\w .-]/g, '_') || 'space';

function pickFile(accept: string, onFile: (f: File) => void) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = accept; input.hidden = true;
  input.onchange = () => { const f = input.files?.[0]; if (f) onFile(f); input.remove(); };
  document.body.appendChild(input);
  input.click();
}

function ensure3d() { if (st().view === '2d') st().setView('split'); }

export function buildCommands(): Cmd[] {
  const L: Cmd[] = [];
  const add = (c: Cmd) => L.push(c);
  for (const n of NAV) {
    add({ id: `nav:${n.key}`, group: 'Go to', label: n.label, icon: n.icon, words: `${n.hint} ${n.group} ${NAV_WORDS[n.key] ?? ''}`, run: () => useUi.getState().openSection(n.key) });
  }
  for (const [v, label, words] of [['2d', '2D', 'plan top flat'], ['3d', '3D', 'model scene only'], ['split', 'Split', 'both side by side']] as const) {
    add({ id: `view:${v}`, group: 'View', label: `View ${label}`, icon: 'layout', words: `view ${words}`, run: () => st().setView(v) });
  }
  add({ id: 'fullscreen', group: 'View', label: 'Full screen', icon: 'maximize', words: 'fullscreen presentation present kiosk', run: () => {
    if (document.fullscreenElement) void document.exitFullscreen?.(); else void document.documentElement.requestFullscreen?.();
  } });
  add({ id: 'reset-view', group: 'View', label: 'Reset view', icon: 'rotate', words: 'camera zoom fit', run: () => emit('spacelens:reset-view') });
  add({ id: 'walk', group: 'Review', label: 'Start walk', icon: 'walk', words: 'walk through first person stroll', run: () => { ensure3d(); useUi.getState().openSection('walk'); later(() => emit('spacelens:walk')); } });
  add({ id: 'tour', group: 'Review', label: 'Auto tour', icon: 'play', words: 'tour flythrough fly camera automatic', run: () => { ensure3d(); useUi.getState().openSection('walk'); later(() => emit('spacelens:auto-tour'), 500); } });
  add({ id: 'guided', group: 'Review', label: 'Guided demo', icon: 'info', words: 'demo guide present showcase', run: () => emit('spacelens:demo') });
  add({ id: 'undo', group: 'Edit', label: 'Undo', icon: 'undo', hint: 'Ctrl Z', words: 'back revert', run: () => st().undo() });
  add({ id: 'redo', group: 'Edit', label: 'Redo', icon: 'redo', hint: 'Ctrl Y', words: 'forward again', run: () => st().redo() });
  add({ id: 'clear', group: 'Edit', label: 'Clear room', icon: 'trash', words: 'empty reset new blank delete all start over', run: () => st().dispatch({ type: 'REPLACE_MODEL', model: emptyModel() }) });
  add({ id: 'sample', group: 'Load', label: 'My room', icon: 'home', words: 'sample demo room example starter', run: () => { st().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); useUi.getState().openSection('describe'); } });
  for (const [k, label, words] of [['villa', 'Demo villa', 'house home'], ['office', 'Demo office', 'work company'], ['lshape', 'Demo L-shape', 'l shape corner floor']] as const) {
    add({ id: `demo:${k}`, group: 'Load', label, icon: 'grid', words: `demo load building ${words}`, run: () => {
      void import('../building/demo').then((m) => m.loadDemo(k, true)).then(() => useUi.getState().openSection('building'));
    } });
  }
  add({ id: 'photo', group: 'Load', label: 'Room from photo', icon: 'image', words: 'photo picture camera capture image scan', run: () => useUi.getState().openCapture('photos') });
  add({ id: 'open-dxf', group: 'Load', label: 'Open DXF', icon: 'file', words: 'import cad autocad drawing file', run: () => pickFile('.dxf', (f) => {
    void f.text().then(async (t) => {
      const { dxfToModel } = await import('../formats/dxfRead');
      st().dispatch({ type: 'REPLACE_MODEL', model: dxfToModel(t, f.name).model });
      useUi.getState().openSection('capture');
    });
  }) });
  add({ id: 'export-ifc', group: 'Share', label: 'Export IFC', icon: 'download', words: 'bim revit building download', run: () => {
    void import('../formats/ifcWrite').then((m) => download(`${fileBase()}.ifc`, 'application/x-step', m.modelToIfc(st().model)));
  } });
  add({ id: 'export-dxf', group: 'Share', label: 'Export DXF', icon: 'download', words: 'cad autocad drawing download', run: () => {
    void import('../formats/dxfWrite').then((m) => download(`${fileBase()}.dxf`, 'application/dxf', m.modelToDxf(st().model)));
  } });
  add({ id: 'export-plan', group: 'Share', label: 'Export plan', icon: 'file', words: 'pdf print sheet deliver', run: () => { useUi.getState().openSection('export'); later(() => emit('spacelens:export')); } });
  add({ id: 'shopping', group: 'Share', label: 'Shopping list', icon: 'check', words: 'buy products list cart shop', run: () => useUi.getState().openSection('export') });
  add({ id: 'share', group: 'Share', label: 'Share link', icon: 'share', words: 'copy url send link', run: () => {
    void import('../export/share').then(async (m) => {
      const url = await m.shareLink(st().model);
      try { await navigator.clipboard.writeText(url); st().toast('Link copied', 'ok'); } catch { st().toast('Link not copied', 'warn'); }
    });
  } });
  add({ id: 'theme-light', group: 'Settings', label: 'Light theme', icon: 'sun', words: 'light day bright theme mode white', run: () => st().setSettings({ theme: 'light' }) });
  add({ id: 'theme-dark', group: 'Settings', label: 'Dark theme', icon: 'moon', words: 'dark night theme mode black', run: () => st().setSettings({ theme: 'dark' }) });
  add({ id: 'settings', group: 'Settings', label: 'Settings', icon: 'settings', words: 'gemini key preferences options', run: () => useUi.getState().setSettingsOpen(true) });
  const layers = st().layers;
  for (const k of LAYER_LIST) add({ id: `layer:${k}`, group: 'Layers', label: `${layers[k] ? 'Hide' : 'Show'} ${k}`, icon: 'eye', words: 'toggle layer overlay', run: () => st().toggleLayer(k) });
  for (const f of st().model.furniture) add({ id: `sel:${f.id}`, group: 'In this room', label: short(`Select ${f.name}`), icon: 'sofa', words: f.category, run: () => st().select({ kind: 'furniture', id: f.id }) });
  for (const c of CATALOG) add({
    id: `add:${c.id}`, group: 'Add furniture', label: short(`Add ${c.name}`), icon: 'plus', hint: `${c.w}x${c.d} m`, words: `${c.category} ${c.tags.join(' ')}`,
    run: () => {
      const s = st();
      const item = makeItem(c.id);
      const placed = { ...item, ...findFreeSpot(s.model, item) };
      s.dispatch({ type: 'PLACE_OBJECT', item: placed });
      s.select({ kind: 'furniture', id: placed.id });
      s.toast(`Added ${c.name}`, 'ok');
    },
  });
  return L;
}

/** Send free text to the assistant. */
export function askAssistant(text: string) {
  void import('../agent/brain').then((m) => m.runTurn(text));
}
