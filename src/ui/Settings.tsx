import { useEffect, useRef, useState } from 'react';
import { useStore } from '../core/store';
import { sampleRoom } from '../core/sample';
import { usage } from '../core/gemini';
import { aiProbeResults, aiRoute, aiTaskStats, candidatesFor, estimateCostUsd, getOverrides, probeModels, setOverride, shortModel, TASKS, type AiTask, type ModelStatus } from '../core/ai';
import { applyVoicePreference, neuralVoiceWanted } from '../features/agent/neuralVoice';
import { useUi } from './uiStore';
import { apiBase } from '../core/ai/transport';
import './shell.css';

const SHORTCUTS: Array<[string, string]> = [
  ['Ctrl/Cmd + K', 'Search'],
  ['1–4', 'Sections'],
  ['Ctrl/Cmd + Z', 'Undo'],
  ['Ctrl/Cmd + Y', 'Redo'],
  ['Esc', 'Close'],
  ['Shift + F', 'Full screen'],
  ['F', 'Zoom to item'],
  ['0 / Home', 'Reset view'],
  ['R / Q / E', 'Rotate'],
  ['L', 'Lock'],
  ['Ctrl/Cmd + D', 'Duplicate'],
  ['Del', 'Delete'],
  ['W A S D', 'Walk'],
];

/** Settings as the left panel content; the gear or any destination leaves it. */
export function Settings() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const reset = () => {
    const s = useStore.getState();
    s.dispatch({ type: 'REPLACE_MODEL', model: { ...sampleRoom(), name: 'My room' } });
    s.toast('Room loaded', 'ok');
    useUi.getState().openSection('layouts');
  };
  return (
    <div className="settings-panel">
      <header className="panel-col-head"><h1>Settings</h1></header>
      <section className="settings-group" aria-labelledby="sg-look">
        <h3 id="sg-look">Look</h3>
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
      </section>
      <section className="settings-group" aria-labelledby="sg-assistant">
        <h3 id="sg-assistant">Assistant <AiDot /></h3>
        <VoiceField />
      </section>
      <details className="settings-group settings-adv">
        <summary><h3>Advanced</h3><ServerDot /></summary>
        <KeyField />
        <AiSpeed hasKey={Boolean(settings.geminiKey)} />
        <ModelChoice />
        <SessionMeter />
      </details>
      <details className="settings-group settings-adv">
        <summary><h3>More</h3></summary>
        <div className="settings-row">
          <button className="btn btn-sm" onClick={() => window.dispatchEvent(new Event('spacelens:demo'))}>Demo</button>
          <button className="btn btn-sm" onClick={reset}>My room</button>
        </div>
      </details>
      <details className="settings-group settings-adv settings-keys">
        <summary><h3>Shortcuts</h3></summary>
        <dl>{SHORTCUTS.map(([k, d]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{d}</dd></div>)}</dl>
      </details>
    </div>
  );
}

const serverOn = () => Boolean(apiBase());
/** Green when the assistant can answer: a personal key or the server. */
function AiDot() {
  const hasKey = useStore((s) => Boolean(s.settings.geminiKey));
  const on = hasKey || serverOn();
  return <i className={`shell-dot ${on ? 'ok' : 'off'}`} role="img" aria-label={on ? 'Assistant ready' : 'Assistant offline'} title={on ? 'Ready' : 'Offline'} />;
}
function ServerDot() {
  const on = serverOn();
  return <span className="shell-dotline"><i className={`shell-dot ${on ? 'ok' : 'off'}`} aria-hidden="true" />{on ? 'Online' : 'Offline'}</span>;
}

