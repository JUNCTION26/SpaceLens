// Ten themed-room sentences with the AI stubbed off: each must come back complete, without overlaps,
// every piece inside the room, and a named sign or poster wherever a name was given.
import { describe, expect, it, vi } from 'vitest';
import type { FurnitureItem, SpaceModel } from '../../core/types';
import { opening, rect, room } from '../referee/fixtures';

vi.mock('../../core/ai', async (orig) => {
  const real = await orig<typeof import('../../core/ai')>();
  return { ...real, aiReady: () => false, aiRoute: () => [] };
});

const { designThemedRoom } = await import('./designThemed');
const { refineThemed } = await import('./refine');

const door = opening('door', 'door', 0, 0.7, 0.85, 'in');
const win = opening('win', 'window', 2, 2.1, 1.4);
const model = room(rect(4.2, 3.6), [door, win]);

const corners = (f: FurnitureItem) => {
  const c = Math.cos(f.rotation), s = Math.sin(f.rotation), hw = f.w / 2, hd = f.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => ({ x: f.x + x * c - y * s, y: f.y + x * s + y * c }));
};
const axes = (p: Array<{ x: number; y: number }>) => p.map((a, i) => { const b = p[(i + 1) % p.length]; return { x: -(b.y - a.y), y: b.x - a.x }; });
const overlap = (a: FurnitureItem, b: FurnitureItem) => {
  const pa = corners(a), pb = corners(b);
  for (const ax of [...axes(pa), ...axes(pb)]) {
    const pr = (p: typeof pa) => { const v = p.map((q) => q.x * ax.x + q.y * ax.y); return [Math.min(...v), Math.max(...v)]; };
    const [a0, a1] = pr(pa), [b0, b1] = pr(pb);
    if (a1 - b0 < 0.02 || b1 - a0 < 0.02) return false;
  }
  return true;
};
const inside = (m: SpaceModel, f: FurnitureItem) => {
  const xs = m.spaces[0].polygon.map((p) => p.x), ys = m.spaces[0].polygon.map((p) => p.y);
  return corners(f).every((p) => p.x >= Math.min(...xs) - 0.02 && p.x <= Math.max(...xs) + 0.02 && p.y >= Math.min(...ys) - 0.02 && p.y <= Math.max(...ys) + 0.02);
};
const words = (f: FurnitureItem) => f.custom?.parts.map((p) => p.text?.value).filter(Boolean).join(' ') ?? '';

const CASES: Array<{ text: string; name?: string; banned?: RegExp }> = [
  { text: 'Barbie bedroom', banned: /barbie|mattel/i },
  { text: 'space themed kids room for Leo', name: 'Leo' },
  { text: 'Japanese tea room' },
  { text: 'home gym' },
  { text: 'music room with a piano' },
  { text: 'Harry-free wizard study', banned: /harry|potter|hogwarts|gryffindor/i },
  { text: "plant lover's living room" },
  { text: 'gaming den' },
  { text: 'craft room for sewing' },
  { text: 'nursery for twins' },
];

describe('ten themed sentences, offline', () => {
  for (const c of CASES) {
    it(c.text, async () => {
      const res = await designThemedRoom(model, c.text);
      const fur = res.candidates[0].furniture;
      expect(res.contract?.complete, JSON.stringify(res.contract)).toBe(true);
      expect(res.contract!.missing).toEqual([]);
      expect(fur.length).toBeGreaterThanOrEqual(res.contract!.minPieces);
      const floor = fur.filter((f) => f.mount !== 'wall' && f.category !== 'rug');
      for (const f of fur) expect(inside(model, f), `${f.name} outside`).toBe(true);
      for (let i = 0; i < floor.length; i++) for (let j = i + 1; j < floor.length; j++) expect(overlap(floor[i], floor[j]), `${floor[i].name} / ${floor[j].name}`).toBe(false);
      if (c.name) expect(fur.map(words).join('|').toUpperCase()).toContain(c.name.toUpperCase());
      if (c.banned) {
        const seen = [res.brief.title, res.roomName ?? '', ...fur.map((f) => `${f.name} ${words(f)}`), ...res.brief.objects.map((o) => `${o.name} ${o.text ?? ''}`)].join('|');
        expect(seen).not.toMatch(c.banned);
      }
      expect(res.partial).toBe(false);
    });
  }

  it('a follow-up keeps the room complete and inside', async () => {
    const first = await designThemedRoom(model, 'nursery for twins');
    const res = await refineThemed(model, first, 'add a poster that says SLEEP TIGHT');
    expect(res.contract, 'refine result carries a contract').toBeTruthy();
    expect(res.contract!.complete, JSON.stringify(res.contract)).toBe(true);
    const fur = res.candidates[0].furniture;
    expect(fur.map(words).join('|')).toContain('SLEEP TIGHT');
    for (const f of fur) expect(inside(model, f)).toBe(true);
  });
});
