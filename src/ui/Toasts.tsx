import { useStore, type Toast } from '../core/store';
import { useNotices, type NoticeAction } from './notify';
import { useUi } from './uiStore';
import { Icon } from './icons';
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
  if (/\b(api )?key\b|gemini|quota|401|403|permission denied/i.test(s)) out.push({ label: 'Open settings', run: () => ui.setSettingsOpen(true), primary: true });
  if (/select a wall/i.test(s)) out.push({ label: 'How', run: () => useNotices.getState().push({ text: 'Click a wall on the plan, then add the door or window.', tone: 'info' }) });
  if (/locked/i.test(s)) {
    const sel = useStore.getState().selection;
    if (sel?.kind === 'furniture') out.push({ label: 'Unlock', run: () => useStore.getState().dispatch({ type: 'UPDATE_OBJECT', id: sel.id, patch: { locked: false } }), primary: true });
  }
  if (/camera|webcam|getUserMedia|NotAllowedError/i.test(s)) out.push({ label: 'Draw the room instead', run: () => ui.openCapture('draw'), primary: true });
  if (/share(d)? link|link .*(invalid|broken|expired)/i.test(s)) out.push({ label: 'Open the sample room', run: () => { useStore.getState().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() }); ui.openSection('layouts'); } });
  if (/no (room|outline|walls)/i.test(s)) out.push({ label: 'Draw the room', run: () => ui.openCapture('draw') });
  if (/overlap/i.test(s)) out.push({ label: 'Show fixes', run: () => window.dispatchEvent(new Event('spacelens:checks')), primary: true });
  if (details) out.push({ label: 'Copy details', run: () => copy(details) });
  return out.slice(0, 3);
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  const notices = useNotices((s) => s.notices);
  const dismissNotice = useNotices((s) => s.dismiss);
  const rows = [
    ...toasts.map((t) => { const f = friendly(t.text); return { key: `t${t.id}`, tone: t.tone, text: f.text, actions: actionsFor(t, f.details), close: () => dismiss(t.id) }; }),
    ...notices.map((n) => ({ key: `n${n.id}`, tone: n.tone, text: n.text, actions: n.actions, close: () => dismissNotice(n.id) })),
  ];
  return (
    <div className="toasts" aria-live="polite">
      {rows.map((r) => (
        <div key={r.key} className={`toast toast-${r.tone}${r.actions.length ? ' has-actions' : ''}`} role={r.tone === 'error' ? 'alert' : 'status'}>
          <i aria-hidden="true" />
          <span className="toast-text">{r.text}</span>
          {r.actions.length > 0 && (
            <span className="toast-actions">
              {r.actions.map((a) => (
                <button key={a.label} type="button" className={`toast-act${a.primary ? ' is-primary' : ''}`} onClick={() => { a.run(); r.close(); }}>{a.label}</button>
              ))}
            </span>
          )}
          <button type="button" className="toast-x" onClick={r.close} aria-label="Dismiss" title="Dismiss"><Icon name="x" size={14} /></button>
        </div>
      ))}
    </div>
  );
}
