import { useEffect, useState } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { usage } from '../core/gemini';
import { aiProbeResults, aiRoute, probeModels, shortModel, type AiTask, type ModelStatus } from '../core/ai';
import { useUi } from './uiStore';
import { Icon } from './icons';

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
            <Icon name="x" size={16} />
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
        <AiSpeed hasKey={Boolean(settings.geminiKey)} />
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

const fmtMs = (ms: number | null) => (ms === null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const cell = { padding: '3px 8px 3px 0', textAlign: 'left' as const, fontVariantNumeric: 'tabular-nums' as const };

function routeSummary(tasks: AiTask[]) {
  const picks = tasks.map((t) => (aiRoute(t)[0] ? shortModel(aiRoute(t)[0]) : '–'));
  if (picks.every((p) => p === picks[0])) return `All tasks: ${picks[0]}`;
  return tasks.map((t, i) => `${t}: ${picks[i]}`).join(' · ');
}

function AiSpeed({ hasKey }: { hasKey: boolean }) {
  const [rows, setRows] = useState<ModelStatus[]>(() => aiProbeResults());
  const [running, setRunning] = useState(false);
  const test = async () => {
    setRunning(true);
    try { setRows(await probeModels({ force: true, onUpdate: setRows })); } finally { setRunning(false); }
  };
  const tasks: AiTask[] = ['fast', 'smart', 'vision'];
  return (
    <div className="field">
      <span>AI speed</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="btn btn-sm" onClick={test} disabled={!hasKey || running}>{running ? 'Testing…' : 'Test speed'}</button>
        {rows.length > 0 && !running && (
          <small className="muted">{routeSummary(tasks)}</small>
        )}
      </div>
      {rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--fs-sm)' }}>
          <thead className="muted">
            <tr><th style={cell}>Model</th><th style={cell}>First token</th><th style={cell}>Total</th><th style={cell}>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td style={cell}>{shortModel(r.model)}</td>
                <td style={cell}>{fmtMs(r.firstTokenMs)}</td>
                <td style={cell}>{fmtMs(r.totalMs)}</td>
                <td style={{ ...cell, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} className={r.ok ? '' : 'muted'} title={r.error}>{r.ok ? 'OK' : r.error ?? 'failed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
