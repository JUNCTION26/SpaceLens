import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import type { FurnitureItem, ObjectSpec } from '../../core/types';
import { useUi } from '../../ui/uiStore';
import { useNotices } from '../../ui/notify';
import { Logo } from '../../ui/Home';
import { sampleRoom } from '../../core/sample';
import { FADE_MS, runLoop, type SeqCtx, type SeqStep } from './sequencer';

export const SHOW_PROMPT = 'A room for my cat named Gerard';
export const SHOW_OBJECT = 'a cat tree with three platforms';
export const LIVE_ADDRESS = 'junction26.github.io/SpaceLens';

export type CameraShot = 'orbit' | 'dolly-in' | 'top-down' | 'eye-level' | 'door-reveal';
/** Ask the 3D view for a camera move. Nothing happens if no view listens. */
export const camera = (shot: CameraShot, seconds: number) =>
  window.dispatchEvent(new CustomEvent('spacelens:camera', { detail: { shot, seconds } }));

const S = () => useStore.getState();
const tab = (mode: 'design' | 'experience' | 'deliver', key: string) => { S().setMode(mode); useUi.getState().setTab(mode, key); };
const until = async (c: SeqCtx, ok: () => boolean, ms: number) => { for (let t = 0; t < ms && !ok(); t += 120) await c.wait(120); };
/** Resolves to the value, or undefined once ms have passed. */
const capped = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))]);
const query = <T extends Element>(sel: string) => (typeof document === 'undefined' ? null : document.querySelector<T>(sel));

/** Set a form control the way a person would, so React sees the change. */
function setControl(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string, ev: 'input' | 'change') {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event(ev, { bubbles: true }));
}

export interface ShowUi {
  /** Text typed on screen (only the prompt). Empty clears it. */
  subtitle: (t: string) => void;
  endCard: (on: boolean) => void;
  speak: (line: string) => void;
}

/** Type text at human speed into the subtitle and, when present, a field. */
async function typeOut(c: SeqCtx, ui: ShowUi, text: string, field?: HTMLTextAreaElement | HTMLInputElement | null) {
  for (let i = 1; i <= text.length; i++) {
    const part = text.slice(0, i);
    ui.subtitle(part);
    if (field?.isConnected) setControl(field, part, 'input');
    const ch = text[i - 1];
    await c.wait(ch === ' ' ? 110 : 55 + ((i * 37) % 45));
  }
}

const isPoster = (f: FurnitureItem) => /poster|sign|banner|gerard/i.test(`${f.name} ${f.catalogId ?? ''}`);
const area = (f: FurnitureItem) => f.w * f.d;

/** The themed room for the prompt: the full design when it lands in time, else what was laid out so far, else the offline brief. */
async function themedFurniture(c: SeqCtx): Promise<FurnitureItem[]> {
  const { designThemedRoom, usableCandidate } = await import('../themes/designThemed');
  const best = (cands: { furniture: FurnitureItem[]; metrics: { score?: number } }[]) =>
    [...cands].filter((x) => usableCandidate(x as never)).sort((a, b) => (b.metrics.score ?? 0) - (a.metrics.score ?? 0))[0]?.furniture;
  const ac = new AbortController();
  const stop = () => ac.abort();
  c.signal.addEventListener('abort', stop, { once: true });
  let latest: FurnitureItem[] | undefined;
  try {
    const res = await capped(designThemedRoom(S().model, SHOW_PROMPT, {
      signal: ac.signal,
      onProgress: (r) => { const f = best(r.candidates); if (f?.length) latest = f; },
    }).catch(() => undefined), 14000);
    const full = res ? best(res.candidates) : undefined;
    if (full?.length) return full;
    if (latest?.length) return latest;
    const { rulesBrief } = await import('../themes/brief');
    const off = await capped(designThemedRoom(S().model, SHOW_PROMPT, { brief: rulesBrief(SHOW_PROMPT), signal: ac.signal }).catch(() => undefined), 8000);
    const f = off ? best(off.candidates) : undefined;
    if (!f?.length) throw new Error('no room');
    return f;
  } finally { ac.abort(); c.signal.removeEventListener('abort', stop); }
}

/** A custom piece from words: the generator when it answers in time, else the built-in kit. */
async function customObject(): Promise<ObjectSpec> {
  const [{ generateObject }, { recipeSpec }] = await Promise.all([import('../forge/generate'), import('../themes/recipes')]);
  const spec = await capped(generateObject(SHOW_OBJECT, { detail: false }).catch(() => undefined), 12000);
  if (spec) return spec;
  const kit = recipeSpec({ source: 'custom', name: 'Cat tree', recipe: 'cat-tree', style: 'paw' });
  if (!kit) throw new Error('no kit');
  return kit;
}

