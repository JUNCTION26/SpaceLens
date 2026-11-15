import { describe, expect, it } from 'vitest';
import { blockLayout, dataPositions, formatBits, fits, maskFn, qrEncode, qrSvg, rsRemainderIsZero, sizeOf, versionBits } from './qr';

/** Small reader used only to check the encoder: format, unmask, deinterleave, verify blocks, read bytes. */
function decode(matrix: boolean[][], version: number) {
  const n = matrix.length;
  let fmt = 0;
  const get = (x: number, y: number) => (matrix[y][x] ? 1 : 0);
  const order: Array<[number, number]> = [];
  for (let i = 0; i <= 5; i++) order.push([8, i]);
  order.push([8, 7], [8, 8], [7, 8]);
  for (let i = 9; i < 15; i++) order.push([14 - i, 8]);
  order.forEach(([x, y], i) => { fmt |= get(x, y) << i; });
  let formatOk = false, mask = -1;
  for (let m = 0; m < 8; m++) if (formatBits(m) === fmt) { formatOk = true; mask = m; }
  const bytes: number[] = [];
  let acc = 0, cnt = 0;
  for (const [x, y] of dataPositions(version)) {
    acc = (acc << 1) | (get(x, y) ^ (maskFn(mask, x, y) ? 1 : 0));
    if (++cnt === 8) { bytes.push(acc); acc = 0; cnt = 0; }
  }
  const { dataLens, ecc } = blockLayout(version);
  const total = dataLens.reduce((a, b) => a + b, 0);
  const blocks = dataLens.map(() => [] as number[]);
  const eccs = dataLens.map(() => [] as number[]);
  let p = 0;
  for (let i = 0; i < Math.max(...dataLens); i++) blocks.forEach((b, k) => { if (i < dataLens[k]) b.push(bytes[p++]); });
  for (let i = 0; i < ecc; i++) eccs.forEach((e) => e.push(bytes[p++]));
  const zero = blocks.every((b, k) => rsRemainderIsZero([...b, ...eccs[k]], ecc));
  const data = blocks.flat();
  // byte mode header
  const bits = data.flatMap((b) => Array.from({ length: 8 }, (_, i) => (b >> (7 - i)) & 1));
  const read = (from: number, len: number) => bits.slice(from, from + len).reduce((a, b) => (a << 1) | b, 0);
  const mode = read(0, 4);
  const ccBits = version < 10 ? 8 : 16;
  const len = read(4, ccBits);
  const out = Array.from({ length: len }, (_, i) => read(4 + ccBits + i * 8, 8));
  void n; void total;
  return { formatOk, mask, zero, mode, text: new TextDecoder().decode(new Uint8Array(out)) };
}

const url300 = 'https://example.org/design/' + 'abcDEF-_0123456789'.repeat(16).slice(0, 273);

describe('qr encoder', () => {
  it('draws finder patterns in three corners and timing patterns', () => {
    const r = qrEncode('hello')!;
    const m = r.matrix, n = m.length;
    expect(n).toBe(sizeOf(r.version));
    const finder = (x0: number, y0: number) => {
      for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        expect(m[y0 + y][x0 + x]).toBe(d !== 2);
      }
    };
    finder(0, 0); finder(n - 7, 0); finder(0, n - 7);
    expect(m[n - 8][8]).toBe(true);
    for (let i = 8; i < n - 8; i++) { expect(m[6][i]).toBe(i % 2 === 0); expect(m[i][6]).toBe(i % 2 === 0); }
  });

  it('writes format bits that name level M and the chosen mask, in both copies', () => {
    const r = qrEncode('hello')!;
    const m = r.matrix, n = m.length;
    const fb = formatBits(r.mask);
    let a = 0, b = 0;
    const first: Array<[number, number]> = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    first.forEach(([x, y], i) => { a |= (m[y][x] ? 1 : 0) << i; });
    for (let i = 0; i < 8; i++) b |= (m[8][n - 1 - i] ? 1 : 0) << i;
    for (let i = 8; i < 15; i++) b |= (m[n - 15 + i][8] ? 1 : 0) << i;
    expect(a).toBe(fb);
    expect(b).toBe(fb);
    expect((fb ^ 0x5412) >> 13).toBe(0); // level M is 00
    expect((fb ^ 0x5412) >> 10 & 7).toBe(r.mask);
  });

  it('known format and version words', () => {
    expect(formatBits(0)).toBe(0b101010000010010);
    expect(versionBits(7)).toBe(0x07c94);
  });

  it('round trips strings through a reader with zero Reed-Solomon remainders', () => {
    const cases = ['a', 'HELLO WORLD', 'https://spacelens.app/#m=abc', 'Åäö ü 日本語', url300, 'x'.repeat(600)];
    for (const text of cases) {
      const r = qrEncode(text)!;
      expect(r).not.toBeNull();
      const d = decode(r.matrix, r.version);
      expect(d.formatOk).toBe(true);
      expect(d.mask).toBe(r.mask);
      expect(d.zero).toBe(true);
      expect(d.mode).toBe(4);
      expect(d.text).toBe(text);
    }
    expect(qrEncode(url300)!.version).toBeGreaterThanOrEqual(10);
  });

  it('covers every version up to 20', () => {
    const seen = new Set<number>();
    for (let len = 1; len <= 666; len += 7) {
      const r = qrEncode('q'.repeat(len))!;
      seen.add(r.version);
      const d = decode(r.matrix, r.version);
      expect(d.zero && d.text.length === len).toBe(true);
    }
    expect(Math.max(...seen)).toBe(20);
  });

  it('refuses text beyond version 20', () => {
    expect(fits('x'.repeat(666))).toBe(true);
    expect(fits('x'.repeat(2000))).toBe(false);
    expect(qrEncode('x'.repeat(2000))).toBeNull();
    expect(qrSvg('x'.repeat(2000))).toBeNull();
  });

  it('svg holds only numbers in the path and ignores hostile input', () => {
    const svg = qrSvg('<script>"&</script>', { size: 300, margin: 2 })!;
    expect(svg).not.toContain('script');
    expect(svg).toMatch(/^<svg [^>]*width="300"/);
    const d = /<path d="([^"]*)"/.exec(svg)![1];
    expect(d).toMatch(/^[MhvzM0-9 \-]+$/);
    const evil = qrSvg('a', { size: '"><x' as unknown as number, margin: NaN })!;
    expect(evil).not.toContain('<x');
  });
});
