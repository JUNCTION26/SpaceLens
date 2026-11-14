// Hand-authored objects. They set the quality bar (few-shot examples for the generator) and are
// the fixtures for the geometry tests. Metres; origin at the floor centre; front faces +z.
import type { MaterialId, ObjectMotion, ObjectPart, ObjectSpec, PartShape } from '../../core/types';
import { normalizeSemantics, partsBounds, withOpenSize } from './spec';

type V3 = [number, number, number];
const r4 = (n: number) => Math.round(n * 10000) / 10000;

function P(name: string, shape: PartShape, size: V3, pos: V3, material: MaterialId, extra: Partial<ObjectPart> = {}): ObjectPart {
  const part: ObjectPart = { name, shape, size: size.map(r4) as V3, pos: pos.map(r4) as V3, material };
  if (extra.rot) part.rot = extra.rot.map(r4) as V3;
  if (extra.radius != null) part.radius = r4(extra.radius);
  if (extra.color) part.color = extra.color;
  if (extra.profile) part.profile = extra.profile.map(([a, b]) => [r4(a), r4(b)] as [number, number]);
  if (extra.group) part.group = extra.group;
  return part;
}

function mk(key: string, name: string, category: string, prompt: string, description: string, parts: ObjectPart[], motions?: ObjectMotion[]): ObjectSpec {
  // Centre the footprint on the origin and stand it on the floor.
  const b0 = partsBounds(parts);
  const c: V3 = [(b0.min[0] + b0.max[0]) / 2, b0.min[1], (b0.min[2] + b0.max[2]) / 2];
  if (c.some((v) => Math.abs(v) > 1e-6)) {
    parts = parts.map((p) => ({ ...p, pos: [r4(p.pos[0] - c[0]), r4(p.pos[1] - c[1]), r4(p.pos[2] - c[2])] }));
    motions = motions?.map((m) => (m.pivot ? { ...m, pivot: [r4(m.pivot[0] - c[0]), r4(m.pivot[1] - c[1]), r4(m.pivot[2] - c[2])] } : m));
  }
  const b = partsBounds(parts);
  const size = { w: r4(b.max[0] - b.min[0]), d: r4(b.max[2] - b.min[2]), h: r4(b.max[1] - b.min[1]) };
  const spec: ObjectSpec = {
    id: `example-${key}`,
    name,
    prompt,
    size,
    parts,
    semantics: normalizeSemantics({ category, description }, category, name, size.h),
    model: 'hand',
    latencyMs: 0,
    createdAt: 0,
  };
  if (motions) spec.motions = motions;
  return withOpenSize(spec);
}

// ---- 1. Office desk with a drawer pedestal -------------------------------------------------

function desk(): ObjectSpec {
  const parts: ObjectPart[] = [
    P('Desktop', 'rounded', [1.6, 0.025, 0.8], [0, 0.7375, 0], 'walnut', { radius: 0.006 }),
    P('Front left leg', 'box', [0.04, 0.725, 0.04], [-0.76, 0.3625, 0.34], 'black-metal'),
    P('Back left leg', 'box', [0.04, 0.725, 0.04], [-0.76, 0.3625, -0.34], 'black-metal'),
    P('Left foot rail', 'box', [0.04, 0.03, 0.72], [-0.76, 0.015, 0], 'black-metal'),
    P('Left top rail', 'box', [0.04, 0.03, 0.64], [-0.76, 0.71, 0], 'black-metal'),
    P('Rear stretcher', 'box', [1.08, 0.04, 0.02], [-0.2, 0.69, -0.33], 'black-metal'),
    P('Modesty panel', 'panel', [1.06, 0.33, 0.016], [-0.2, 0.56, -0.31], 'walnut'),
    P('Pedestal left side', 'panel', [0.018, 0.695, 0.72], [0.339, 0.3775, 0], 'walnut'),
    P('Pedestal right side', 'panel', [0.018, 0.695, 0.72], [0.771, 0.3775, 0], 'walnut'),
    P('Pedestal back', 'panel', [0.414, 0.695, 0.012], [0.555, 0.3775, -0.354], 'walnut'),
    P('Pedestal bottom', 'panel', [0.414, 0.018, 0.708], [0.555, 0.039, 0.006], 'walnut'),
    P('Pedestal plinth', 'box', [0.41, 0.03, 0.64], [0.555, 0.015, 0], 'black-metal'),
    P('Bottom drawer front', 'panel', [0.444, 0.226, 0.018], [0.555, 0.145, 0.369], 'walnut'),
    P('Middle drawer front', 'panel', [0.444, 0.226, 0.018], [0.555, 0.375, 0.369], 'walnut'),
    P('Top drawer front', 'panel', [0.444, 0.226, 0.018], [0.555, 0.605, 0.369], 'walnut', { group: 'top-drawer' }),
    P('Bottom handle', 'tube', [0.16, 0.012, 0.012], [0.555, 0.215, 0.384], 'brass'),
    P('Middle handle', 'tube', [0.16, 0.012, 0.012], [0.555, 0.445, 0.384], 'brass'),
    P('Top handle', 'tube', [0.16, 0.012, 0.012], [0.555, 0.675, 0.384], 'brass', { group: 'top-drawer' }),
    P('Top drawer box', 'box', [0.4, 0.17, 0.62], [0.555, 0.605, 0.05], 'white-laminate', { group: 'top-drawer' }),
  ];
  return mk('desk', 'Walnut desk with drawer pedestal', 'desk', 'walnut desk 160x80 with a drawer pedestal on the right',
    'A walnut writing desk on a black steel frame with a three-drawer pedestal on the right.', parts,
    [{ group: 'top-drawer', label: 'Open drawer', kind: 'slide', axis: [0, 0, 1], open: 0.4 }]);
}

