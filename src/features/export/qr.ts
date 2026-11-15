/** Dependency-free QR encoder: byte mode, versions 1 to 20, error correction M. */

export type QrMatrix = boolean[][];
export interface QrResult { matrix: QrMatrix; version: number; mask: number }

// [ecc bytes per block, [count, data bytes] groups] for level M, versions 1..20
const EC_M: Array<[number, Array<[number, number]>]> = [
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]],
  [30, [[1, 50], [4, 51]]], [22, [[6, 36], [2, 37]]], [22, [[8, 37], [1, 38]]], [24, [[4, 40], [5, 41]]], [24, [[5, 41], [5, 42]]],
  [28, [[7, 45], [3, 46]]], [28, [[10, 46], [1, 47]]], [26, [[9, 43], [4, 44]]], [26, [[3, 44], [11, 45]]], [26, [[3, 41], [13, 42]]],
];
const ALIGN: number[][] = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
  [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
];

export const MAX_VERSION = 20;
export const sizeOf = (v: number) => 17 + 4 * v;

/** Block layout for a version: data lengths per block plus ecc length. */
export function blockLayout(version: number): { dataLens: number[]; ecc: number } {
  const [ecc, groups] = EC_M[version - 1];
  const dataLens: number[] = [];
  for (const [n, len] of groups) for (let i = 0; i < n; i++) dataLens.push(len);
  return { dataLens, ecc };
}
export const dataCapacity = (v: number) => blockLayout(v).dataLens.reduce((a, b) => a + b, 0);

// GF(256), polynomial 0x11D
export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
export const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function generator(deg: number): number[] {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);
    }
    g = next;
  }
  return g; // highest degree first, monic
}

export function rsEncode(data: number[], deg: number): number[] {
  const g = generator(deg);
  const rem = new Array<number>(deg).fill(0);
  for (const d of data) {
    const f = d ^ rem[0];
    rem.shift(); rem.push(0);
    if (f) for (let i = 0; i < deg; i++) rem[i] ^= gfMul(g[i + 1], f);
  }
  return rem;
}

/** True when the codeword (data then ecc) evaluates to zero at every generator root. */
export function rsRemainderIsZero(codeword: number[], deg: number): boolean {
  for (let r = 0; r < deg; r++) {
    let acc = 0;
    for (const c of codeword) acc = gfMul(acc, GF_EXP[r]) ^ c;
    if (acc !== 0) return false;
  }
  return true;
}

const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));

export function pickVersion(len: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const ccBits = v < 10 ? 8 : 16;
    if (4 + ccBits + len * 8 <= dataCapacity(v) * 8) return v;
  }
  return 0;
}
export const fits = (text: string) => pickVersion(utf8(text).length) > 0;

function dataCodewords(bytes: number[], version: number): number[] {
  const cap = dataCapacity(version) * 8;
  const bits: number[] = [];
  const put = (val: number, n: number) => { for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; out.push(b); }
  for (let pad = 0xec; out.length < cap / 8; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}

/** Splits data into blocks, appends ecc, and interleaves. */
export function interleave(data: number[], version: number): number[] {
  const { dataLens, ecc } = blockLayout(version);
  const blocks: number[][] = [];
  let p = 0;
  for (const len of dataLens) { blocks.push(data.slice(p, p + len)); p += len; }
  const eccs = blocks.map((b) => rsEncode(b, ecc));
  const out: number[] = [];
  const maxLen = Math.max(...dataLens);
  for (let i = 0; i < maxLen; i++) for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecc; i++) for (const e of eccs) out.push(e[i]);
  return out;
}

/** Marks every module that is not data: finders, timing, alignment, format, version, dark module. */
export function functionModules(version: number): boolean[][] {
  const n = sizeOf(version);
  const f = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const rect = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (x >= 0 && y >= 0 && x < n && y < n) f[y][x] = true;
  };
  rect(0, 0, 9, 9); rect(n - 8, 0, 8, 9); rect(0, n - 8, 9, 8);
  rect(6, 0, 1, n); rect(0, 6, n, 1);
  const pos = ALIGN[version - 1];
  for (const cy of pos) for (const cx of pos) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos[pos.length - 1]) || (cx === pos[pos.length - 1] && cy === 6)) continue;
    rect(cx - 2, cy - 2, 5, 5);
  }
  if (version >= 7) { rect(n - 11, 0, 3, 6); rect(0, n - 11, 6, 3); }
  return f;
}

