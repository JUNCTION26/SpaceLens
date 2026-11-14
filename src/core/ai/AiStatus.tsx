import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { useUi } from '../../ui/uiStore';
import { onAiActivity, onProbeUpdate, aiRoute } from './index';
import { shortModel } from './models';
import { problemFor, type AiAction, type AiReason } from './errors';
import './ai.css';

const openSettings = () => useUi.getState().setSettingsOpen(true);
const fmt = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

/**
 * Small status chip for the shell: the model in use and the last answer time. With no key it reads
 * "Offline rules". Click opens Settings.
 */
export function AiStatus() {
  const hasKey = useStore((s) => Boolean(s.settings.geminiKey));
  const [last, setLast] = useState<{ model: string; ms: number } | null>(null);
  const [fail, setFail] = useState<AiReason | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const off1 = onAiActivity((e) => {
      if (e.phase === 'done' && e.model) { setLast({ model: e.model, ms: e.ms }); setFail(null); }
      else if (e.phase === 'error') setFail(e.reason ?? 'other');
    });
    const off2 = onProbeUpdate(() => tick((n) => n + 1));
    return () => { off1(); off2(); };
  }, []);

  if (!hasKey) {
    return <button className="ai-chip" onClick={openSettings} title="Works offline with rules. Add a Gemini key for custom objects and smarter design."><span className="dot" />Offline rules</button>;
  }
  const model = last?.model ?? aiRoute('fast')[0];
  const text = fail ? problemFor(fail).message : model ? `${shortModel(model)}${last ? ` · ${fmt(last.ms)}` : ''}` : 'Gemini';
  return (
    <button className={`ai-chip ${fail ? 'bad' : 'ok'}`} onClick={openSettings} title="Gemini settings" aria-label={`Gemini status: ${text}. Open settings`}>
      <span className="dot" />{text}
    </button>
  );
}

/** The one friendly line every AI feature shows when there is no key. */
export function NoKeyPrompt({ compact = false }: { compact?: boolean }) {
  const hasKey = useStore((s) => Boolean(s.settings.geminiKey));
  if (hasKey) return null;
  return (
    <div className="ai-note" role="note">
      <p>Works offline with rules. Add a Gemini key for custom objects and smarter design.</p>
      <div className="acts"><button className={`btn btn-sm${compact ? '' : ' btn-primary'}`} onClick={openSettings}>Add key</button></div>
    </div>
  );
}

const LABEL: Record<AiAction, string> = { retry: 'Retry', offline: 'Use offline', settings: 'Open settings' };

/** One plain message for a failed AI call, with actions. Pass the reason from classify(err). */
export function AiProblemNote({ reason, onRetry, onOffline }: { reason: AiReason; onRetry?: () => void; onOffline?: () => void }) {
  if (reason === 'no_key') return <NoKeyPrompt />;
  const p = problemFor(reason);
  const run: Record<AiAction, (() => void) | undefined> = { retry: onRetry, offline: onOffline, settings: openSettings };
  const acts = p.actions.filter((a) => run[a]);
  return (
    <div className="ai-note" role="status">
      <p>{p.message}</p>
      <div className="acts">{acts.map((a) => <button key={a} className="btn btn-sm" onClick={run[a]}>{LABEL[a]}</button>)}</div>
    </div>
  );
}