// ---- 2. Three-seat sofa ----------------------------------------------------------------------

function sofa(): ObjectSpec {
  const fab: Partial<ObjectPart> = { color: '#6f7f73' };
  const parts: ObjectPart[] = [
    P('Back frame', 'rounded', [2.2, 0.74, 0.2], [0, 0.49, -0.36], 'fabric', { ...fab, radius: 0.05 }),
    P('Left arm', 'rounded', [0.2, 0.5, 0.72], [-1.0, 0.37, 0.1], 'fabric', { ...fab, radius: 0.06 }),
    P('Right arm', 'rounded', [0.2, 0.5, 0.72], [1.0, 0.37, 0.1], 'fabric', { ...fab, radius: 0.06 }),
    P('Seat base', 'rounded', [1.8, 0.24, 0.72], [0, 0.24, 0.1], 'fabric', { ...fab, radius: 0.03 }),
    ...[-0.6, 0, 0.6].map((x, i) => P(`Seat cushion ${i + 1}`, 'cushion', [0.6, 0.16, 0.66], [x, 0.44, 0.12], 'fabric', fab)),
    ...[-0.6, 0, 0.6].map((x, i) => P(`Back cushion ${i + 1}`, 'cushion', [0.59, 0.36, 0.2], [x, 0.64, -0.17], 'fabric', { ...fab, rot: [-0.12, 0, 0] })),
    ...[[-1.02, -0.38], [-1.02, 0.38], [1.02, -0.38], [1.02, 0.38], [0, -0.38], [0, 0.38]].map(([x, z], i) =>
      P(`Leg ${i + 1}`, 'leg', [0.045, 0.12, 0.045], [x, 0.06, z], 'walnut')),
    P('Left throw pillow', 'cushion', [0.38, 0.38, 0.13], [-0.62, 0.655, -0.02], 'linen', { color: '#c9a227', rot: [-0.25, 0.15, 0] }),
    P('Right throw pillow', 'cushion', [0.38, 0.38, 0.13], [0.62, 0.655, -0.02], 'linen', { color: '#e8e1d3', rot: [-0.25, -0.15, 0] }),
  ];
  return mk('sofa', 'Three-seat sofa', 'sofa', 'a three-seat sofa in sage fabric with walnut legs',
    'A three-seat sofa in sage green fabric with loose seat and back cushions on walnut legs.', parts);
}

// ---- 3. Dining chair -------------------------------------------------------------------------

