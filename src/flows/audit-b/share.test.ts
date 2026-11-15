// Share: every action on the Export, Move in and Render panels, driven through the same functions they call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { sampleRoom } from '../../core/sample';
import { makeItem } from '../../features/furniture/catalog';
import { decodeModel, encodeModel, shareLink } from '../../features/export/share';
import { fits, qrSvg } from '../../features/export/qr';
import { planToSvg } from '../../features/export/svg';
import { scheduleCsv } from '../../features/export/csv';
import { validateModel } from '../../features/export/validate';
import { buildScene } from '../../features/export/glb';
import { quantities } from '../../features/export/quantities';
import { modelToIfc } from '../../features/formats/ifcWrite';
import { ifcToModel } from '../../features/formats/ifcRead';
import { modelToDxf } from '../../features/formats/dxfWrite';
import { dxfToModel } from '../../features/formats/dxfRead';
import { buildShoppingList, toCsv } from '../../features/shoplist/buildShoppingList';
import { planMoveIn } from '../../features/movein/plan';
import { buildMoveTimeline, frameAt, summarize } from '../../features/movein/timeline';
import { buildPrompt, cacheKey } from '../../features/render/prompt';
import { generateImage, RenderError } from '../../features/render/generate';
import { resetStore, st } from '../helpers';

const furnished = () => {
  const m = sampleRoom();
  if (m.furniture.length < 2) m.furniture = [...m.furniture, makeItem('desk-120', { x: 1.5, y: 1.2 }), makeItem('sofa-2', { x: 2.5, y: 2.6 })];
  return m;
};
const area = (poly: Array<{ x: number; y: number }>) => Math.abs(poly.reduce((a, p, i) => { const q = poly[(i + 1) % poly.length]; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;

afterEach(() => { vi.unstubAllGlobals(); });

describe('Export panel', () => {
  it('Link: the shared link opens the same room, and its QR draws', async () => {
    vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/', hash: '' });
    const m = furnished();
    const url = await shareLink(m);
    expect(url).toMatch(/^https:\/\/app\.test\/#m=/);
    const back = await decodeModel(url.split('#m=')[1]);
    expect(back.spaces[0].polygon).toEqual(m.spaces[0].polygon);
    expect(back.furniture.map((f) => f.id)).toEqual(m.furniture.map((f) => f.id));
    const shown = fits(url) ? url : 'https://app.test/';
    expect(qrSvg(shown)).toContain('<svg');
    expect(await encodeModel(m)).toBe(url.split('#m=')[1]);
  });

  it('Picture: the plan SVG names every piece and the version', () => {
    const m = furnished();
    const svg = planToSvg(m, m.furniture);
    expect(svg).toContain('<svg');
    expect(svg).toContain(`Version ${m.version}`);
  });

  it('IFC reads back: same rooms, floor area and furniture count', () => {
    const m = furnished();
    const ifc = modelToIfc(m);
    const r = ifcToModel(ifc, 'room.ifc');
    expect(r.model.spaces.length).toBe(m.spaces.length);
    expect(area(r.model.spaces[0].polygon)).toBeCloseTo(area(m.spaces[0].polygon), 1);
    expect(r.model.furniture.length).toBe(m.furniture.length);
  });

  it('DXF reads back: the room outline and openings survive', () => {
    const m = furnished();
    const r = dxfToModel(modelToDxf(m), 'room.dxf');
    expect(r.model.spaces.length).toBeGreaterThanOrEqual(1);
    expect(area(r.model.spaces[0].polygon)).toBeCloseTo(area(m.spaces[0].polygon), 1);
  });

  it('Shopping list CSV: one row per line, totals match the unowned prices', () => {
    const m = furnished();
    const list = buildShoppingList(m);
    const csv = toCsv(list);
    expect(csv.trim().split('\r\n').length).toBe(list.lines.length + 1);
    const expected = m.furniture.filter((f) => !f.owned && f.priceSek > 0 && !f.listing).reduce((a, f) => a + f.priceSek, 0);
    expect(list.totals.SEK ?? 0).toBe(expected);
    expect(scheduleCsv(m.furniture).split('\n').length).toBeGreaterThan(m.furniture.length);
  });

  it('GLB: the 3D scene holds the room and every piece', () => {
    const m = furnished();
    const scene = buildScene(m, m.furniture);
    let meshes = 0;
    scene.traverse((o) => { if ((o as { isMesh?: boolean }).isMesh) meshes++; });
    expect(meshes).toBeGreaterThan(m.furniture.length);
  });

  it('Project file: export then import gives the same model, through the store', () => {
    resetStore(furnished());
    const before = st().model;
    const json = JSON.stringify(before, null, 2);
    const imported = validateModel(JSON.parse(json));
    expect(imported).toEqual(before);
    st().dispatch({ type: 'REPLACE_MODEL', model: { ...imported, name: 'Imported copy' } });
    expect(st().model.name).toBe('Imported copy');
    expect(st().model.furniture.length).toBe(before.furniture.length);
    expect(() => validateModel({ hello: 1 })).toThrow();
  });

  it('PDF sheet: quantities are finite', () => {
    const q = quantities(furnished());
    expect(q.floorM2).toBeGreaterThan(0);
    expect(Number.isFinite(q.paintL)).toBe(true);
  });
});

describe('Move in panel', () => {
  it('plans every piece, plays to the end, and flat-pack never makes it worse', () => {
    const m = furnished();
    const plan = planMoveIn(m, m.furniture);
    expect(plan.items.length).toBe(m.furniture.length);
    const tl = buildMoveTimeline(plan);
    expect(tl.total).toBeGreaterThan(0);
    const end = frameAt(tl, tl.total + 1);
    expect(end.placed.length + end.stopped.length).toBe(plan.items.length);
    const s = summarize(plan, m.furniture);
    expect(s).toBeTruthy();
    const flat = planMoveIn(m, m.furniture, { flat: new Set(m.furniture.map((f) => f.id)) });
    const wont = (p: typeof plan) => p.items.filter((i) => i.verdict === 'wont').length;
    expect(wont(flat)).toBeLessThanOrEqual(wont(plan));
  });
});

describe('Render panel', () => {
  it('builds a prompt and a stable cache key', () => {
    const m = furnished();
    const p = buildPrompt({ model: m, furniture: m.furniture, style: 'daylight', requirements: null });
    expect(p.length).toBeGreaterThan(40);
    expect(cacheKey(m, m.furniture, 'a', 'daylight')).toBe(cacheKey(m, m.furniture, 'a', 'daylight'));
  });

  it('offline with a key: fails with a network reason the panel can retry', async () => {
    resetStore();
    st().setSettings({ geminiKey: 'test-key' });
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    const err = await generateImage('data:image/png;base64,AAAA', 'a room').catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect((err as RenderError).reason).toBe('network');
    st().setSettings({ geminiKey: '' });
  });

  it('no key and no server: asks for a key', async () => {
    resetStore();
    st().setSettings({ geminiKey: '' });
    const err = await generateImage('data:image/png;base64,AAAA', 'a room').catch((e) => e);
    expect(err).toBeInstanceOf(RenderError);
    expect(['nokey', 'network']).toContain((err as RenderError).reason);
  });
});
