import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { sampleRoom } from '../../core/sample';
import { compileIntent } from '../intent/compile';
import { generateLayouts } from '../layout/solver';
import { runRoutes } from '../sim/routes';
import { testPassage } from '../sim/passage';
import { validateLayout } from '../referee/validate';

const PROMPT = 'Home office for two, keep my desk, clear route to the window, under 12 000 kr';

type Say = (title: string, text: string) => void;
interface Ctx { say: Say; wait: (ms: number) => Promise<void> }
interface Step { title: string; run: (c: Ctx) => Promise<void> }

const S = () => useStore.getState();

const STEPS: Step[] = [
  { title: 'Load a room', run: async ({ say, wait }) => {
    S().dispatch({ type: 'REPLACE_MODEL', model: sampleRoom() });
    S().setCandidates([]);
    S().setMode('design');
    say('Load a room', 'A 3.4 x 4.2 m sample room. One door, one window, one desk.');
    await wait(5000);
  } },
  { title: 'Edit a wall', run: async ({ say, wait }) => {
    say('Edit a wall', 'Set the north wall to 3.6 m.');
    await wait(2500);
    S().dispatch({ type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: 0, lengthM: 3.6});
    say('Edit a wall', 'One edit. Every view updates.');
    await wait(4500);
  } },
  { title: 'Describe the goal', run: async ({ say, wait }) => {
    say('Describe the goal', `"${PROMPT}"`);
    const req = await compileIntent(PROMPT, S().model);
    S().setRequirements(req);
    say('Describe the goal', `Compiled by ${req.compiledBy}: ${req.people} people, ${req.items.length} item types, budget ${req.budgetSek ?? 'none'} kr.`);
    await wait(3500);
    say('Generate layouts', 'Solving against the real geometry...');
    const { candidates, infeasibility } = await generateLayouts(S().model, req);
    S().setCandidates(candidates, infeasibility);
    if (!candidates.length) throw new Error(infeasibility?.reasons[0] ?? 'no layouts found');
    for (const c of candidates) {
      S().previewCandidate(c.id);
      say('Compare layouts', `${c.name}: ${c.metrics.openAreaM2.toFixed(1)} m² open, ${Math.round(c.metrics.costSek)} kr.`);
      await wait(2000);
    }
  } },
  { title: 'Apply the best', run: async ({ say, wait }) => {
    const best = [...S().candidates].sort((a, b) => b.metrics.score - a.metrics.score)[0];
    if (!best) throw new Error('no layout to apply');
    S().applyCandidate(best.id);
    say('Apply the best', `Applied "${best.name}". It is now the plan, with undo.`);
    await wait(4000);
  } },
  { title: 'Walk it', run: async ({ say, wait }) => {
    S().setMode('experience');
    const m = S().model;
    const adult = runRoutes(m, m.furniture, 'adult');
    const chair = runRoutes(m, m.furniture, 'wheelchair');
    S().setAnalysis({ routes: [...adult.routes, ...chair.routes] });
    const ok = (r: typeof adult) => `${r.routes.filter((x) => x.ok).length}/${r.routes.length}`;
    say('Walk it', `Routes clear: adult ${ok(adult)}, wheelchair ${ok(chair)}.`);
    await wait(6000);
  } },
  { title: 'Fit a sofa', run: async ({ say, wait }) => {
    const m = S().model;
    const door = m.openings.find((o) => o.kind === 'door');
    if (!door) throw new Error('no door');
    say('Fit a sofa', 'Can a 2.2 m sofa get through the door?');
    await wait(1500);
    const res = testPassage(m, m.furniture, { id: 'demo_sofa', name: 'Sofa', w: 2.2, d: 0.9, h: 0.85 }, door.id);
    S().setAnalysis({ passage: res });
    say('Fit a sofa', `${res.ok ? 'Fits.' : 'Does not fit.'} ${res.details}`);
    await wait(6000);
  } },
  { title: 'Shrink the room', run: async ({ say, wait }) => {
    const before = S().model.spaces[0]?.polygon;
    const east = before ? Math.hypot(before[2].x - before[1].x, before[2].y - before[1].y) : 4.2;
    S().dispatch({ type: 'SET_WALL_LENGTH', spaceId: 's1', wallIndex: 1, lengthM: east - 0.3});
    const fails = validateLayout(S().model, S().model.furniture, S().requirements).filter((r) => r.result === 'fail');
    S().setAnalysis({ highlights: fails.length ? [{ ids: fails.flatMap((f) => f.subjectIds), color: '#e5484d', label: 'Breaks' }] : [] });
    say('Shrink the room', fails.length ? `30 cm shorter: ${fails.length} check${fails.length > 1 ? 's' : ''} fail. ${fails[0].details}` : '30 cm shorter: the layout still holds.');
    await wait(6000);
    S().undo();
    S().setAnalysis({ highlights: [] });
    say('Shrink the room', 'Undo. Back to the measured room.');
    await wait(3000);
  } },
  { title: 'Deliver', run: async ({ say, wait }) => {
    S().setMode('deliver');
    say('Deliver', 'Plan, list and checks, ready to hand over.');
    await wait(6000);
  } },
];

