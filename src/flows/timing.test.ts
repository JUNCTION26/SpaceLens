import { describe, it } from 'vitest';
import { sampleRoom } from '../core/sample';
import { note, resetStore, st } from './helpers';
import { compileWithMeta } from '../features/intent/refine';
import { designRoom } from '../features/design/pipeline';

/** Timing probe: compile -> first solid layout -> final, offline. Writes to the flows log. */
describe('timing', () => {
  for (const brief of ['home office for two', 'double bedroom', 'a room for my cat named Gerard']) {
    it(brief, async () => {
      resetStore(sampleRoom());
      const t0 = performance.now();
      const { req } = await compileWithMeta(brief, st().model);
      const tc = performance.now() - t0;
      // the first round the panel now applies on its own: one variant, no second opinion
      const quick = await designRoom(st().model, req, { variants: 1, critic: false, brief });
      const firstApplied = performance.now() - t0;
      const t1 = performance.now();
      let first = -1;
      const res = await designRoom(st().model, req, { variants: 3, brief, onProgress: (p) => { if (first < 0 && p.candidates.length) first = performance.now() - t1 + tc; } });
      const total = performance.now() - t1 + tc;
      const line = `compile ${tc.toFixed(0)}ms | quickApplied ${firstApplied.toFixed(0)}ms (${quick.candidates.length} cands) | firstProgress ${first.toFixed(0)}ms | final ${total.toFixed(0)}ms | stages ${res.stages.map((s) => `${s.id}:${s.ms}`).join(',')} | cands ${res.candidates.length}`;
      await note('TIMING ' + brief, line);
      console.log('TIMING', brief, line);
    }, 120000);
  }
});