function chair(): ObjectSpec {
  const parts: ObjectPart[] = [
    P('Front left leg', 'leg', [0.035, 0.44, 0.035], [-0.19, 0.22, 0.22], 'oak'),
    P('Front right leg', 'leg', [0.035, 0.44, 0.035], [0.19, 0.22, 0.22], 'oak'),
    P('Back left post', 'leg', [0.035, 0.82, 0.035], [-0.19, 0.41, -0.23], 'oak'),
    P('Back right post', 'leg', [0.035, 0.82, 0.035], [0.19, 0.41, -0.23], 'oak'),
    P('Front apron', 'box', [0.345, 0.06, 0.02], [0, 0.41, 0.22], 'oak'),
    P('Back apron', 'box', [0.345, 0.06, 0.02], [0, 0.41, -0.23], 'oak'),
    P('Left apron', 'box', [0.02, 0.06, 0.415], [-0.19, 0.41, -0.005], 'oak'),
    P('Right apron', 'box', [0.02, 0.06, 0.415], [0.19, 0.41, -0.005], 'oak'),
    P('Seat pad', 'cushion', [0.43, 0.05, 0.47], [0, 0.465, 0], 'linen', { color: '#b8a58f' }),
    P('Top rail', 'rounded', [0.415, 0.09, 0.025], [0, 0.76, -0.23], 'oak', { radius: 0.01 }),
    P('Middle rail', 'box', [0.345, 0.04, 0.02], [0, 0.6, -0.23], 'oak'),
    ...[-0.08, 0, 0.08].map((x, i) => P(`Back slat ${i + 1}`, 'panel', [0.03, 0.095, 0.015], [x, 0.6675, -0.23], 'oak')),
    P('Left stretcher', 'tube', [0.018, 0.018, 0.415], [-0.19, 0.15, -0.005], 'oak'),
    P('Right stretcher', 'tube', [0.018, 0.018, 0.415], [0.19, 0.15, -0.005], 'oak'),
  ];
  return mk('chair', 'Oak dining chair', 'chair', 'oak dining chair with a slatted back and a linen seat pad',
    'A solid oak dining chair with a slatted back and a linen seat pad.', parts);
}

// ---- 4. Double bed -------------------------------------------------------------------------

function bed(): ObjectSpec {
  const parts: ObjectPart[] = [
    ...[[-0.79, -1.0], [0.79, -1.0], [-0.79, 1.04], [0.79, 1.04]].map(([x, z], i) => P(`Leg ${i + 1}`, 'leg', [0.06, 0.1, 0.06], [x, 0.05, z], 'oak')),
    P('Left rail', 'rounded', [0.05, 0.22, 2.06], [-0.805, 0.21, 0.0], 'oak', { radius: 0.01 }),
    P('Right rail', 'rounded', [0.05, 0.22, 2.06], [0.805, 0.21, 0.0], 'oak', { radius: 0.01 }),
    P('Foot rail', 'rounded', [1.66, 0.22, 0.04], [0, 0.21, 1.05], 'oak', { radius: 0.01 }),
    P('Slatted base', 'panel', [1.56, 0.02, 2.0], [0, 0.25, 0.0], 'birch'),
    P('Mattress', 'rounded', [1.6, 0.22, 2.0], [0, 0.37, 0.0], 'mattress', { radius: 0.05 }),
    P('Duvet', 'cushion', [1.64, 0.08, 1.45], [0, 0.52, 0.29], 'linen', { color: '#ece7dd' }),
    P('Duvet fold', 'cushion', [1.64, 0.05, 0.28], [0, 0.585, -0.3], 'linen', { color: '#ece7dd' }),
    P('Throw blanket', 'cushion', [1.68, 0.03, 0.5], [0, 0.575, 0.75], 'wool', { color: '#9c6b4e' }),
    P('Left pillow', 'cushion', [0.62, 0.16, 0.42], [-0.39, 0.56, -0.72], 'linen', { color: '#f6f3ee', rot: [-0.25, 0, 0] }),
    P('Right pillow', 'cushion', [0.62, 0.16, 0.42], [0.39, 0.56, -0.72], 'linen', { color: '#f6f3ee', rot: [-0.25, 0, 0] }),
    P('Left accent cushion', 'cushion', [0.45, 0.4, 0.13], [-0.27, 0.69, -0.56], 'velvet', { color: '#b46a55', rot: [-0.3, 0, 0] }),
    P('Right accent cushion', 'cushion', [0.45, 0.4, 0.13], [0.27, 0.69, -0.56], 'velvet', { color: '#b46a55', rot: [-0.3, 0, 0] }),
    P('Headboard back', 'rounded', [1.66, 1.05, 0.04], [0, 0.525, -1.05], 'oak', { radius: 0.012 }),
    ...Array.from({ length: 6 }, (_, i) => P(`Headboard channel ${i + 1}`, 'cushion', [0.26, 0.55, 0.07], [-0.65 + i * 0.26, 0.75, -0.995], 'velvet', { color: '#5f6f86' })),
  ];
  return mk('bed', 'Double bed with upholstered headboard', 'bed', 'double bed 160x200 with a channel-tufted blue headboard',
    'An oak double bed with a channel-tufted blue velvet headboard, made up with pillows and a throw.', parts);
}

