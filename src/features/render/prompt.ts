import { bounds } from '../../core/geometry';
import type { FurnitureItem, Requirements, SpaceModel } from '../../core/types';

export type RenderStyle = 'daylight' | 'evening' | 'showroom';

export const STYLES: Array<{ id: RenderStyle; label: string; light: string }> = [
  { id: 'daylight', label: 'Natural daylight', light: 'soft natural daylight from the windows, late morning, neutral white balance' },
  { id: 'evening', label: 'Evening warm', light: 'warm evening light, lamps switched on, dim golden glow, long soft shadows' },
  { id: 'showroom', label: 'Showroom', light: 'bright even showroom lighting, clean and crisp, slightly styled' },
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

/** One plain line per visible item: name, material, colour, size. */
export function describeItem(f: FurnitureItem): string {
  const parts: string[] = [];
  if (f.material) parts.push(f.material);
  const name = hexName(f.color);
  if (name || f.color) parts.push(`${name} ${f.color || ''}`.trim());
  parts.push(`${cm(f.w)} wide`, `${cm(f.d)} deep`, `${cm(f.h)} high`);
  return `${f.name} (${parts.join(', ')})`;
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
  if (doors || windows) lines.push(`Openings: ${windows} window${windows === 1 ? '' : 's'}, ${doors} door${doors === 1 ? '' : 's'}, where the reference shows them.`);
  if (furniture.length) {
    lines.push('Furniture, exactly these and nothing else:');
    furniture.forEach((f) => lines.push(`- ${describeItem(f)}`));
  } else {
    lines.push('The room is empty: show no furniture.');
  }
  if (requirements?.style) lines.push(`Interior style: ${requirements.style}.`);
  if (requirements?.purpose) lines.push(`The room is used for: ${requirements.purpose}.`);
  lines.push(`Lighting: ${preset.light}.`);
  lines.push('Strict rules: keep the room geometry, the camera angle and every object position, size and orientation exactly as in the reference image. Do not add or remove furniture. No people, no pets, no text, no logos, no watermarks. Photographic realism, natural materials, soft shadows.');
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