/** A free floor spot away from the walls and the furniture, for the custom piece. */
function freeSpot(): { x: number; y: number } | undefined {
  const m = S().model;
  const poly = m.spaces[0]?.polygon;
  if (!poly?.length) return undefined;
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs) + 0.5, Math.max(...xs) - 0.5, Math.min(...ys) + 0.5, Math.max(...ys) - 0.5];
  let bestP: { x: number; y: number } | undefined, bestD = -1;
  for (let x = x0; x <= x1; x += 0.25) for (let y = y0; y <= y1; y += 0.25) {
    const d = Math.min(...m.furniture.map((f) => Math.hypot(f.x - x, f.y - y) - Math.max(f.w, f.d) / 2), 9);
    if (d > bestD) { bestD = d; bestP = { x, y }; }
  }
  return bestP;
}

/** The film. Every beat uses public store actions, DOM events or exported functions, and is skipped if it fails. */
export function buildShow(ui: ShowUi): SeqStep[] {
  return [
    { id: 'blueprint', ms: 9000, timeoutMs: 25000, cut: true,
      setup: async () => {
        const { loadDemo } = await import('../building/demo');
        if (!(await capped(loadDemo('villa', false), 12000))) throw new Error('villa');
        S().setCandidates([]); S().setMode('design'); useUi.getState().openSection('building'); S().setView('2d');
      },
      run: async (c) => {
        ui.speak('Every home starts as a drawing.');
        await c.wait(3200);
        S().setView('3d');
        camera('orbit', 6);
      } },
    { id: 'describe', ms: 20000, timeoutMs: 45000, cut: true,
      setup: () => {
        S().dispatch({ type: 'REPLACE_MODEL', model: { ...sampleRoom(), furniture: [] } });
        S().setCandidates([]); S().setAnalysis({ routes: [], highlights: [] });
        tab('design', 'describe'); S().setView('3d');
        camera('eye-level', 3);
      },
      run: async (c) => {
        ui.speak('Just say who the room is for.');
        const pending = themedFurniture(c);
        pending.catch(() => {});
        await until(c, () => !!query('textarea[aria-label="Describe your space"]'), 1500);
        await typeOut(c, ui, SHOW_PROMPT, query<HTMLTextAreaElement>('textarea[aria-label="Describe your space"]'));
        await c.wait(500);
        const items = await pending;
        ui.subtitle('');
        camera('orbit', 8);
        // Furniture first, biggest first; the named poster lands last.
        const order = [...items.filter((f) => !isPoster(f)).sort((a, b) => area(b) - area(a)), ...items.filter(isPoster)];
        const gap = Math.max(250, Math.min(650, 6500 / Math.max(1, order.length)));
        for (let i = 1; i <= order.length; i++) {
          S().dispatch({ type: 'SET_FURNITURE', items: order.slice(0, i), label: 'Furnished' });
          await c.wait(gap);
        }
      } },
    { id: 'poster', ms: 5500, run: async (c) => {
      ui.speak('Gerard gets his own wall.');
      camera('dolly-in', 2.5);
      await c.wait(2800);
      camera('orbit', 2.5);
    } },
    { id: 'create', ms: 10000, timeoutMs: 28000, run: async (c) => {
      tab('design', 'create');
      ui.speak('Anything missing? Describe it.');
      const pending = customObject();
      pending.catch(() => {});
      await typeOut(c, ui, SHOW_OBJECT);
      const spec = await pending;
      const { placeSpec } = await import('../forge/library');
      ui.subtitle('');
      placeSpec(spec, freeSpot());
      camera('orbit', 5);
    } },
    { id: 'safety', ms: 9000, timeoutMs: 20000, cut: true,
      setup: () => { tab('experience', 'safety'); S().setView('3d'); camera('top-down', 3); },
      run: async (c) => {
        ui.speak('Checked against Finnish building rules.');
        const { assessSafety } = await import('../safety/assess');
        const drawRoute = () => {
          const rep = assessSafety(S().model, S().model.furniture);
          const routes = rep.egress.filter((e) => e.pathPoints.length > 1).map((e) => ({
            id: `evac:${e.spaceId}`, profile: 'adult' as const, points: e.pathPoints, ok: true, lengthM: e.lengthM, narrowestM: null, label: e.name,
          }));
          S().setAnalysis({ routes, highlights: [] });
          S().toggleLayer('routes', true);
        };
        await c.wait(900);
        drawRoute();
        await c.wait(2500);
        const sel = query<HTMLSelectElement>('select[aria-label="Country"]');
        if (sel) setControl(sel, 'FI', 'change');
        await c.wait(700);
        drawRoute();
      } },
    { id: 'movein', ms: 8000, timeoutMs: 15000, cut: true,
      setup: () => { tab('deliver', 'movein'); S().setView('3d'); },
      run: async (c) => {
        ui.speak('Will it fit through the door?');
        await until(c, () => !!query('.movein-main'), 2000);
        const btns = [...document.querySelectorAll<HTMLButtonElement>('.movein-main')];
        const pick = btns.find((b) => /sofa|couch/i.test(b.getAttribute('aria-label') ?? '')) ?? btns.find((b) => /tree|bed|shelf/i.test(b.getAttribute('aria-label') ?? '')) ?? btns[0];
        if (!pick) throw new Error('nothing to carry');
        camera('door-reveal', 4);
        pick.click();
      } },
    { id: 'budget', ms: 9000, timeoutMs: 15000, cut: true,
      setup: () => { tab('design', 'budget'); },
      run: async (c) => {
        ui.speak('Over budget? Two swaps fix it.');
        const { planBudget, applyMoves, totalFor } = await import('../budget/plan');
        const m = S().model;
        const swaps = planBudget(m, 0).moves.filter((x) => x.kind === 'swap' && x.savingSek > 0).sort((a, b) => b.savingSek - a.savingSek).slice(0, 2);
        if (swaps.length < 2) throw new Error('no swaps');
        const total = totalFor(m.furniture);
        const target = Math.ceil((total - swaps[0].savingSek - swaps[1].savingSek + 50) / 100) * 100;
        await until(c, () => !!query('#budget-target'), 1500);
        const input = query<HTMLInputElement>('#budget-target');
        if (!input) throw new Error('no budget field');
        setControl(input, String(target), 'input');
        await c.wait(1800);
        for (const mv of swaps) {
          for (const op of applyMoves(S().model, [mv])) S().dispatch(op);
          await c.wait(1600);
        }
      } },
    { id: 'evening', ms: 6500, timeoutMs: 12000, run: async (c) => {
      S().setView('3d');
      await until(c, () => !!query('.scene3d-sun input[type="range"]'), 1200);
      const sun = query<HTMLInputElement>('.scene3d-sun input[type="range"]');
      if (!sun) throw new Error('no sun control');
      ui.speak('And it still feels right at night.');
      camera('orbit', 6);
      for (let h = Number(sun.value) || 15; h <= 20.5; h += 0.5) {
        setControl(sun, String(h), 'input');
        await c.wait(380);
      }
    } },
    { id: 'end', ms: 6000, run: async () => { ui.endCard(true); ui.speak('SpaceLens.'); } },
  ];
}