// ---- 5. Bookshelf ----------------------------------------------------------------------------

function bookshelf(): ObjectSpec {
  const W = 0.9, D = 0.32, H = 1.9, t = 0.018, inner = W - 2 * t;
  const shelfY = [0.069, 0.43, 0.79, 1.15, 1.52];
  const parts: ObjectPart[] = [
    P('Left side', 'panel', [t, H, D], [-(W - t) / 2, H / 2, 0], 'birch'),
    P('Right side', 'panel', [t, H, D], [(W - t) / 2, H / 2, 0], 'birch'),
    P('Top', 'panel', [inner, t, D], [0, H - t / 2, 0], 'birch'),
    P('Kick board', 'panel', [inner, 0.06, t], [0, 0.03, D / 2 - 0.03], 'birch'),
    P('Back panel', 'panel', [inner, H - t - 0.06, 0.006], [0, 0.06 + (H - t - 0.06) / 2, -D / 2 + 0.003], 'white-laminate'),
    ...shelfY.map((y, i) => P(i === 0 ? 'Bottom shelf' : `Shelf ${i}`, 'panel', [inner, t, D - 0.006], [0, y, 0.003], 'birch')),
  ];
  // Books: deterministic runs of spines in a muted palette.
  const colors = ['#7a2e2e', '#2f4f6f', '#c9a227', '#3e5f46', '#d9d2c3', '#5b4a6b', '#a8562f', '#1f2a36'];
  let seed = 7;
  const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const runs: Array<[number, number, number]> = [[0, -0.4, 6], [1, 0.05, 5], [2, -0.4, 4], [3, -0.1, 7], [4, -0.38, 5]];
  let n = 0;
  for (const [shelf, x0, count] of runs) {
    const base = shelfY[shelf] + t / 2;
    let x = x0;
    for (let i = 0; i < count; i++) {
      const w = 0.024 + rnd() * 0.02, h = 0.2 + rnd() * 0.1, d = 0.2 + rnd() * 0.05;
      parts.push(P(`Book ${++n}`, 'box', [w, h, d], [x + w / 2, base + h / 2, 0.02], 'linen', { color: colors[(n * 3) % colors.length] }));
      x += w + 0.001;
    }
  }
  // A book leaning against the last run on shelf 1.
  parts.push(P('Leaning book', 'box', [0.03, 0.24, 0.21], [0.33, shelfY[1] + t / 2 + 0.118, 0.02], 'linen', { color: '#8c3b3b', rot: [0, 0, 0.2] }));
  parts.push(P('Vase', 'lathe', [0.12, 0.22, 0.12], [0.25, shelfY[2] + t / 2 + 0.11, 0.0], 'ceramic', {
    color: '#e9e2d6',
    profile: [[0.035, 0], [0.05, 0.03], [0.06, 0.09], [0.045, 0.16], [0.025, 0.2], [0.03, 0.22]],
  }));
  parts.push(P('Storage box', 'rounded', [0.3, 0.2, 0.26], [0.22, shelfY[0] + t / 2 + 0.1, 0.01], 'rattan', { radius: 0.01 }));
  return mk('bookshelf', 'Birch bookshelf', 'bookshelf', 'tall birch bookshelf 90 wide with books',
    'A tall birch bookshelf with five shelves, styled with books, a vase and a rattan box.', parts);
}

// ---- 6. Round pedestal dining table --------------------------------------------------------

