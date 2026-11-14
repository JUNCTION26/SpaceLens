import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { sampleRoom } from '../../core/sample';
import type { Layers, Mode } from '../../core/types';
import { useUi } from '../../ui/uiStore';
import { CATALOG, makeItem } from '../furniture/catalog';
import { findFreeSpot } from '../objects/placement';

interface Cmd { id: string; group: string; label: string; hint?: string; keywords?: string; run: () => void }

const LS_RECENT = 'spacelens.commands.recent';
const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); } catch { return []; } };
const saveRecent = (r: string[]) => { try { localStorage.setItem(LS_RECENT, JSON.stringify(r)); } catch { /* blocked */ } };
const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** Subsequence fuzzy score; higher is better, -1 is no match. */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const i = t.indexOf(q);
  if (i >= 0) return 100 - i + (i === 0 || t[i - 1] === ' ' ? 50 : 0);
  let ti = 0, s = 0, run = 0;
  for (const ch of q) {
    const f = t.indexOf(ch, ti);
    if (f < 0) return -1;
    run = f === ti ? run + 1 : 0;
    s += 1 + run * 2;
    ti = f + 1;
  }
  return s;
}

const MODES: Mode[] = ['home', 'capture', 'design', 'experience', 'deliver'];
const LAYERS: Array<keyof Layers> = ['dimensions', 'clearance', 'routes', 'provenance', 'heat', 'sightlines'];
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const furniture = useStore((s) => s.model.furniture);
  const layers = useStore((s) => s.layers);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setOpen((o) => !o); }
    };
    const onEvt = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('spacelens:command', onEvt);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('spacelens:command', onEvt); };
  }, []);

  useEffect(() => { if (open) { setQ(''); setIdx(0); setTimeout(() => inputRef.current?.focus(), 0); } }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const st = useStore.getState;
    const list: Cmd[] = [];
    for (const m of MODES) list.push({ id: `mode:${m}`, group: 'Actions', label: `Go to ${cap(m)}`, keywords: 'mode switch', run: () => st().setMode(m) });
    for (const v of ['2d', '3d', 'split'] as const) list.push({ id: `view:${v}`, group: 'Actions', label: `View ${v.toUpperCase()}`, keywords: 'view switch', run: () => st().setView(v) });
    list.push(
      { id: 'undo', group: 'Actions', label: 'Undo', hint: 'Ctrl Z', run: () => st().undo() },
      { id: 'redo', group: 'Actions', label: 'Redo', hint: 'Ctrl Y', run: () => st().redo() },
      { id: 'sample', group: 'Actions', label: 'Open sample room', keywords: 'demo load', run: () => { st().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); st().setMode('design'); } },
      { id: 'settings', group: 'Actions', label: 'Open settings', keywords: 'gemini key theme', run: () => useUi.getState().setSettingsOpen?.(true) },
      { id: 'demo', group: 'Actions', label: 'Start guided demo', keywords: 'tour', run: () => emit('spacelens:demo') },
      { id: 'export', group: 'Actions', label: 'Export plan', keywords: 'deliver pdf print', run: () => { st().setMode('deliver'); emit('spacelens:export'); } },
      { id: 'reset-view', group: 'Actions', label: 'Reset view', keywords: 'camera zoom fit', run: () => emit('spacelens:reset-view') },
    );
    for (const k of LAYERS) list.push({ id: `layer:${k}`, group: 'Layers', label: `${layers[k] ? 'Hide' : 'Show'} ${k}`, keywords: 'toggle layer', run: () => st().toggleLayer(k) });
    for (const f of furniture) list.push({ id: `sel:${f.id}`, group: 'In this room', label: `Select ${f.name}`, keywords: f.category, run: () => { st().select({ kind: 'furniture', id: f.id }); } });
    for (const c of CATALOG) list.push({
      id: `add:${c.id}`, group: 'Add furniture', label: `Add ${c.name}`, hint: `${c.w}x${c.d} m`, keywords: `${c.category} ${c.tags.join(' ')}`,
      run: () => {
        const s = st();
        const item = makeItem(c.id);
        const spot = findFreeSpot(s.model, item);
        const placed = { ...item, ...spot };
        s.dispatch({ type: 'PLACE_OBJECT', item: placed });
        s.select({ kind: 'furniture', id: placed.id });
        s.toast(`Added ${c.name}`, 'ok');
      },
    });
    return list;
  }, [furniture, layers]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    let out: Cmd[];
    if (!query) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const rec = recent.map((id) => byId.get(id)).filter(Boolean).map((c) => ({ ...c!, group: 'Recent' }));
      out = [...rec, ...commands.filter((c) => c.group === 'Actions')];
    } else {
      out = commands
        .map((c) => ({ c, s: Math.max(score(query, c.label), score(query, c.keywords ?? '') - 20) }))
        .filter((x) => x.s >= 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, 40)
        .map((x) => x.c);
      if (query.length > 2) {
        const text = q.trim().replace(/^ask:?\s*/i, '');
        out.push({
          id: 'ask', group: 'Ask', label: `Ask: ${text}`, keywords: '',
          run: () => {
            useStore.getState().setMode('design');
            useUi.getState().setTab('design', 'request');
            setTimeout(() => emit('spacelens:request', text), 50);
          },
        });
      }
    }
    // Keep group order stable by first appearance.
    const order: string[] = [];
    for (const c of out) if (!order.includes(c.group)) order.push(c.group);
    return order.flatMap((g) => out.filter((c) => c.group === g));
  }, [q, commands, recent]);

  useEffect(() => { setIdx(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);

  const run = (c: Cmd) => {
    setOpen(false);
    if (c.id !== 'ask') { const r = [c.id, ...recent.filter((x) => x !== c.id)].slice(0, 5); setRecent(r); saveRecent(r); }
    c.run();
  };

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = results[idx]; if (c) run(c); }
    else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  };

  let lastGroup = '';
  return (
    <div onMouseDown={() => setOpen(false)} style={S.backdrop}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} style={S.panel}>
        <input
          ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKeyDown}
          placeholder="Type a command or describe a room" aria-label="Search commands"
          role="combobox" aria-expanded="true" aria-controls="cmd-list" aria-activedescendant={results[idx] ? `cmd-${idx}` : undefined}
          style={S.input}
        />
        <div id="cmd-list" role="listbox" ref={listRef} style={S.list}>
          {results.length === 0 && <div style={S.empty}>No matches</div>}
          {results.map((c, i) => {
            const head = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={`${c.group}:${c.id}`}>
                {head && <div style={S.group}>{head}</div>}
                <div
                  id={`cmd-${i}`} data-i={i} role="option" aria-selected={i === idx}
                  onMouseMove={() => i !== idx && setIdx(i)} onClick={() => run(c)}
                  style={{ ...S.item, ...(i === idx ? S.active : null) }}
                >
                  <span style={S.label}>{c.label}</span>
                  {c.hint && <kbd style={S.kbd}>{c.hint}</kbd>}
                </div>
              </div>
            );
          })}
        </div>
        <div style={S.footer}><span><kbd style={S.kbd}>↑</kbd><kbd style={S.kbd}>↓</kbd> move</span><span><kbd style={S.kbd}>Enter</kbd> run</span><span><kbd style={S.kbd}>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}

