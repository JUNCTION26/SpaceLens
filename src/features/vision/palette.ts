// Palette extraction without AI: median cut over a small RGBA sample, then role assignment.

export type Role = 'wall' | 'floor' | 'furniture' | 'accent' | 'metal' | 'wood';
export interface Swatch { hex: string; share: number; role: Role; sat: number; light: number }

type RGB = [number, number, number];

export const toHex = ([r, g, b]: RGB) => '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
export function fromHex(hex: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function hsl([r, g, b]: RGB): { h: number; s: number; l: number } {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2, d = mx - mn;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === R ? ((G - B) / d + (G < B ? 6 : 0)) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: h * 60, s, l };
}
export function mix(a: string, b: string, t: number): string {
  const x = fromHex(a), y = fromHex(b);
  return toHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** Median cut on RGBA data. Returns up to k colours with their share of the opaque pixels, largest first. */
export function medianCut(data: ArrayLike<number>, k = 5): Array<{ rgb: RGB; share: number }> {
  const px: RGB[] = [];
  for (let i = 0; i + 3 < data.length; i += 4) if (data[i + 3] >= 128) px.push([data[i], data[i + 1], data[i + 2]]);
  if (!px.length) return [];
  let boxes: RGB[][] = [px];
  while (boxes.length < k) {
    let bi = -1, best = 0, bc = 0;
    boxes.forEach((b, i) => {
      if (b.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255, hi = 0;
        for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
        const score = (hi - lo) * Math.sqrt(b.length);
        if (score > best) { best = score; bi = i; bc = c; }
      }
    });
    if (bi < 0 || best === 0) break;
    const b = boxes[bi].slice().sort((p, q) => p[bc] - q[bc]);
    const mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  boxes = boxes.filter((b) => b.length);
  const mean = (b: RGB[]): RGB => {
    const s: RGB = [0, 0, 0];
    for (const p of b) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
    return [s[0] / b.length, s[1] / b.length, s[2] / b.length];
  };
  // A few k-means passes seeded by the boxes pull each centre onto its real cluster.
  let centres = boxes.map(mean);
  let groups: RGB[][] = boxes;
  for (let it = 0; it < 6; it++) {
    const g: RGB[][] = centres.map(() => []);
    for (const p of px) {
      let bi = 0, bd = Infinity;
      centres.forEach((c, i) => { const d = (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2; if (d < bd) { bd = d; bi = i; } });
      g[bi].push(p);
    }
    groups = g.filter((x) => x.length);
    centres = groups.map(mean);
  }
  return groups.map((b, i) => ({ rgb: centres[i], share: b.length / px.length })).sort((a, b) => b.share - a.share);
}

/** Assigns one role to each colour. Roles are unique where the colour count allows. */
export function assignRoles(cols: Array<{ rgb: RGB; share: number }>): Swatch[] {
  const info = cols.map((c) => { const h = hsl(c.rgb); return { c, h, hex: toHex(c.rgb) }; });
  const left = new Set(info.map((_, i) => i));
  const role = new Map<number, Role>();
  const take = (r: Role, score: (i: number) => number) => {
    let bi = -1, bs = -Infinity;
    left.forEach((i) => { const s = score(i); if (s > bs) { bs = s; bi = i; } });
    if (bi >= 0) { role.set(bi, r); left.delete(bi); }
  };
  // wall: the biggest, light, calm area. accent: the most saturated that is not huge.
  take('wall', (i) => info[i].c.share * 2 + info[i].h.l - info[i].h.s * 0.5);
  take('accent', (i) => info[i].h.s * 1.5 - info[i].c.share);
  take('wood', (i) => { const { h, s, l } = info[i].h; const warm = h >= 15 && h <= 50 ? 1 : 0; return warm * (s > 0.15 ? 1 : 0.2) + (1 - Math.abs(l - 0.4)) * 0.3; });
  take('metal', (i) => (1 - info[i].h.s) * 0.8 + Math.abs(info[i].h.l - 0.5) * 0.3);
  take('floor', (i) => info[i].c.share);
  // furniture gets whatever is left; with fewer than 5 colours the missing roles fall to the nearest one.
  left.forEach((i) => role.set(i, 'furniture'));
  const out = info.map((x, i) => ({ hex: x.hex, share: x.c.share, role: role.get(i) ?? 'furniture', sat: x.h.s, light: x.h.l }));
  // Order for display: wall, floor, furniture, accent, then material colours.
  const order: Role[] = ['wall', 'floor', 'furniture', 'accent', 'wood', 'metal'];
  return out.sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role));
}

export function extractPalette(data: ArrayLike<number>, k = 5): Swatch[] { return assignRoles(medianCut(data, k)); }

/** Role colours for recolouring, with fallbacks when the picture has fewer than five colours. */
export function roleColors(sw: Swatch[]): Record<Role, string> {
  const by = (r: Role) => sw.find((s) => s.role === r)?.hex;
  const first = sw[0]?.hex ?? '#d8d2c8';
  const wall = by('wall') ?? first;
  const furniture = by('furniture') ?? by('floor') ?? wall;
  return {
    wall, furniture, floor: by('floor') ?? mix(wall, '#000000', 0.2),
    accent: by('accent') ?? furniture, wood: by('wood') ?? by('floor') ?? furniture, metal: by('metal') ?? '#9aa0a6',
  };
}

/** Browser only: decode a file, downscale to 64 px on the long side, and extract. */
export async function paletteFromFile(file: Blob, k = 5): Promise<{ swatches: Swatch[]; thumb: string }> {
  const bmp = await createImageBitmap(file);
  const sc = 64 / Math.max(bmp.width, bmp.height);
  const w = Math.max(1, Math.round(bmp.width * sc)), h = Math.max(1, Math.round(bmp.height * sc));
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const cx = cv.getContext('2d')!; cx.drawImage(bmp, 0, 0, w, h);
  const swatches = extractPalette(cx.getImageData(0, 0, w, h).data, k);
  const t = 96 / Math.max(bmp.width, bmp.height);
  const tc = document.createElement('canvas'); tc.width = Math.max(1, Math.round(bmp.width * t)); tc.height = Math.max(1, Math.round(bmp.height * t));
  tc.getContext('2d')!.drawImage(bmp, 0, 0, tc.width, tc.height);
  return { swatches, thumb: tc.toDataURL('image/jpeg', 0.7) };
}