function roundTable(): ObjectSpec {
  const angles = [Math.PI / 4, (3 * Math.PI) / 4, (5 * Math.PI) / 4, (7 * Math.PI) / 4];
  const radial = (r: number, a: number, y: number): V3 => [r * Math.cos(a), y, -r * Math.sin(a)];
  const parts: ObjectPart[] = [
    P('Tabletop', 'cylinder', [1.2, 0.03, 1.2], [0, 0.735, 0], 'oak'),
    P('Top support disc', 'cylinder', [0.5, 0.04, 0.5], [0, 0.7, 0], 'oak'),
    ...angles.map((a, i) => P(`Top bracket ${i + 1}`, 'rounded', [0.4, 0.04, 0.05], radial(0.2, a, 0.7), 'oak', { rot: [0, a, 0], radius: 0.01 })),
    P('Turned column', 'lathe', [0.18, 0.56, 0.18], [0, 0.4, 0], 'oak', {
      profile: [[0.06, 0], [0.09, 0.04], [0.07, 0.1], [0.05, 0.25], [0.045, 0.4], [0.055, 0.5], [0.07, 0.56]],
    }),
    P('Base hub', 'lathe', [0.3, 0.06, 0.3], [0, 0.09, 0], 'oak', { profile: [[0.15, 0], [0.13, 0.04], [0.09, 0.06]] }),
    ...angles.map((a, i) => P(`Foot ${i + 1}`, 'rounded', [0.32, 0.05, 0.07], radial(0.24, a, 0.037), 'oak', { rot: [0, a, 0], radius: 0.015 })),
    ...angles.map((a, i) => P(`Glide ${i + 1}`, 'cylinder', [0.05, 0.012, 0.05], radial(0.36, a, 0.006), 'brass')),
  ];
  return mk('round-table', 'Round pedestal dining table', 'dining table', 'round oak dining table 120 cm on a pedestal',
    'A round oak dining table for four on a turned pedestal with four feet.', parts);
}

// ---- 7. Armchair -------------------------------------------------------------------------------

function armchair(): ObjectSpec {
  const a = -0.25, n: V3 = [0, -Math.sin(a), Math.cos(a)];
  const along = (c: V3, k: number): V3 => [c[0] + n[0] * k, c[1] + n[1] * k, c[2] + n[2] * k];
  const back: V3 = [0, 0.56, -0.32];
  const leather = { color: '#9a5b34' };
  const parts: ObjectPart[] = [
    ...[[-0.37, 0.33], [0.37, 0.33], [-0.37, -0.33], [0.37, -0.33]].map(([x, z], i) => P(`Leg ${i + 1}`, 'leg', [0.045, 0.58, 0.045], [x, 0.29, z], 'walnut')),
    P('Left arm', 'rounded', [0.06, 0.04, 0.78], [-0.37, 0.6, 0], 'walnut', { radius: 0.015 }),
    P('Right arm', 'rounded', [0.06, 0.04, 0.78], [0.37, 0.6, 0], 'walnut', { radius: 0.015 }),
    P('Seat frame', 'rounded', [0.7, 0.06, 0.7], [0, 0.28, 0], 'walnut', { radius: 0.01 }),
    P('Seat cushion', 'cushion', [0.66, 0.14, 0.62], [0, 0.38, 0.06], 'leather', leather),
    P('Back panel', 'rounded', [0.7, 0.58, 0.04], back, 'walnut', { rot: [a, 0, 0], radius: 0.012 }),
    P('Back cushion', 'cushion', [0.62, 0.5, 0.12], along(back, 0.08), 'leather', { ...leather, rot: [a, 0, 0] }),
    P('Lumbar pillow', 'cushion', [0.42, 0.22, 0.1], along([0, 0.52, -0.32], 0.19), 'velvet', { color: '#2f4f4f', rot: [a, 0, 0] }),
    P('Left stretcher', 'tube', [0.024, 0.024, 0.62], [-0.37, 0.12, 0], 'walnut'),
    P('Right stretcher', 'tube', [0.024, 0.024, 0.62], [0.37, 0.12, 0], 'walnut'),
    P('Front stretcher', 'tube', [0.7, 0.024, 0.024], [0, 0.12, 0.33], 'walnut'),
    P('Back stretcher', 'tube', [0.7, 0.024, 0.024], [0, 0.12, -0.33], 'walnut'),
  ];
  return mk('armchair', 'Leather lounge armchair', 'armchair', 'cognac leather armchair with a walnut frame',
    'A mid-century lounge armchair with cognac leather cushions on an open walnut frame.', parts);
}

// ---- 8. Floor lamp -----------------------------------------------------------------------------