const HAIR = '1px solid var(--border, rgba(127,127,127,0.2))';
const S: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.32)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '14vh 16px 16px' },
  panel: { width: '100%', maxWidth: 560, maxHeight: '64vh', display: 'flex', flexDirection: 'column', background: 'var(--panel, #fff)', color: 'var(--text, inherit)', border: HAIR, borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.18)', overflow: 'hidden', fontSize: 13 },
  input: { font: 'inherit', fontSize: 14, padding: '12px 14px', border: 'none', borderBottom: HAIR, background: 'transparent', color: 'inherit', outline: 'none' },
  list: { overflowY: 'auto', padding: 4, flex: 1 },
  group: { fontSize: 11, fontWeight: 500, color: 'var(--muted, #888)', padding: '8px 10px 4px' },
  item: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 32, borderRadius: 6, cursor: 'pointer' },
  active: { background: 'var(--hover, rgba(127,127,127,0.12))' },
  label: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  kbd: { font: '11px/1 ui-monospace, monospace', padding: '3px 5px', border: HAIR, borderRadius: 4, color: 'var(--muted, #888)', marginRight: 3 },
  empty: { padding: 16, textAlign: 'center', color: 'var(--muted, #888)' },
  footer: { display: 'flex', gap: 14, fontSize: 11, color: 'var(--muted, #888)', padding: '7px 12px', borderTop: HAIR },
};
