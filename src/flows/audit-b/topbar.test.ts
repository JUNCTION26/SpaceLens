// Top bar: undo, redo, the view switch, walk, full screen, search, share and VR/AR availability,
// driven through the same store actions and helpers the buttons call.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeItem } from '../../features/furniture/catalog';
import { buildCommands } from '../../features/command/commands';
import { rank } from '../../features/command/match';
import { decodeModel, shareLink } from '../../features/export/share';
import { detectXR, NO_XR } from '../../features/xr/xrSupport';
import { setViewPrefs, toggleStageFull, toggleWalk, useViewPrefs } from '../../ui/ViewFold';
import { resetStore, st } from '../helpers';

afterEach(() => { vi.unstubAllGlobals(); });

describe('Top bar', () => {
  it('Undo restores the previous model and Redo brings the change back', () => {
    resetStore();
    const before = st().model;
    st().dispatch({ type: 'PLACE_OBJECT', item: makeItem('desk-120', { x: 1.5, y: 1.2 }) });
    const after = st().model;
    expect(after.furniture.length).toBe(before.furniture.length + 1);
    st().undo();
    expect(st().model.furniture).toEqual(before.furniture);
    expect(st().model.spaces).toEqual(before.spaces);
    expect(st().model.version).toBeGreaterThan(after.version);
    st().redo();
    expect(st().model.furniture).toEqual(after.furniture);
    expect(st().future.length).toBe(0);
  });

  it('Undo with nothing to undo leaves the model alone', () => {
    resetStore();
    const m = st().model;
    st().undo();
    expect(st().model).toBe(m);
  });

  it('2D, Split and 3D switch the view', () => {
    for (const v of ['2d', 'split', '3d'] as const) { st().setView(v); expect(st().view).toBe(v); }
  });

  it('Walk from the plan opens a 3D pane first, then toggles walking', () => {
    resetStore();
    setViewPrefs({ cam: 'orbit', touring: false });
    st().setView('2d');
    toggleWalk();
    expect(st().view).toBe('split');
    expect(useViewPrefs.getState().cam).toBe('walk');
    toggleWalk();
    expect(useViewPrefs.getState().cam).toBe('orbit');
  });

  it('Full screen leaves the window-filling fallback, and never throws without a page', () => {
    setViewPrefs({ pseudo: true });
    toggleStageFull();
    expect(useViewPrefs.getState().pseudo).toBe(false);
    expect(() => toggleStageFull()).not.toThrow();
  });

  it('Search finds and runs commands: "undo", "3d", "safety"', () => {
    resetStore();
    st().dispatch({ type: 'PLACE_OBJECT', item: makeItem('desk-120', { x: 1.5, y: 1.2 }) });
    const cmds = buildCommands();
    expect(rank(cmds, 'undo')[0].id).toBe('undo');
    rank(cmds, 'undo')[0].run();
    expect(st().model.furniture.some((f) => f.catalogId === 'desk-120')).toBe(false);
    const v3 = rank(cmds, '3d')[0];
    expect(v3.id).toBe('view:3d');
    v3.run();
    expect(st().view).toBe('3d');
    expect(rank(cmds, 'safety').some((c) => c.id === 'nav:safety')).toBe(true);
    // "Full screen" from search behaves like the top bar button.
    setViewPrefs({ pseudo: true });
    cmds.find((c) => c.id === 'fullscreen')!.run();
    expect(useViewPrefs.getState().pseudo).toBe(false);
  });

  it('Share builds a link that opens the same room', async () => {
    vi.stubGlobal('location', { origin: 'https://app.test', pathname: '/', hash: '' });
    resetStore();
    const url = await shareLink(st().model);
    const m = await decodeModel(url.split('#m=')[1]);
    expect(m.spaces).toEqual(st().model.spaces);
  });

  it('VR/AR buttons only show when the browser says the mode is supported', async () => {
    expect(await detectXR(null)).toEqual(NO_XR);
    expect(await detectXR({ userAgent: 'x' })).toEqual(NO_XR);
    const xr = { isSessionSupported: async (m: string) => m === 'immersive-vr', requestSession: async () => ({}) };
    expect(await detectXR({ userAgent: 'x', xr })).toEqual({ vr: true, ar: false, quickLook: false });
    const broken = { isSessionSupported: async () => { throw new Error('no'); }, requestSession: async () => ({}) };
    expect(await detectXR({ userAgent: 'x', xr: broken })).toEqual(NO_XR);
    expect((await detectXR({ userAgent: 'iPhone' })).quickLook).toBe(true);
  });
});
