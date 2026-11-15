import { useEffect, useState } from 'react';
import { useStore } from '../../core/store';
import { resizeSpace } from '../../core/ops';
import { area, bounds } from '../../core/geometry';

type Key = 'widthM' | 'depthM' | 'heightM';

/** Parse "5", "5,25" or "5x6" / "5 x 6 x 2.7". Returns up to three numbers (W, D, H). */
export function parseSize(raw: string): number[] | null {
  const parts = raw.toLowerCase().replace(/m\b/g, '').split(/[x×*]|\bby\b/).map((p) => p.trim().replace(',', '.'));
  const nums = parts.map((p) => (p === '' ? NaN : Number(p)));
  if (!nums.length || nums.length > 3 || nums.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return nums;
}

const f2 = (n: number) => n.toFixed(2);

/** W, D, H of the selected (or only) room. Edit a value and press Enter or leave the field. */
export function SizeRow() {
  const { model, selection, dispatch } = useStore();
  const selId = selection?.kind === 'space' ? selection.id : selection?.kind === 'wall' ? selection.id.split(':')[0] : null;
  const space = model.spaces.find((s) => s.id === selId) ?? model.spaces[0];
  const bb = space ? bounds(space.polygon) : null;
  const cur = bb ? [bb.w, bb.h, model.ceilingM] : [0, 0, 0];
  const [vals, setVals] = useState<string[]>(cur.map(f2));
  const [warn, setWarn] = useState<string | null>(null);
  const sig = cur.map(f2).join('|') + (space?.id ?? '');
  useEffect(() => { setVals(cur.map(f2)); }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!space || !bb) return null;

  const apply = (raw: (number | undefined)[]) => {
    const nums = raw.map((n) => (n === undefined ? undefined : Math.min(100, Math.max(0.5, Math.round(n * 100) / 100))));
    const size = { widthM: nums[0], depthM: nums[1], heightM: nums[2] };
    const same = (['widthM', 'depthM', 'heightM'] as Key[]).every((k, i) => size[k] === undefined || Math.abs(size[k]! - cur[i]) < 0.005);
    if (same) { setVals(cur.map(f2)); return; }
    const r = resizeSpace(model, space.id, size);
    setWarn(r.warning ?? null);
    dispatch({ type: 'RESIZE_SPACE', spaceId: space.id, ...size });
  };
  const commit = (i: number, raw: string) => {
    const nums = parseSize(raw);
    if (!nums || (i > 0 && nums.length > 1)) { setVals(cur.map(f2)); return; }
    const out: (number | undefined)[] = [undefined, undefined, undefined];
    nums.forEach((n, k) => { out[i + k] = n; });
    apply(out);
  };
  const step = (i: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { commit(i, e.currentTarget.value); return; }
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const base = parseSize(e.currentTarget.value)?.[0] ?? cur[i];
    const d = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowUp' ? 1 : -1);
    const next = Math.min(100, Math.max(0.5, Math.round((base + d) * 100) / 100));
    const out: (number | undefined)[] = [undefined, undefined, undefined]; out[i] = next;
    setVals((v) => v.map((x, k) => (k === i ? f2(next) : x)));
    apply(out);
  };
  const live = parseSize(vals[0]);
  const w = live && live.length > 1 ? live[0] : Number(vals[0].replace(',', '.')) || cur[0];
  const d = live && live.length > 1 ? live[1] : Number(vals[1].replace(',', '.')) || cur[1];
  const m2 = space.polygon.length === 4 ? w * d : area(space.polygon) * (w / (cur[0] || 1)) * (d / (cur[1] || 1));
  return (
    <div>
      <div className="capture-size">
        {(['W', 'D', 'H'] as const).map((l, i) => (
          <label key={l}>{l}
            <input className="field" inputMode="decimal" value={vals[i]} aria-label={`${['Width', 'Depth', 'Height'][i]} in metres`}
              onChange={(e) => setVals((v) => v.map((x, k) => (k === i ? e.target.value : x)))}
              onKeyDown={(e) => step(i, e)} onBlur={(e) => commit(i, e.currentTarget.value)} onFocus={(e) => e.currentTarget.select()} />
          </label>
        ))}
        <span className="chip" aria-label="Floor area">{m2.toFixed(1)} m²</span>
      </div>
      {warn && <p className="chip chip-warn capture-size-warn" role="status">{warn}</p>}
    </div>
  );
}
