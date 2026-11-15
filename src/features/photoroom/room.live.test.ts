// Live check: real room photos through Gemini. Skipped unless PHOTOROOM_LIVE=1 and PHOTOROOM_DIR points at a
// folder of .jpg room photos. Writes <name>.json (estimate and built model) next to each photo.
import { describe, expect, it } from 'vitest';

const penv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const live = penv.PHOTOROOM_LIVE === '1' && Boolean(penv.PHOTOROOM_DIR);

describe.skipIf(!live)('photo room live', () => {
  it('estimates and builds a room for every photo', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeMod = (name: string): Promise<any> => import(/* @vite-ignore */ `node:${name}`);
    const fs = await nodeMod('fs');
    const path = await nodeMod('path');
    const key = penv.VITE_GEMINI_KEY || (fs.readFileSync(path.resolve('.env.local'), 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1] ?? '').trim();
    const { getState } = await import('../../core/store');
    getState().setSettings({ geminiKey: key });
    const { estimateRoom } = await import('./pipeline');
    const { buildPhotoRoom } = await import('./room');
    const dir = penv.PHOTOROOM_DIR!;
    const files = fs.readdirSync(dir).filter((f: string) => /\.jpe?g$/i.test(f));
    await Promise.all(files.map(async (f: string) => {
      const t0 = Date.now();
      const photo = `data:image/jpeg;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`;
      const est = await estimateRoom(photo);
      const model = buildPhotoRoom(est);
      fs.writeFileSync(path.join(dir, f.replace(/\.\w+$/, '.json')), JSON.stringify({ ms: Date.now() - t0, aiModel: getState().settings.geminiModel, est, model }, null, 1));
      expect(model.spaces[0].polygon).toHaveLength(4);
    }));
  }, 240_000);
});