const fmtMs = (ms: number | null) => (ms === null ? '–' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function routeSummary(tasks: AiTask[]) {
  const picks = tasks.map((t) => (aiRoute(t)[0] ? shortModel(aiRoute(t)[0]) : '–'));
  if (picks.every((p) => p === picks[0])) return `All tasks: ${picks[0]}`;
  return tasks.map((t, i) => `${t}: ${picks[i]}`).join(' · ');
}

/** "Fast decisions: 4-hydrogen, 0.6 s. Design reasoning: 4-carbon, 1.9 s." from the latest speed test. */
export function connectSummary(): string {
  const rows = aiProbeResults();
  const part = (label: string, task: AiTask) => {
    const m = aiRoute(task)[0];
    const r = rows.find((x) => x.model === m);
    return m && r?.ok && r.totalMs !== null ? `${label}: ${shortModel(m)}, ${secs(r.totalMs)}` : null;
  };
  return [part('Fast decisions', 'fast'), part('Design reasoning', 'smart')].filter(Boolean).join('. ') + '.';
}

type KeyState = 'idle' | 'checking' | 'ok' | 'quota' | 'invalid' | 'offline';

function KeyField() {
  const key = useStore((s) => s.settings.geminiKey);
  const setSettings = useStore((s) => s.setSettings);
  const [state, setState] = useState<KeyState>('idle');
  const [summary, setSummary] = useState('');
  const run = useRef(0);

  // Every new key is checked and speed-tested once, then models switch automatically.
  useEffect(() => {
    const id = ++run.current;
    if (!key) { setState('idle'); setSummary(''); return; }
    setState('checking');
    const t = setTimeout(async () => {
      const rows = await probeModels({ force: true });
      if (id !== run.current) return;
      if (rows.some((r) => r.ok)) { setState('ok'); setSummary(connectSummary()); }
      else if (rows.some((r) => r.reason === 'invalid_key')) setState('invalid');
      else if (rows.some((r) => r.reason === 'quota')) setState('quota');
      else setState('offline');
    }, 500);
    return () => clearTimeout(t);
  }, [key]);

  const paste = async () => {
    try { const t = (await navigator.clipboard.readText()).trim(); if (t) setSettings({ geminiKey: t }); } catch { /* clipboard blocked: paste by hand */ }
  };
  const say: Record<KeyState, string> = {
    idle: '',
    checking: 'Checking',
    ok: summary || 'Works',
    quota: 'Limit reached',
    invalid: 'Not accepted',
    offline: 'Unreachable',
  };
  return (
    <div className="field">
      <span>Key</span>
      <div className="settings-inline">
        <input type="password" autoComplete="off" aria-label="Gemini API key" value={key} onChange={(e) => setSettings({ geminiKey: e.target.value.trim() })} placeholder="Paste key" />
        <button className="btn btn-sm" onClick={paste}>Paste</button>
      </div>
      <small className={state === 'invalid' || (state === 'offline' && !serverOn()) ? '' : 'muted'} role="status">{say[state]}</small>
    </div>
  );
}

const TASK_LABEL: Record<AiTask, string> = { fast: 'Fast decisions', smart: 'Design reasoning', vision: 'Reading images' };

function ModelChoice() {
  const [over, setOver] = useState(getOverrides());
  const change = (t: AiTask, m: string) => { setOverride(t, m); setOver(getOverrides()); };
  return (
    <details className="field">
      <summary>Models</summary>
      {TASKS.map((t) => (
        <label key={t} className="settings-task">
          <span>{TASK_LABEL[t]}</span>
          <select value={over[t] ?? ''} onChange={(e) => change(t, e.target.value)}>
            <option value="">Auto</option>
            {candidatesFor(t).map((m) => <option key={m} value={m}>{shortModel(m)}</option>)}
          </select>
        </label>
      ))}
    </details>
  );
}

function SessionMeter() {
  const rows = aiTaskStats();
  const cost = estimateCostUsd();
  return (
    <div className="field">
      <span>Usage</span>
      <div className="stats3">
        <div className="stat"><b>{usage.calls}</b><span>Calls</span></div>
        <div className="stat"><b>{(usage.inputTokens + usage.outputTokens).toLocaleString()}</b><span>Tokens</span></div>
        <div className="stat"><b>{usage.calls === 0 ? '–' : cost === null ? '–' : `$${cost < 0.01 ? '<0.01' : cost.toFixed(2)}`}</b><span>Cost</span></div>
      </div>
      {rows.length > 0 && (
        <small className="muted">{rows.map((r) => `${TASK_LABEL[r.task]}: ${secs(r.avgMs)} avg (${r.calls})`).join(' · ')}</small>
      )}
    </div>
  );
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
      <span>Speed</span>
      <div className="settings-inline">
        <button className="btn btn-sm" onClick={test} disabled={!hasKey || running}>{running ? 'Testing' : 'Test'}</button>
        {rows.length > 0 && !running && (
          <small className="muted">{routeSummary(tasks)}</small>
        )}
      </div>
      {rows.length > 0 && (
        <table className="settings-table">
          <thead className="muted">
            <tr><th>Model</th><th>First</th><th>Total</th><th>Status</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td>{shortModel(r.model)}</td>
                <td>{fmtMs(r.firstTokenMs)}</td>
                <td>{fmtMs(r.totalMs)}</td>
                <td className={r.ok ? 'cut' : 'cut muted'} title={r.error}>{r.ok ? 'OK' : r.error ?? 'failed'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function VoiceField() {
  const hasKey = useStore((s) => Boolean(s.settings.geminiKey));
  const [on, setOn] = useState(neuralVoiceWanted());
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const toggle = async (v: boolean) => {
    setOn(v); setBusy(true);
    try { const c = await applyVoicePreference(v); setNote(v ? c.note : ''); } finally { setBusy(false); }
  };
  const enabled = hasKey || serverOn();
  return (
    <div className="field">
      <span>Voice</span>
      <div className="seg" role="radiogroup" aria-label="Voice">
        {([['Browser', false], ['Gemini', true]] as const).map(([l, v]) => (
          <button key={l} role="radio" aria-checked={on === v} className={on === v ? 'on' : ''} disabled={busy || (v && !enabled)} onClick={() => void toggle(v)}>{l}</button>
        ))}
      </div>
      <small className="muted sr-only" role="status">{busy ? 'Testing the voice' : note}</small>
    </div>
  );
}
