import { useEffect, useState } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { usage } from '../core/gemini';
import { useUi } from './uiStore';

export function Settings() {
  const open = useUi((s) => s.settingsOpen);
  const setOpen = useUi((s) => s.setSettingsOpen);
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(id); window.removeEventListener('keydown', onKey); };
  }, [open, setOpen]);

  if (!open) return null;
  const reset = () => {
    const s = useStore.getState();
    s.dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
    s.setMode('design');
    s.toast('Sample room loaded', 'ok');
    setOpen(false);
  };
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="dialog-head">
          <h2 id="settings-title">Settings</h2>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close">
            <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <label className="field">
          <span>Gemini API key</span>
          <input type="password" autoComplete="off" value={settings.geminiKey} onChange={(e) => setSettings({ geminiKey: e.target.value.trim() })} placeholder="Paste key" />
          <small className="muted">Saved in this browser only.</small>
        </label>
        <label className="field">
          <span>Model</span>
          <input value={settings.geminiModel} onChange={(e) => setSettings({ geminiModel: e.target.value })} onBlur={(e) => { if (!e.target.value.trim()) setSettings({ geminiModel: 'gemini-3.5-flash-lite' }); }} />
        </label>
        <div className="field">
          <span>Theme</span>
          <div className="seg" role="radiogroup" aria-label="Theme">
            {(['system', 'dark', 'light'] as const).map((t) => (
              <button key={t} role="radio" aria-checked={settings.theme === t} className={settings.theme === t ? 'on' : ''} onClick={() => setSettings({ theme: t })}>
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <span>Gemini use this session</span>
          <div className="stats3">
            <div className="stat"><b>{usage.calls}</b><span>calls</span></div>
            <div className="stat"><b>{usage.inputTokens.toLocaleString()}</b><span>tokens in</span></div>
            <div className="stat"><b>{usage.outputTokens.toLocaleString()}</b><span>tokens out</span></div>
          </div>
        </div>
        <div className="divider" />
        <button className="btn" onClick={reset}>Reset to sample room</button>
      </div>
    </div>
  );
}