function floorLamp(): ObjectSpec {
  const parts: ObjectPart[] = [
    P('Marble base', 'lathe', [0.3, 0.04, 0.3], [0, 0.024, 0], 'marble', { profile: [[0.15, 0], [0.15, 0.025], [0.13, 0.04]] }),
    P('Base collar', 'cylinder', [0.05, 0.03, 0.05], [0, 0.055, 0], 'brass'),
    P('Stem', 'tube', [0.02, 1.3, 0.02], [0, 0.72, 0], 'brass'),
    P('Stem joint', 'cylinder', [0.028, 0.04, 0.028], [0, 0.72, 0], 'brass'),
    P('Switch', 'cylinder', [0.032, 0.03, 0.032], [0, 1.05, 0], 'black-metal'),
    P('Socket cup', 'cylinder', [0.05, 0.08, 0.05], [0, 1.41, 0], 'brass'),
    P('Bulb', 'sphere', [0.07, 0.1, 0.07], [0, 1.5, 0], 'glass'),
    P('Shade', 'lathe', [0.45, 0.32, 0.45], [0, 1.49, 0], 'linen', {
      color: '#efe6d6',
      profile: [[0.225, 0], [0.205, 0.1], [0.18, 0.22], [0.16, 0.32], [0.155, 0.32], [0.175, 0.22], [0.2, 0.1], [0.22, 0], [0.225, 0]],
    }),
    P('Shade bottom rim', 'lathe', [0.454, 0.008, 0.454], [0, 1.334, 0], 'brass', { profile: [[0.227, 0], [0.227, 0.008], [0.22, 0.008], [0.22, 0], [0.227, 0]] }),
    P('Shade top rim', 'lathe', [0.324, 0.008, 0.324], [0, 1.646, 0], 'brass', { profile: [[0.162, 0], [0.162, 0.008], [0.155, 0.008], [0.155, 0], [0.162, 0]] }),
    ...[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((a, i) => P(`Spider arm ${i + 1}`, 'tube', [0.14, 0.006, 0.006], [0.085 * Math.cos(a), 1.64, -0.085 * Math.sin(a)], 'brass', { rot: [0, a, 0] })),
    P('Base felt', 'cylinder', [0.27, 0.004, 0.27], [0, 0.002, 0], 'wool', { color: '#3a3330' }),
  ];
  return mk('floor-lamp', 'Brass floor lamp', 'floor lamp', 'brass floor lamp with a linen shade and a marble base',
    'A slim brass floor lamp with a tapered linen shade on a round marble base.', parts);
}

// ---- 9. Princess bed ---------------------------------------------------------------------------

/** Heart outline, centred, width ~1, height ~1. */
function heart(n = 48): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([16 * Math.sin(t) ** 3 / 32, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 32]);
  }
  return pts;
}

/** Flat-bottomed panel with an arched, scalloped top. */
function archedPanel(w: number, shoulder: number, peak: number, scallops = 0): Array<[number, number]> {
  const pts: Array<[number, number]> = [[-w / 2, 0], [w / 2, 0]];
  const n = 40;
  for (let i = 0; i <= n; i++) {
    const u = 1 - i / n, x = (u - 0.5) * w;
    const arch = shoulder + (peak - shoulder) * Math.sin(Math.PI * u) ** 0.8;
    const sc = scallops ? 0.03 * Math.abs(Math.sin(Math.PI * u * scallops)) : 0;
    pts.push([x, arch + sc]);
  }
  return pts;
}