const bchRem = (value: number, gen: number, genBits: number, shift: number) => {
  let r = value << shift;
  for (let i = genBits - 1 + shift; i >= genBits - 1; i--) if ((r >>> i) & 1) r ^= gen << (i - (genBits - 1));
  return r;
};
export const formatBits = (mask: number) => {
  const data = mask; // level M is 00
  return ((data << 10) | bchRem(data, 0x537, 11, 10)) ^ 0x5412;
};
export const versionBits = (v: number) => (v << 12) | bchRem(v, 0x1f25, 13, 12);

export const maskFn = (m: number, x: number, y: number): boolean => {
  switch (m) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
};

function drawFunctions(m: QrMatrix, version: number, mask: number) {
  const n = m.length;
  const set = (x: number, y: number, v: boolean) => { if (x >= 0 && y >= 0 && x < n && y < n) m[y][x] = v; };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(cx + dx, cy + dy, d !== 4 && d !== 2);
    }
  };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  const pos = ALIGN[version - 1];
  for (const cy of pos) for (const cx of pos) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === pos[pos.length - 1]) || (cx === pos[pos.length - 1] && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const fb = formatBits(mask);
  const bit = (i: number) => ((fb >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, bit(i));
  set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) set(8, n - 15 + i, bit(i));
  set(8, n - 8, true);
  if (version >= 7) {
    const vb = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = ((vb >>> i) & 1) === 1;
      const a = n - 11 + (i % 3), c = Math.floor(i / 3);
      set(a, c, b); set(c, a, b);
    }
  }
}

function penalty(m: QrMatrix): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    // finder-like 1011101 with 4 light modules on a side
    for (let i = 0; i + 7 <= n; i++) {
      const pat = [1, 0, 1, 1, 1, 0, 1].every((v, k) => (get(i + k) ? 1 : 0) === v);
      if (!pat) continue;
      const light = (a: number, b: number) => { for (let k = a; k < b; k++) if (k >= 0 && k < n && get(k)) return false; return true; };
      if ((i - 4 >= 0 && light(i - 4, i)) || (i + 11 <= n && light(i + 7, i + 11))) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((i) => m[y][i]);
  for (let x = 0; x < n; x++) line((i) => m[i][x]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) {
    const c = m[y][x];
    if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) score += 3;
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const pct = (dark * 100) / (n * n);
  score += 10 * Math.max(0, Math.ceil(Math.abs(pct - 50) / 5) - 1);
  return score;
}

/** Zigzag order of data module positions. */
export function dataPositions(version: number): Array<[number, number]> {
  const n = sizeOf(version);
  const fn = functionModules(version);
  const out: Array<[number, number]> = [];
  let up = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx;
        if (!fn[y][x]) out.push([x, y]);
      }
    }
    up = !up;
  }
  return out;
}

/** Encodes text (UTF-8, byte mode). Returns null when it exceeds version 20 at level M. */
export function qrEncode(text: string): QrResult | null {
  const bytes = utf8(text);
  const version = pickVersion(bytes.length);
  if (!version) return null;
  const codewords = interleave(dataCodewords(bytes, version), version);
  const bits: boolean[] = [];
  for (const c of codewords) for (let i = 7; i >= 0; i--) bits.push(((c >>> i) & 1) === 1);
  const n = sizeOf(version);
  const pos = dataPositions(version);
  let best: QrResult | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m: QrMatrix = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
    drawFunctions(m, version, mask);
    pos.forEach(([x, y], i) => { m[y][x] = (i < bits.length ? bits[i] : false) !== maskFn(mask, x, y); });
    const s = penalty(m);
    if (s < bestScore) { bestScore = s; best = { matrix: m, version, mask }; }
  }
  return best;
}

/** SVG for the code: numbers only, so nothing from the text reaches the markup. */
export function qrSvg(text: string, opts: { size?: number; margin?: number } = {}): string | null {
  const r = qrEncode(text);
  if (!r) return null;
  const size = Math.max(16, Math.min(4096, Math.round(Number(opts.size ?? 256)) || 256));
  const margin = Math.max(0, Math.min(16, Math.round(Number(opts.margin ?? 4)) || 0));
  const n = r.matrix.length;
  const total = n + margin * 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!r.matrix[y][x]) { x++; continue; }
      let e = x;
      while (e < n && r.matrix[y][e]) e++;
      d += `M${x + margin} ${y + margin}h${e - x}v1h${x - e}z`;
      x = e;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