/** Planned film length, in ms. */
export const SHOW_TOTAL_MS = buildShow({ subtitle: () => {}, endCard: () => {}, speak: () => {} }).reduce((a, s) => a + s.ms, 0);

/** What the ?show= parameter asks for. */
export function showMode(search: string): { play: boolean; loop: boolean; voice: boolean } {
  const p = new URLSearchParams(search);
  const v = p.get('show');
  return { play: v === '1' || v === 'loop', loop: v === 'loop', voice: p.get('voice') === '1' };
}

/** Clean slate between loop rounds. */
function resetApp() {
  S().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
  S().setCandidates([]); S().setAnalysis({ routes: [], highlights: [] });
  S().setMode('home');
}

const BAR = 'min(11vh, 96px)';

/** Hands-free film: ?show=1 plays once, ?show=loop loops, &voice=1 narrates. Esc, any key or a click stops it. */
export function ShowRunner() {
  const [on, setOn] = useState(false);
  const [bars, setBars] = useState(false);
  const [black, setBlack] = useState(false);
  const [pct, setPct] = useState(0);
  const [sub, setSub] = useState('');
  const [end, setEnd] = useState(false);
  const ac = useRef<AbortController | null>(null);

  useEffect(() => {
    const mode = typeof location !== 'undefined' ? showMode(location.search) : { play: false, loop: false, voice: false };
    const start = (loop = mode.loop) => {
      if (ac.current) return;
      const ctl = new AbortController(); ac.current = ctl;
      const say = (line: string) => {
        if (!mode.voice || typeof speechSynthesis === 'undefined' || ctl.signal.aborted) return;
        try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(line); u.rate = 0.95; speechSynthesis.speak(u); } catch { /* no voice */ }
      };
      const ui: ShowUi = { subtitle: (t) => { if (!ctl.signal.aborted) setSub(t); }, endCard: (v) => { if (!ctl.signal.aborted) setEnd(v); }, speak: say };
      let t0 = Date.now();
      setOn(true); setBlack(true); setPct(0); setSub(''); setEnd(false);
      requestAnimationFrame(() => setBars(true));
      const tick = setInterval(() => setPct(Math.min(100, ((Date.now() - t0) / SHOW_TOTAL_MS) * 100)), 200);
      // Notices would put sentences on screen; clear them while the film plays.
      const quiet = () => {
        if (useNotices.getState().notices.length) useNotices.setState({ notices: [] });
        for (const t of S().toasts) S().dismissToast(t.id);
      };
      quiet();
      const unsubN = useNotices.subscribe(quiet);
      const unsubS = useStore.subscribe((s, p) => { if (s.toasts !== p.toasts && s.toasts.length) quiet(); });
      const armed = Date.now() + 600;
      const stop = () => { if (Date.now() >= armed) ctl.abort(); };
      const key = (e: KeyboardEvent) => { if (e.key === 'Escape' || Date.now() >= armed) ctl.abort(); };
      window.addEventListener('pointerdown', stop, true);
      window.addEventListener('keydown', key, true);
      const finish = () => {
        clearInterval(tick); unsubN(); unsubS();
        window.removeEventListener('pointerdown', stop, true);
        window.removeEventListener('keydown', key, true);
        ctl.signal.removeEventListener('abort', finish);
        try { if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel(); } catch { /* no voice */ }
        ac.current = null;
        setBlack(false); setSub(''); setEnd(false); setBars(false); setOn(false);
      };
      // A stop hands control back at once, without waiting for the running beat to unwind.
      ctl.signal.addEventListener('abort', finish, { once: true });
      void runLoop(() => buildShow(ui), ctl.signal, {
        loop,
        onRound: () => { t0 = Date.now(); setPct(0); setEnd(false); setBlack(true); },
        reset: resetApp,
        hooks: { fade: (b) => { if (!ctl.signal.aborted) setBlack(b); }, fadeMs: FADE_MS },
      }).then(async () => {
        if (ctl.signal.aborted) return;
        setBars(false);
        await new Promise((r) => setTimeout(r, 700));
        if (!ctl.signal.aborted) finish();
      });
    };
    const onEvent = () => start(false);
    window.addEventListener('spacelens:show', onEvent);
    let boot: ReturnType<typeof setTimeout> | undefined;
    if (mode.play) boot = setTimeout(() => start(), 800);
    return () => { window.removeEventListener('spacelens:show', onEvent); clearTimeout(boot); ac.current?.abort(); };
  }, []);

  if (!on) return null;
  const bar = { position: 'fixed', left: 0, right: 0, height: BAR, background: '#000', zIndex: 97, transition: 'transform 700ms cubic-bezier(.2,.7,.2,1)', pointerEvents: 'none' } as const;
  return (
    <>
      <div aria-hidden="true" style={{ position: 'fixed', inset: 0, background: '#000', zIndex: 96, opacity: black || end ? 1 : 0, transition: `opacity ${FADE_MS}ms ease`, pointerEvents: 'none' }} />
      <div aria-hidden="true" style={{ ...bar, top: 0, transform: bars ? 'none' : 'translateY(-100%)' }} />
      <div style={{ ...bar, bottom: 0, transform: bars ? 'none' : 'translateY(100%)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {sub && <span aria-live="polite" style={{ color: '#f5f5f5', font: '500 clamp(16px, 2.4vw, 26px)/1.2 ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.01em', padding: '0 16px', textAlign: 'center' }}>{sub}</span>}
        <div role="progressbar" aria-label="Film" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
          style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, background: '#ffffff1a' }}>
          <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent, #3b82f6)', transition: 'width 200ms linear' }} />
        </div>
      </div>
      {end && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 98, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, color: '#fff', pointerEvents: 'none' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 14, font: '600 clamp(28px, 5vw, 56px)/1 system-ui, sans-serif', letterSpacing: '-0.02em' }}>
            <span style={{ transform: 'scale(1.8)', display: 'inline-flex' }}><Logo /></span>SpaceLens
          </span>
          <span style={{ font: '400 clamp(14px, 1.8vw, 20px)/1 ui-monospace, Menlo, monospace', opacity: 0.75 }}>{LIVE_ADDRESS}</span>
        </div>
      )}
    </>
  );
}