function princessBed(): ObjectSpec {
  const pink = '#f4a6c6', hot = '#e0218a', white = '#fff4f8', blush = '#ffd1e3';
  const postX = 0.72, postZ = 1.0, postH = 2.04;
  const parts: ObjectPart[] = [
    ...[[-postX, -postZ], [postX, -postZ], [-postX, postZ], [postX, postZ]].flatMap(([x, z], i) => [
      P(`Canopy post ${i + 1}`, 'tube', [0.05, postH, 0.05], [x, postH / 2, z], 'white-laminate', { color: white }),
      P(`Finial ${i + 1}`, 'sphere', [0.07, 0.07, 0.07], [x, postH + 0.03, z], 'brass'),
    ]),
    P('Canopy rail left', 'tube', [0.035, 0.035, 2 * postZ - 0.05], [-postX, postH - 0.04, 0], 'white-laminate', { color: white }),
    P('Canopy rail right', 'tube', [0.035, 0.035, 2 * postZ - 0.05], [postX, postH - 0.04, 0], 'white-laminate', { color: white }),
    P('Canopy rail front', 'tube', [2 * postX - 0.05, 0.035, 0.035], [0, postH - 0.04, postZ], 'white-laminate', { color: white }),
    P('Canopy rail back', 'tube', [2 * postX - 0.05, 0.035, 0.035], [0, postH - 0.04, -postZ], 'white-laminate', { color: white }),
    P('Canopy top', 'panel', [1.39, 0.006, 1.95], [0, postH - 0.0195, 0], 'linen', { color: blush }),
    ...[[-postX + 0.18, -postZ + 0.03], [postX - 0.18, -postZ + 0.03], [-postX + 0.18, postZ - 0.03], [postX - 0.18, postZ - 0.03]].map(([x, z], i) =>
      P(`Drape ${i + 1}`, 'panel', [0.3, 1.5, 0.012], [x, postH - 0.0575 - 0.75, z], 'linen', { color: blush })),
    P('Bed frame', 'rounded', [1.4, 0.28, 1.95], [0, 0.2, 0], 'white-laminate', { color: white, radius: 0.04 }),
    ...[[-0.62, -0.9], [0.62, -0.9], [-0.62, 0.9], [0.62, 0.9]].map(([x, z], i) => P(`Foot ${i + 1}`, 'cylinder', [0.06, 0.06, 0.06], [x, 0.03, z], 'brass')),
    P('Mattress', 'rounded', [1.36, 0.22, 1.9], [0, 0.45, 0.0], 'mattress', { radius: 0.05 }),
    P('Duvet', 'cushion', [1.42, 0.08, 1.35], [0, 0.6, 0.28], 'velvet', { color: pink }),
    P('Pillow left', 'cushion', [0.55, 0.15, 0.38], [-0.33, 0.63, -0.7], 'linen', { color: white, rot: [-0.2, 0, 0] }),
    P('Pillow right', 'cushion', [0.55, 0.15, 0.38], [0.33, 0.63, -0.7], 'linen', { color: white, rot: [-0.2, 0, 0] }),
    P('Heart pillow', 'extrude', [0.36, 0.32, 0.1], [0, 0.76, -0.5], 'velvet', { color: hot, profile: heart(), rot: [-0.3, 0, 0] }),
    P('Headboard', 'extrude', [1.4, 1.3, 0.06], [0, 0.71, -0.945], 'velvet', { color: pink, profile: archedPanel(1.4, 0.95, 1.3, 7) }),
    P('Headboard heart', 'extrude', [0.5, 0.45, 0.03], [0, 1.0, -0.9], 'velvet', { color: hot, profile: heart() }),
    P('Footboard', 'extrude', [1.4, 0.6, 0.05], [0, 0.36, 0.95], 'white-laminate', { color: white, profile: archedPanel(1.4, 0.45, 0.6, 5) }),
    P('Footboard heart', 'extrude', [0.22, 0.2, 0.02], [0, 0.42, 0.985], 'velvet', { color: hot, profile: heart() }),
  ];
  return mk('princess-bed', 'Pink princess canopy bed', 'bed', 'a pink barbie style princess bed with a heart headboard and a canopy',
    'A playful pink canopy bed with an arched, scalloped headboard, heart details and blush drapes.', parts);
}

// ---- 10. Fold-down wall bed ---------------------------------------------------------------------

function wallBed(): ObjectSpec {
  const g = { group: 'bed' };
  const parts: ObjectPart[] = [
    P('Cabinet left side', 'panel', [0.025, 2.2, 0.45], [-0.8125, 1.1, 0], 'white-laminate'),
    P('Cabinet right side', 'panel', [0.025, 2.2, 0.45], [0.8125, 1.1, 0], 'white-laminate'),
    P('Cabinet top', 'panel', [1.6, 0.025, 0.45], [0, 2.1875, 0], 'white-laminate'),
    P('Plinth', 'panel', [1.6, 0.08, 0.4], [0, 0.04, -0.025], 'white-laminate'),
    P('Back panel', 'panel', [1.6, 2.095, 0.012], [0, 1.1275, -0.219], 'white-laminate'),
    P('Front panel', 'panel', [1.6, 2.06, 0.025], [0, 1.13, 0.2125], 'oak', g),
    P('Panel groove', 'box', [0.004, 2.0, 0.003], [0, 1.13, 0.2265], 'black-laminate', g),
    P('Left frame rail', 'panel', [0.03, 2.06, 0.12], [-0.785, 1.13, 0.14], 'white-laminate', g),
    P('Right frame rail', 'panel', [0.03, 2.06, 0.12], [0.785, 1.13, 0.14], 'white-laminate', g),
    P('Mattress', 'rounded', [1.54, 2.0, 0.2], [0, 1.13, -0.02], 'mattress', { ...g, radius: 0.05 }),
    P('Duvet', 'cushion', [1.56, 1.45, 0.05], [0, 1.4, -0.145], 'linen', { ...g, color: '#cfd8dc' }),
    P('Pillow left', 'cushion', [0.6, 0.4, 0.12], [-0.38, 0.4, -0.18], 'linen', { ...g, color: '#f6f3ee' }),
    P('Pillow right', 'cushion', [0.6, 0.4, 0.12], [0.38, 0.4, -0.18], 'linen', { ...g, color: '#f6f3ee' }),
    P('Fold-out leg', 'rounded', [1.4, 0.05, 0.1], [0, 2.1, 0.275], 'oak', { ...g, radius: 0.012 }),
    P('Pull left', 'tube', [0.012, 0.012, 0.03], [-0.5, 2.06, 0.24], 'brass', g),
    P('Pull right', 'tube', [0.012, 0.012, 0.03], [0.5, 2.06, 0.24], 'brass', g),
  ];
  return mk('wall-bed', 'Fold-down wall bed', 'bed', 'a built-in double wall bed that folds down from a cabinet',
    'A built-in double wall bed: a shallow cabinet whose oak front folds down into a made bed.', parts,
    [{ group: 'bed', label: 'Fold down', kind: 'hinge', pivot: [0, 0.1, 0.225], axis: [1, 0, 0], open: Math.PI / 2 }]);
}

