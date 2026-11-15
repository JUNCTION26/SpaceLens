// Live check: a plan picture through Gemini. Skipped unless PLANIMAGE_LIVE=1 and PLANIMAGE_FILE points at a jpg or png
// (PLANIMAGE_W and PLANIMAGE_H give its pixel size).
import { describe, expect, it } from 'vitest';

const penv = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const live = penv.PLANIMAGE_LIVE === '1' && Boolean(penv.PLANIMAGE_FILE);

describe.skipIf(!live)('plan image live', () => {
  it('reads rooms from a picture', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeMod = (name: string): Promise<any> => import(/* @vite-ignore */ `node:${name}`);
    const fs = await nodeMod('fs');
    const path = await nodeMod('path');
    const key = penv.VITE_GEMINI_KEY || (fs.readFileSync(path.resolve('.env.local'), 'utf8').match(/^\s*VITE_GEMINI_KEY\s*=\s*"?([^"\r\n]+)"?/m)?.[1] ?? '').trim();
    const { getState } = await import('../../core/store');
    getState().setSettings({ geminiKey: key });
    const { strongCall } = await import('../photoroom/strong');
    const { dataUrlToInlineData } = await import('../../core/gemini');
    const { IMAGE_PLAN_SCHEMA, imagePlanPrompt, parseRaw, buildFromRaw } = await import('./planImage');
    const file = penv.PLANIMAGE_FILE!;
    const mime = /\.png$/i.test(file) ? 'image/png' : 'image/jpeg';
    const url = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
    const W = Number(penv.PLANIMAGE_W ?? 1000), H = Number(penv.PLANIMAGE_H ?? 1000);
    const r = await strongCall<unknown>({ parts: [dataUrlToInlineData(url), { text: imagePlanPrompt(W, H) }], schema: IMAGE_PLAN_SCHEMA, thinking: 'low', temperature: 0.1 });
    const out = buildFromRaw(parseRaw(r.data, W, H), { name: path.basename(file), modelName: r.model });
    fs.writeFileSync(`${file}.plan.json`, JSON.stringify(out, null, 1));
    expect(out.report.ok).toBe(true);
  }, 180000);
});
