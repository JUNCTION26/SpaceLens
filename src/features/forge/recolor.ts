// Colour fidelity without another model call. If the person named colours (or a theme with a
// palette) and the finished object does not visibly carry them, the largest suitable groups of parts
// are recoloured: the main colour must cover a real share of the surface, an accent at least a little.

import type { MaterialId, ObjectPart, ObjectSpec } from '../../core/types';
import { MATERIAL_DEFS } from './materials';
import { colorDistance } from './palette';
import type { ParsedRequest } from './parseRequest';

const area = (p: ObjectPart) => { const [x, y, z] = p.size; return 2 * (x * y + y * z + x * z); };
const effective = (p: ObjectPart) => p.color ?? MATERIAL_DEFS[p.material]?.color ?? '#999999';

/** Parts whose colour should never be repainted to meet a request. */
const FIXED: ReadonlySet<MaterialId> = new Set(['mattress', 'glass', 'plant', 'chrome', 'steel', 'brass']);
const METALS: ReadonlySet<MaterialId> = new Set(['black-metal', 'steel', 'brass', 'chrome']);

const NEAR = 22;

export function coverage(parts: readonly ObjectPart[], hex: string): number {
  const total = parts.reduce((s, p) => s + area(p), 0) || 1;
  return parts.filter((p) => colorDistance(effective(p), hex) < NEAR).reduce((s, p) => s + area(p), 0) / total;
}

/** Recolour so the named colours show. Returns the spec unchanged when they already do. */
export function enforceColors(spec: ObjectSpec, parsed: ParsedRequest): { spec: ObjectSpec; fixes: string[] } {
  const fixes: string[] = [];
  const named = parsed.colors.map((c) => c.hex);
  const targets = (named.length ? named : parsed.theme?.palette.slice(0, 2) ?? []).slice(0, 2);
  if (!targets.length || !spec.parts.length) return { spec, fixes };
  const glossy = parsed.theme?.materials?.[0] === 'plastic';
  const parts = spec.parts.map((p) => ({ ...p }));
  const used = new Set<string>();
  const need = [named.length ? 0.28 : 0.22, 0.05];
  targets.forEach((hex, ti) => {
    if (coverage(parts, hex) >= need[ti]) { parts.forEach((p) => { if (colorDistance(effective(p), hex) < NEAR) used.add(groupKey(p)); }); return; }
    // Groups of same-looking parts, largest surface first.
    const groups = new Map<string, { area: number; idx: number[] }>();
    parts.forEach((p, i) => {
      if (FIXED.has(p.material) || (METALS.has(p.material) && ti === 0)) return;
      if (targets.some((t) => colorDistance(effective(p), t) < NEAR)) return;
      const k = groupKey(p);
      if (used.has(k)) return;
      const g = groups.get(k) ?? { area: 0, idx: [] };
      g.area += area(p); g.idx.push(i); groups.set(k, g);
    });
    const order = [...groups.entries()].sort((a, b) => b[1].area - a[1].area);
    // Main colour: the biggest group(s); accent: the second-biggest remaining group.
    const picks = ti === 0 ? order : order.slice(1).concat(order.slice(0, 1));
    for (const [k, g] of picks) {
      for (const i of g.idx) {
        const p = parts[i];
        parts[i] = { ...p, color: hex, ...(glossy && (p.material === 'white-laminate' || p.material === 'oak' || p.material === 'birch' || p.material === 'pine') ? { material: 'plastic' as MaterialId } : {}) };
      }
      used.add(k);
      if (coverage(parts, hex) >= need[ti]) break;
    }
    fixes.push(`recoloured to ${hex}`);
  });
  return { spec: { ...spec, parts }, fixes };
}

function groupKey(p: ObjectPart): string { return `${p.material}|${p.color ?? ''}`; }
