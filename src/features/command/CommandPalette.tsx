import { useEffect, useMemo, useRef } from 'react';
import { create } from 'zustand';
import { useStore } from '../../core/store';
import { Icon } from '../../ui/icons';
import { useUi } from '../../ui/uiStore';
import { askAssistant, buildCommands, type Cmd } from './commands';
import { rank } from './match';

const LS_RECENT = 'spacelens.commands.recent';
const loadRecent = (): string[] => { try { const r = JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); return Array.isArray(r) ? r : []; } catch { return []; } };
const saveRecent = (r: string[]) => { try { localStorage.setItem(LS_RECENT, JSON.stringify(r)); } catch { /* blocked */ } };
const BULK = new Set(['Add furniture', 'In this room']);

interface SearchState { q: string; idx: number; recent: string[]; setQ: (q: string) => void; setIdx: (i: number) => void }
/** The query lives here so the top-bar field and the results in the panel stay in step. */
export const useSearch = create<SearchState>((set) => ({
  q: '', idx: 0, recent: loadRecent(),
  setQ: (q) => set({ q, idx: 0 }),
  setIdx: (idx) => set({ idx }),
}));

const field = () => document.querySelector<HTMLInputElement>('.search-field input');
export function openSearch() {
  if (useStore.getState().mode === 'home') useUi.getState().openSection('layouts');
  useUi.getState().setSearchOpen(true);
  useSearch.setState({ recent: loadRecent(), idx: 0 });
  setTimeout(() => field()?.focus(), 0);
}
export function closeSearch() {
  useUi.getState().setSearchOpen(false);
  useSearch.setState({ q: '', idx: 0 });
}

function useResults() {
  const open = useUi((s) => s.searchOpen);
  const q = useSearch((s) => s.q);
  const recent = useSearch((s) => s.recent);
  const furniture = useStore((s) => s.model.furniture);
  const layers = useStore((s) => s.layers);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const commands = useMemo<Cmd[]>(() => (open ? buildCommands() : []), [open, furniture, layers]);
  return useMemo(() => {
    const query = q.trim();
    if (!query) {
      const byId = new Map(commands.map((c) => [c.id, c]));
      const rec = recent.map((id) => byId.get(id)).filter((c): c is Cmd => !!c).map((c) => ({ ...c, group: 'Recent' }));
      return [...rec, ...commands.filter((c) => !BULK.has(c.group))];
    }
    const out = rank(commands, query, recent);
    const text = query.replace(/^ask:?\s*/i, '');
    out.push({ id: 'ask', group: 'Ask', label: 'Ask', icon: 'sparkles', hint: text.length > 24 ? `${text.slice(0, 24)}...` : text, run: () => askAssistant(text) });
    return out;
  }, [q, commands, recent]);
}

function runCmd(c: Cmd) {
  const { recent } = useSearch.getState();
  if (c.id !== 'ask') { const r = [c.id, ...recent.filter((x) => x !== c.id)].slice(0, 5); useSearch.setState({ recent: r }); saveRecent(r); }
  closeSearch();
  field()?.blur();
  c.run();
}

/** Ctrl/Cmd+K and the "spacelens:command" event move focus to the search field in the top bar. */
export function useSearchHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (useUi.getState().searchOpen) closeSearch(); else openSearch(); }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('spacelens:command', openSearch);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('spacelens:command', openSearch); };
  }, []);
}

/** The search input in the top bar; its results replace the left panel content. */
export function SearchField() {
  const open = useUi((s) => s.searchOpen);
  const q = useSearch((s) => s.q);
  const idx = useSearch((s) => s.idx);
  const setQ = useSearch((s) => s.setQ);
  const setIdx = useSearch((s) => s.setIdx);
  const results = useResults();
  const ref = useRef<HTMLInputElement>(null);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIdx(Math.min(results.length - 1, idx + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx(Math.max(0, idx - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); const c = results[idx]; if (c) runCmd(c); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeSearch(); ref.current?.blur(); }
  };
  return (
    <label className="search-field">
      <Icon name="search" size={14} aria-hidden />
      <input
        ref={ref} value={q} placeholder="Search" aria-label="Search commands"
        onChange={(e) => { setQ(e.target.value); if (!open) openSearch(); }}
        onFocus={() => { if (!open) openSearch(); }}
        onKeyDown={onKeyDown}
        role="combobox" aria-expanded={open} aria-controls="cmd-list" aria-activedescendant={open && results[idx] ? `cmd-${idx}` : undefined}
      />
    </label>
  );
}

/** Search results shown as the left panel content while searching. */
export function SearchResults() {
  const q = useSearch((s) => s.q);
  const idx = useSearch((s) => s.idx);
  const setIdx = useSearch((s) => s.setIdx);
  const results = useResults();
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => { listRef.current?.querySelector(`[data-i="${idx}"]`)?.scrollIntoView({ block: 'nearest' }); }, [idx]);
  let lastGroup = '';
  return (
    <div id="cmd-list" role="listbox" aria-label="Results" ref={listRef} className="search-results">
      {results.length === 0 && <div className="muted">No matches</div>}
      {results.map((c, i) => {
        const head = !q.trim() && c.group !== lastGroup ? c.group : null;
        lastGroup = c.group;
        return (
          <div key={`${c.group}:${c.id}`}>
            {head && <div className="search-group">{head}</div>}
            <div
              id={`cmd-${i}`} data-i={i} role="option" aria-selected={i === idx} className={`search-item${i === idx ? ' on' : ''}`}
              onMouseMove={() => i !== idx && setIdx(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => runCmd(c)}
            >
              <Icon name={c.icon} size={15} aria-hidden />
              <span>{c.label}</span>
              {c.hint && <kbd>{c.hint}</kbd>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
