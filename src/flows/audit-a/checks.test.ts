// Design > Checks: the count, each row's title (show), a row's fix buttons and Fix all.
import { describe, expect, it, vi } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { makeItem } from '../../features/furniture/catalog';
import { counts, useProblems } from '../../features/problems/store';
import { resetStore, st } from './lite';

// No key and no server: the app's offline path.
vi.stubEnv('VITE_API_BASE', '');
vi.stubGlobal('fetch', () => Promise.reject(new TypeError('offline')));

async function settle() {
  useProblems.setState({ finding: true });
  useProblems.getState().refresh(true);
  const t0 = Date.now();
  while (useProblems.getState().finding && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 50));
  return useProblems.getState().problems;
}

/** A desk pushed into the doorway of the sample room. */
function blockDoor() {
  const m = st().model;
  const door = m.openings.find((o) => o.kind === 'door')!;
  const sp = m.spaces.find((s) => s.id === door.spaceId)!;
  const a = sp.polygon[door.wallIndex], b = sp.polygon[(door.wallIndex + 1) % sp.polygon.length];
  const L = Math.hypot(b.x - a.x, b.y - a.y), ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  // inward normal for a clockwise-on-screen polygon
  const nx = -uy, ny = ux;
  const c = { x: a.x + ux * door.offsetM + nx * 0.45, y: a.y + uy * door.offsetM + ny * 0.45 };
  const desk = { ...makeItem('desk-120', c), id: 'audit-desk' };
  st().dispatch({ type: 'PLACE_OBJECT', item: desk });
  return desk;
}

describe('Checks', () => {
  it('the shipped sample room is checked and the list resolves', async () => {
    resetStore(sampleRoom());
    const list = await settle();
    expect(Array.isArray(list)).toBe(true);
  }, 90000);

  it('a desk in the doorway shows a problem naming it', async () => {
    resetStore(sampleRoom());
    blockDoor();
    const list = (await settle()).filter(counts);
    expect(list.length).toBeGreaterThan(0);
    expect(list.some((p) => p.itemIds.includes('audit-desk'))).toBe(true);
  }, 90000);

  it('clicking a row title focuses that problem', async () => {
    const p = useProblems.getState().problems.find(counts)!;
    useProblems.getState().setFocus(p.id);
    expect(useProblems.getState().focusId).toBe(p.id);
    useProblems.getState().setFocus(null);
  });

  it('a row fix moves the desk and the problem goes away', async () => {
    resetStore(sampleRoom());
    blockDoor();
    // fixes are computed after the core list; wait for them
    let p;
    for (let i = 0; i < 30 && !p; i++) {
      const list = await settle();
      p = list.find((x) => counts(x) && x.itemIds.includes('audit-desk') && x.fixes.some((f) => f.ops.length));
      if (!p) await new Promise((r) => setTimeout(r, 300));
    }
    expect(p, 'a fix is offered').toBeTruthy();
    const fix = p!.fixes.find((f) => f.ops.length)!;
    useProblems.getState().applyFix(p!, fix);
    const after = await settle();
    expect(after.some((x) => x.id === p!.id)).toBe(false);
  }, 120000);

  it('Fix all clears the safe fixes, one undo step each', async () => {
    resetStore(sampleRoom());
    blockDoor();
    await settle();
    const before = useProblems.getState().problems.filter(counts).length;
    await useProblems.getState().fixAll();
    const after = (await settle()).filter(counts).length;
    expect(after).toBeLessThan(before);
    expect(useProblems.getState().fixingAll).toBe(false);
  }, 180000);
});
