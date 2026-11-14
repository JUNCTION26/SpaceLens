// Minimal MP4 writer for WebCodecs output: H.264 video and AAC audio, moov first (fast start),
// one sample per chunk. Enough for upload sites and every common player.

const te = new TextEncoder();

function cat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
const u8 = (...v) => new Uint8Array(v);
function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
function box(type, ...parts) { const body = cat(parts.flat()); return cat([u32(body.length + 8), te.encode(type), body]); }
const full = (type, version, flags, ...parts) => box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...parts);
const MATRIX = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000].map(u32);

function stts(durations) {
  const runs = [];
  for (const d of durations) { const last = runs[runs.length - 1]; if (last && last[1] === d) last[0]++; else runs.push([1, d]); }
  return full('stts', 0, 0, u32(runs.length), ...runs.map(([c, d]) => cat([u32(c), u32(d)])));
}
const stsc = () => full('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
const stsz = (sizes) => full('stsz', 0, 0, u32(0), u32(sizes.length), ...sizes.map(u32));
const stco = (offsets) => full('stco', 0, 0, u32(offsets.length), ...offsets.map(u32));
const dinf = () => box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1)));

function desc(tag, body) { return cat([u8(tag, 0x80, 0x80, 0x80, body.length), body]); }
function esds(asc, bitrate) {
  const dsi = desc(0x05, asc);
  const dcd = desc(0x04, cat([u8(0x40, 0x15, 0, 0, 0), u32(bitrate), u32(bitrate), dsi]));
  const es = desc(0x03, cat([u16(2), u8(0), dcd, desc(0x06, u8(0x02))]));
  return full('esds', 0, 0, es);
}

export class Mp4Muxer {
  /** video: { width, height, timescale }; audio: { sampleRate, channels, bitrate } | null */
  constructor({ video, audio = null }) {
    this.video = { ...video, timescale: video.timescale ?? 90000, samples: [], avcC: null };
    this.audio = audio ? { ...audio, samples: [], asc: null } : null;
  }
  addVideo(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.video.avcC) this.video.avcC = new Uint8Array(meta.decoderConfig.description);
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    this.video.samples.push({ data, t: chunk.timestamp, d: chunk.duration ?? 0, key: chunk.type === 'key' });
  }
  addAudio(chunk, meta) {
    if (meta?.decoderConfig?.description && !this.audio.asc) this.audio.asc = new Uint8Array(meta.decoderConfig.description);
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    this.audio.samples.push({ data, t: chunk.timestamp, d: chunk.duration ?? 0 });
  }
  finish() {
    const v = this.video, a = this.audio;
    const vts = v.timescale;
    // Samples stay in decode order (the encoder runs without B-frames, so that is also time order).
    const vDur = v.samples.map((s, i) => {
      const next = v.samples[i + 1];
      const us = next ? next.t - s.t : (s.d || 33333);
      return Math.max(1, Math.round((us * vts) / 1e6));
    });
    const vTotal = vDur.reduce((x, y) => x + y, 0);
    const aTs = a ? a.sampleRate : 1;
    const aDur = a ? a.samples.map(() => 1024) : [];
    const aTotal = aDur.reduce((x, y) => x + y, 0);
    const movieMs = Math.round(Math.max(vTotal / vts, a ? aTotal / aTs : 0) * 1000);
    // AAC needs its AudioSpecificConfig; build the plain LC one if the encoder did not hand it over.
    if (a && !a.asc) {
      const fi = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000].indexOf(a.sampleRate);
      a.asc = u8((2 << 3) | (fi >> 1), ((fi & 1) << 7) | (a.channels << 3));
    }

    const build = (vOff, aOff) => {
      const vTrak = box('trak',
        full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(Math.round((vTotal / vts) * 1000)), u32(0), u32(0), u16(0), u16(0), u16(0), u16(0), ...MATRIX, u32(v.width << 16), u32(v.height << 16)),
        box('mdia',
          full('mdhd', 0, 0, u32(0), u32(0), u32(vts), u32(vTotal), u16(0x55c4), u16(0)),
          full('hdlr', 0, 0, u32(0), te.encode('vide'), u32(0), u32(0), u32(0), te.encode('VideoHandler\0')),
          box('minf',
            full('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)),
            dinf(),
            box('stbl',
              full('stsd', 0, 0, u32(1), box('avc1', u8(0, 0, 0, 0, 0, 0), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0), u16(v.width), u16(v.height),
                u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff), box('avcC', v.avcC ?? new Uint8Array(0)))),
              stts(vDur),
              full('stss', 0, 0, u32(v.samples.filter((s) => s.key).length), ...v.samples.map((s, i) => (s.key ? u32(i + 1) : null)).filter(Boolean)),
              stsc(), stsz(v.samples.map((s) => s.data.length)), stco(vOff)))));
      const traks = [vTrak];
      if (a) {
        traks.push(box('trak',
          full('tkhd', 0, 3, u32(0), u32(0), u32(2), u32(0), u32(Math.round((aTotal / aTs) * 1000)), u32(0), u32(0), u16(0), u16(1), u16(0x0100), u16(0), ...MATRIX, u32(0), u32(0)),
          box('mdia',
            full('mdhd', 0, 0, u32(0), u32(0), u32(aTs), u32(aTotal), u16(0x55c4), u16(0)),
            full('hdlr', 0, 0, u32(0), te.encode('soun'), u32(0), u32(0), u32(0), te.encode('SoundHandler\0')),
            box('minf',
              full('smhd', 0, 0, u16(0), u16(0)),
              dinf(),
              box('stbl',
                full('stsd', 0, 0, u32(1), box('mp4a', u8(0, 0, 0, 0, 0, 0), u16(1), u32(0), u32(0), u16(a.channels), u16(16), u16(0), u16(0), u32(a.sampleRate << 16), esds(a.asc, a.bitrate))),
                stts(aDur), stsc(), stsz(a.samples.map((s) => s.data.length)), stco(aOff))))));
      }
      const mvhd = full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieMs), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), ...MATRIX, new Uint8Array(24), u32(a ? 3 : 2));
      return box('moov', mvhd, ...traks);
    };

    const ftyp = box('ftyp', te.encode('isom'), u32(512), te.encode('isom'), te.encode('iso2'), te.encode('avc1'), te.encode('mp41'));
    // Interleave roughly by time so players do not have to jump around the file.
    const order = [...v.samples.map((s) => ({ s, k: 'v' })), ...(a ? a.samples.map((s) => ({ s, k: 'a' })) : [])].sort((x, y) => x.s.t - y.s.t);
    const sizeMoov = build(v.samples.map(() => 0), a ? a.samples.map(() => 0) : []).length;
    let off = ftyp.length + sizeMoov + 8;
    const vOff = [], aOff = [];
    for (const o of order) { (o.k === 'v' ? vOff : aOff).push(off); o.s.off = off; off += o.s.data.length; }
    // stco must keep the same order as samples in each track
    const vOffs = v.samples.map((s) => s.off), aOffs = a ? a.samples.map((s) => s.off) : [];
    const moov = build(vOffs, aOffs);
    const mdatLen = off - (ftyp.length + moov.length);
    return new Blob([ftyp, moov, u32(mdatLen), te.encode('mdat'), ...order.map((o) => o.s.data)], { type: 'video/mp4' });
  }
}