// ---- 11. Bar stool ---------------------------------------------------------------------------

function barStool(): ObjectSpec {
  const parts: ObjectPart[] = [
    P('Seat shell', 'lathe', [0.38, 0.04, 0.38], [0, 0.69, 0], 'walnut', { profile: [[0.04, 0], [0.17, 0.01], [0.19, 0.03], [0.185, 0.04]] }),
    P('Seat pad', 'lathe', [0.36, 0.05, 0.36], [0, 0.735, 0], 'leather', { color: '#1f1b18', profile: [[0.18, 0], [0.18, 0.025], [0.15, 0.045], [0.0, 0.05]] }),
    P('Seat plate', 'cylinder', [0.16, 0.012, 0.16], [0, 0.664, 0], 'black-metal'),
    P('Gas sleeve', 'cylinder', [0.05, 0.1, 0.05], [0, 0.608, 0], 'black-metal'),
    P('Column', 'cylinder', [0.06, 0.5, 0.06], [0, 0.308, 0], 'chrome'),
    P('Footrest ring', 'lathe', [0.36, 0.024, 0.36], [0, 0.3, 0], 'chrome', {
      profile: Array.from({ length: 13 }, (_, i) => { const a = (i / 12) * Math.PI * 2; return [0.168 + 0.012 * Math.cos(a), 0.012 + 0.012 * Math.sin(a)] as [number, number]; }),
    }),
    P('Footrest spoke A', 'tube', [0.32, 0.014, 0.014], [0, 0.3, 0], 'chrome', { rot: [0, Math.PI / 4, 0] }),
    P('Footrest spoke B', 'tube', [0.32, 0.014, 0.014], [0, 0.3, 0], 'chrome', { rot: [0, -Math.PI / 4, 0] }),
    P('Height lever', 'tube', [0.08, 0.008, 0.008], [0.06, 0.64, 0], 'black-metal'),
    P('Lever knob', 'sphere', [0.018, 0.018, 0.018], [0.1, 0.64, 0], 'plastic', { color: '#111111' }),
    P('Base dome', 'lathe', [0.42, 0.06, 0.42], [0, 0.038, 0], 'chrome', { profile: [[0.21, 0], [0.205, 0.01], [0.12, 0.04], [0.04, 0.058], [0.03, 0.06]] }),
    P('Floor ring', 'cylinder', [0.42, 0.008, 0.42], [0, 0.004, 0], 'black-laminate'),
  ];
  return mk('bar-stool', 'Walnut bar stool', 'stool', 'swivel bar stool with a walnut seat and chrome base',
    'A swivel bar stool with a turned walnut seat, leather pad and a chrome column with footrest ring.', parts);
}

export const EXAMPLES: ObjectSpec[] = [desk(), sofa(), chair(), bed(), bookshelf(), roundTable(), armchair(), floorLamp(), princessBed(), wallBed(), barStool()];

/** Compact JSON for one example, shaped like the generator's response (for few-shot prompts). */
export function exampleForPrompt(i: number): string {
  const s = EXAMPLES[i];
  return JSON.stringify({ name: s.name, category: s.semantics.category, parts: s.parts, ...(s.motions ? { motions: s.motions } : {}), semantics: s.semantics });
}
