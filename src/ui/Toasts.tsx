import { useEffect, useRef, useState } from 'react';
import { useStore, type Toast } from '../core/store';
import { useNotices, type NoticeAction } from './notify';
import { useUi } from './uiStore';
import { sampleRoom } from '../core/sample';

/** Text that reads like a raw exception rather than a sentence for people. */
const RAW = /(TypeError|ReferenceError|SyntaxError|RangeError|Uncaught|undefined is not|Cannot read propert|\bat \w+ \(|https?:\/\/\S{60,}|\{".*":)/;
export function friendly(text: string): { text: string; details?: string } {
  if (RAW.test(text) || text.length > 220) return { text: 'Something went wrong. Your work is safe.', details: text };
  return { text };
}

const copy = (s: string) => { try { void navigator.clipboard?.writeText(s); } catch { /* clipboard blocked */ } };

/** Buttons that fix the usual causes of a warning, so a notice is never a dead end. */
function actionsFor(t: Toast, details?: string): NoticeAction[] {
  const ui = useUi.getState();
  const out: NoticeAction[] = [];
  if (t.tone === 'info' || t.tone === 'ok') return out;
  const s = t.text;
  if (/\b(api )?key\b|gemini|quota|401|403|permission denied/i.test(s)) out.push({ label: 'Settings', run: () => ui.setSettingsOpen(true), primary: true });
  if (/select a wall/i.test(s)) out.push({ label: 'How', run: () => useNotices.getState().push({ text: 'Click a wall on the plan, then add the door or window.', tone: 'info' }) });
  if (/locked/i.test(s)) {
    const sel = useStore.getState().selection;
    if (sel?.kind === 'furniture') out.push({ label: 'Unlock', run: () => useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: { locked: false } }), primary: true });
  }
  if (/camera|webcam|getUserMedia|NotAllowedError/i.test(s)) out.push({ label: 'Draw', run: () => ui.openCapture('draw'), primary: true });
  if (/share(d)? link|link .*(invalid|broken|expired)/i.test(s)) out.push({ label: 'My room', run: () => { useStore.getState().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); ui.openSection('layouts'); } });
  if (/no (room|outline|walls)/i.test(s)) out.push({ label: 'Draw', run: () => ui.openCapture('draw') });
  if (/overlap/i.test(s)) out.push({ label: 'Fixes', run: () => ui.openSection('checks'), primary: true });
  if (details) out.push({ label: 'Copy', run: () => copy(details) });
  return out.slice(0, 3);
}

interface Row { key: string; tone: Toast['tone']; text: string; action?: NoticeAction; close: () => void }

/**
 * The latest message as one quiet line pinned to the bottom of the left panel.
 * The store's toast() and notify() feed it; only the newest message shows, then it fades.
 */
export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const notices = useNotices((s) => s.notices);
  const dismissNotice = useNotices((s) => s.dismiss);
  const [cur, setCur] = useState<Row | null>(null);
  const seen = useRef(new Set<string>());
  useEffect(() => {
    const rows: Row[] = [
      ...toasts.map((t) => { const f = friendly(t.text); const a = actionsFor(t, f.details); return { key: `t${t.id}`, tone: t.tone, text: f.text, action: a.find((x) => x.primary) ?? a[0], close: () => dismiss(t.id) }; }),
      ...notices.map((n) => ({ key: `n${n.id}`, tone: n.tone, text: n.text, action: n.actions.find((x) => x.primary) ?? n.actions[0], close: () => dismissNotice(n.id) })),
    ];
    const fresh = rows.filter((r) => !seen.current.has(r.key));
    fresh.forEach((r) => seen.current.add(r.key));
    if (fresh.length) setCur(fresh[fresh.length - 1]);
  }, [toasts, notices, dismiss, dismissNotice]);
  useEffect(() => {
    if (!cur) return;
    const t = setTimeout(() => setCur(null), cur.action ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [cur]);
  const tone = cur && (cur.tone === 'error' || cur.tone === 'warn') ? ' is-warn' : '';
  return (
    <div className="status-line" aria-live="polite">
      {cur && (
        <div key={cur.key} className={`status-msg${tone}${cur.action ? ' has-action' : ''}`} title={cur.text}>
          <span className="status-text">{cur.text}</span>
          {cur.action && <button type="button" className="status-act" onClick={() => { cur.action?.run(); cur.close(); setCur(null); }}>{cur.action.label}</button>}
        </div>
      )}
    </div>
  );
}
