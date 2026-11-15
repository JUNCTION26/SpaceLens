import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { Icon } from '../../ui/icons';
import { askAssistant, buildCommands, type Cmd } from './commands';
import { rank } from './match';

const LS_RECENT = 'spacelens.commands.recent';
const loadRecent = (): string[] => { try { const r = JSON.parse(localStorage.getItem(LS_RECENT) || '[]'); return Array.isArray(r) ? r : []; } catch { return []; } };
const saveRecent = (r: string[]) => { try { localStorage.setItem(LS_RECENT, JSON.stringify(r)); } catch { /* blocked */ } };
const BULK = new Set(['Add furniture', 'In this room']);

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);
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

  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setQ(''); setIdx(0); setRecent(loadRecent());
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      clearTimeout(t);
      const el = returnTo.current;
      setTimeout(() => { if (el && el.isConnected) el.focus(); else if (document.activeElement === document.body || !document.activeElement) (document.querySelector('main, #root') as HTMLElement | null)?.focus?.(); }, 0);
    };
  }, [open]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const commands = useMemo<Cmd[]>(() => (open ? buildCommands() : []), [open, furniture, layers]);

  const results = useMemo(() => {
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
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
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
            const head = !q.trim() && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={`${c.group}:${c.id}`}>
                {head && <div style={S.group}>{head}</div>}
                <div
                  id={`cmd-${i}`} data-i={i} role="option" aria-selected={i === idx}
                  onMouseMove={() => i !== idx && setIdx(i)} onClick={() => run(c)}
                  style={{ ...S.item, ...(i === idx ? S.active : null) }}
                >
                  <Icon name={c.icon} size={15} aria-hidden />
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

const HAIR = '1px solid var(--line)';
const S: Record<string, React.CSSProperties> = {
  backdrop: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.45)', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: '14vh 16px 16px' },
  panel: { width: '100%', maxWidth: 560, maxHeight: '64vh', display: 'flex', flexDirection: 'column', background: 'var(--panel, #fff)', color: 'var(--text, inherit)', border: HAIR, borderRadius: 12, boxShadow: 'var(--shadow-lg)', overflow: 'hidden', fontSize: 13 },
  input: { font: 'inherit', fontSize: 15, padding: '0 16px', height: 48, minHeight: 48, borderRadius: 0, boxShadow: 'none', border: 'none', borderBottom: HAIR, background: 'transparent', color: 'inherit', outline: 'none' },
  list: { overflowY: 'auto', padding: 4, flex: 1 },
  group: { fontSize: 11, fontWeight: 500, color: 'var(--muted, #888)', padding: '8px 10px 4px' },
  item: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px', height: 32, borderRadius: 6, cursor: 'pointer' },
  active: { background: 'var(--press)' },
  label: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  kbd: { font: '11px/1 ui-monospace, monospace', padding: '3px 5px', border: HAIR, borderRadius: 4, color: 'var(--muted, #888)', marginRight: 3 },
  empty: { padding: 16, textAlign: 'center', color: 'var(--muted, #888)' },
  footer: { display: 'flex', gap: 14, fontSize: 11, color: 'var(--muted, #888)', padding: '7px 12px', borderTop: HAIR },
};
