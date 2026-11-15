import { bounds } from '../../core/geometry';
import type { FurnitureItem, Requirements, SpaceModel } from '../../core/types';

export type RenderStyle = 'daylight' | 'evening' | 'scandi' | 'bold';

export const STYLES: Array<{ id: RenderStyle; label: string; light: string; look: string }> = [
  { id: 'daylight', label: 'Daylight', light: 'soft natural daylight from the windows, late morning, neutral white balance', look: '' },
  { id: 'evening', label: 'Evening', light: 'warm evening light, lamps switched on, dim golden glow, long soft shadows', look: '' },
  { id: 'scandi', label: 'Nordic', light: 'bright, airy daylight', look: 'Scandinavian styling: pale oak, white walls, soft wool and linen textiles, calm and minimal' },
  { id: 'bold', label: 'Bold', light: 'bright even lighting with strong contrast', look: 'bold styling: saturated accent wall colour, rich textures, confident contrast' },
];

const cm = (m: number) => `${Math.round(m * 100)} cm`;

function hexName(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
  if (!m) return '';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 50) return 'black';
  if (min > 215) return 'white';
  if (max - min < 24) return max > 150 ? 'light grey' : 'grey';
  const tone = max > 190 ? 'light ' : max < 110 ? 'dark ' : '';
  if (r >= g && r >= b) return tone + (g > b + 30 ? 'orange or yellow' : 'red or brown');
  if (g >= r && g >= b) return tone + 'green';
  return tone + 'blue';
}

/** Where an item sits in the room, in plain words ("against the left wall", "in the middle"). */
export function placeWords(f: FurnitureItem, space?: SpaceModel['spaces'][number]): string {
  if (!space) return '';
  const b = bounds(space.polygon);
  if (!b.w || !b.h) return '';
  const fx = (f.x - b.minX) / b.w, fy = (f.y - b.minY) / b.h;
  const edge = 0.22;
  const sides: string[] = [];
  if (fx < edge) sides.push('left'); else if (fx > 1 - edge) sides.push('right');
  if (fy < edge) sides.push('back'); else if (fy > 1 - edge) sides.push('front');
  if (!sides.length) return 'in the middle of the room';
  if (sides.length === 2) return `in the ${sides[1]} ${sides[0]} corner`;
  return `against the ${sides[0]} wall`;
}

/** One plain line per visible item: name, material, colour, size, position. */
export function describeItem(f: FurnitureItem, space?: SpaceModel['spaces'][number]): string {
  const parts: string[] = [];
  if (f.material) parts.push(f.material);
  const name = hexName(f.color);
  if (name || f.color) parts.push(`${name} ${f.color || ''}`.trim());
  parts.push(`${cm(f.w)} wide`, `${cm(f.d)} deep`, `${cm(f.h)} high`);
  const where = placeWords(f, space);
  return `${f.name} (${parts.join(', ')})${where ? `, ${where}` : ''}`;
}

function openingLines(model: SpaceModel): string[] {
  const space = model.spaces[0];
  if (!space) return [];
  const n = space.polygon.length;
  return model.openings.filter((o) => o.spaceId === space.id).map((o) => {
    const a = space.polygon[o.wallIndex % n], c = space.polygon[(o.wallIndex + 1) % n];
    const mx = (a.x + c.x) / 2, my = (a.y + c.y) / 2;
    const b = bounds(space.polygon);
    const dx = (mx - (b.minX + b.w / 2)) / (b.w || 1), dy = (my - (b.minY + b.h / 2)) / (b.h || 1);
    const side = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'front' : 'back');
    return `${o.kind} ${cm(o.widthM)} wide on the ${side} wall`;
  });
}

/** Stable key for a render: same model version, camera view and style give the same key. */
export function cacheKey(model: SpaceModel, furniture: FurnitureItem[], camera: string, style: RenderStyle): string {
  const items = furniture.map((f) => [f.id, f.name, f.x, f.y, f.rotation, f.w, f.d, f.h, f.color, f.material ?? ''].join(':')).join('|');
  const src = [model.id, model.version, model.ceilingM, camera, style, items].join('#');
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return `${model.version}-${style}-${h1.toString(36)}${h2.toString(36)}`;
}

export interface PromptInput {
  model: SpaceModel;
  furniture: FurnitureItem[];
  style: RenderStyle;
  requirements?: Pick<Requirements, 'style' | 'purpose'> | null;
}

export function buildPrompt({ model, furniture, style, requirements }: PromptInput): string {
  const space = model.spaces[0];
  const b = space ? bounds(space.polygon) : null;
  const preset = STYLES.find((s) => s.id === style) ?? STYLES[0];
  const lines: string[] = [];
  lines.push('Turn the attached 3D model view into a photorealistic interior photograph of the same room.');
  lines.push(`Room: ${space?.name ?? model.name}${b ? `, about ${cm(b.w)} by ${cm(b.h)}` : ''}, ceiling ${cm(model.ceilingM)}.`);
  lines.push('Walls: matte off-white paint. Floor: warm light wood.');
  const doors = model.openings.filter((o) => o.kind === 'door').length;
  const windows = model.openings.filter((o) => o.kind === 'window').length;
  if (doors || windows) {
    lines.push(`Openings: ${windows} window${windows === 1 ? '' : 's'}, ${doors} door${doors === 1 ? '' : 's'}, where the reference shows them.`);
    openingLines(model).forEach((l) => lines.push(`- ${l}`));
  }
  if (furniture.length) {
    lines.push(`Furniture: exactly ${furniture.length} item${furniture.length === 1 ? '' : 's'}, listed once each, and nothing else. The count and the positions must not change:`);
    furniture.forEach((f) => lines.push(`- ${describeItem(f, space)}`));
  } else {
    lines.push('The room is empty: show no furniture.');
  }
  if (requirements?.style) lines.push(`Interior style: ${requirements.style}.`);
  if (requirements?.purpose) lines.push(`The room is used for: ${requirements.purpose}.`);
  if (preset.look) lines.push(`Look: ${preset.look}.`);
  lines.push(`Lighting: ${preset.light}.`);
  lines.push('Strict rules: keep the room geometry, the camera position and framing, the image proportions, and every object position, size and orientation exactly as in the reference image. Match the reference pixel for pixel in layout: each wall, window, door and piece of furniture must sit where it sits in the reference, at the same relative size. Do not add, remove, merge, split or swap furniture: the count stays exactly as listed. No people, no pets, no text, no logos, no watermarks. Photographic realism, natural materials, soft shadows.');
  return lines.join('\n');
}

/** True when pixels carry no picture: fully transparent, a single flat colour, or nearly so. */
export function isBlankFrame(data: ArrayLike<number>, samples = 400): boolean {
  const px = Math.floor(data.length / 4);
  if (px === 0) return true;
  const step = Math.max(1, Math.floor(px / samples));
  let n = 0, opaque = 0, minL = 255, maxL = 0;
  for (let i = 0; i < px; i += step) {
    const o = i * 4;
    n++;
    if (data[o + 3] > 8) opaque++;
    const l = (data[o] + data[o + 1] + data[o + 2]) / 3;
    if (l < minL) minL = l;
    if (l > maxL) maxL = l;
  }
  return opaque / n < 0.05 || maxL - minL < 6;
}