export function DemoRunner() {
  const [on, setOn] = useState(false);
  const [idx, setIdx] = useState(0);
  const [cap, setCap] = useState({ title: '', text: '' });
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  const skipRef = useRef(false);
  const runId = useRef(0);

  useEffect(() => {
    const start = () => { setOn(true); setPaused(false); pausedRef.current = false; void run(++runId.current); };
    window.addEventListener('spacelens:demo', start);
    return () => window.removeEventListener('spacelens:demo', start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function run(id: number) {
    const alive = () => runId.current === id;
    const say: Say = (title, text) => { if (alive()) setCap({ title, text }); };
    const wait = async (ms: number) => {
      let t = 0;
      while (t < ms) {
        if (!alive()) throw new Error('stopped');
        if (skipRef.current) return;
        await new Promise((r) => setTimeout(r, 100));
        if (!pausedRef.current) t += 100;
      }
    };
    for (let i = 0; i < STEPS.length; i++) {
      if (!alive()) return;
      setIdx(i);
      skipRef.current = false;
      try {
        await STEPS[i].run({ say, wait });
      } catch (e) {
        if (!alive()) return;
        say(STEPS[i].title, `Skipped: ${e instanceof Error ? e.message : String(e)}`);
        skipRef.current = false;
        try { await wait(2500); } catch { return; }
      }
    }
    if (alive()) { say('Done', 'That is SpaceLens.'); try { await wait(3000); } catch { return; } setOn(false); }
  }

  if (!on) return null;
  const exit = () => { runId.current++; setOn(false); };
  const togglePause = () => { pausedRef.current = !pausedRef.current; setPaused(pausedRef.current); };

  return (
    <div role="status" aria-live="polite" style={{
      position: 'fixed', left: '50%', bottom: 24, transform: 'translateX(-50%)', zIndex: 1000,
      width: 'min(560px, calc(100vw - 32px))', padding: '14px 16px', borderRadius: 12,
      background: 'rgba(16,18,24,0.92)', color: '#fff', boxShadow: '0 8px 30px rgba(0,0,0,0.35)', font: '14px/1.4 system-ui, sans-serif',
    }}>
      <div style={{ fontSize: 12, opacity: 0.65 }}>{idx + 1} / {STEPS.length}</div>
      <div style={{ fontSize: 17, fontWeight: 600, margin: '2px 0 4px' }}>{cap.title}</div>
      <div style={{ opacity: 0.9, minHeight: 20 }}>{cap.text}</div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
        {[['pause', paused ? 'Resume' : 'Pause', togglePause], ['next', 'Next', () => { skipRef.current = true; }], ['exit', 'Exit', exit]].map(([k, label, fn]) => (
          <button key={k as string} onClick={fn as () => void} style={{
            padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.25)', background: 'transparent', color: '#fff', cursor: 'pointer',
          }}>{label as string}</button>
        ))}
      </div>
    </div>
  );
}
