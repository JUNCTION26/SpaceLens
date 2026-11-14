// Minimal WebM writer for WebCodecs output: one VP9 (or VP8/AV1) video track and an optional Opus
// audio track, with Duration, a SeekHead and Cues so players can show the length and seek.

const enc = new TextEncoder();

function idBytes(id) {
  const out = [];
  while (id > 0) { out.unshift(id & 0xff); id = Math.floor(id / 256); }
  return out;
}
function sizeBytes(n, width = 0) {
  let len = 1;
  while (n >= 2 ** (7 * len) - 1 && len < 8) len++;
  len = Math.max(len, width);
  const out = new Array(len);
  let v = n;
  for (let i = len - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
  out[0] |= 0x80 >> (len - 1);
  return out;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function el(id, payload, sizeWidth = 0) {
  const body = payload instanceof Uint8Array ? payload : concat(payload);
  return concat([new Uint8Array(idBytes(id)), new Uint8Array(sizeBytes(body.length, sizeWidth)), body]);
}
function uint(id, v, width = 0) {
  const b = [];
  let x = v;
  do { b.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0);
  while (b.length < width) b.unshift(0);
  return el(id, new Uint8Array(b));
}
function float(id, v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); }
function str(id, s) { return el(id, enc.encode(s)); }

function opusHead(channels, sampleRate, preSkip = 312) {
  const b = new Uint8Array(19);
  b.set(enc.encode('OpusHead'));
  const dv = new DataView(b.buffer);
  b[8] = 1; b[9] = channels; dv.setUint16(10, preSkip, true); dv.setUint32(12, sampleRate, true); dv.setInt16(16, 0, true); b[18] = 0;
  return b;
}

export class WebmMuxer {
  /** video: { codec: 'V_VP9', width, height }; audio: { sampleRate, channels, description? } | null */
  constructor({ video, audio = null }) {
    this.video = video; this.audio = audio; this.chunks = [];
  }
  add(track, chunk, meta) {
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    if (track === 2 && meta?.decoderConfig?.description && !this.audio.description) this.audio.description = new Uint8Array(meta.decoderConfig.description);
    this.chunks.push({ track, t: chunk.timestamp / 1000, key: chunk.type === 'key', data });
  }
  finish(durationMs) {
    const SEG_CHILD = { info: 0x1549a966, tracks: 0x1654ae6b, cues: 0x1c53bb6b };
    const info = el(SEG_CHILD.info, [uint(0x2ad7b1, 1000000), str(0x4d80, 'SpaceLens video'), str(0x5741, 'SpaceLens video'), float(0x4489, durationMs)]);
    const tracks = [el(0xae, [uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, this.video.codec), el(0xe0, [uint(0xb0, this.video.width), uint(0xba, this.video.height)])])];
    if (this.audio) {
      const a = this.audio;
      tracks.push(el(0xae, [uint(0xd7, 2), uint(0x73c5, 2), uint(0x83, 2), str(0x86, 'A_OPUS'), el(0x63a2, a.description ?? opusHead(a.channels, a.sampleRate)),
        uint(0x56aa, 6500000), uint(0x56bb, 80000000), el(0xe1, [float(0xb5, a.sampleRate), uint(0x9f, a.channels)])]));
    }
    const tracksEl = el(SEG_CHILD.tracks, tracks);

    // Clusters start at video keyframes (and at least every 30 s, for the 16-bit block offsets).
    const sorted = this.chunks.slice().sort((x, y) => x.t - y.t || x.track - y.track);
    const clusters = [];
    let cur = null;
    for (const c of sorted) {
      const tc = Math.round(c.t);
      if (!cur || (c.track === 1 && c.key) || tc - cur.tc > 30000) { cur = { tc, blocks: [], cue: c.track === 1 && c.key }; clusters.push(cur); }
      const head = new Uint8Array(4);
      head[0] = 0x80 | c.track;
      new DataView(head.buffer).setInt16(1, tc - cur.tc);
      head[3] = c.key ? 0x80 : 0;
      cur.blocks.push(el(0xa3, concat([head, c.data])));
    }
    const clusterEls = clusters.map((c) => el(0x1f43b675, [uint(0xe7, c.tc), ...c.blocks]));

    // SeekHead with fixed-width positions, so its size does not depend on the offsets it holds.
    const seekFor = (positions) => el(0x114d9b74, Object.entries(positions).map(([id, pos]) => el(0x4dbb, [el(0x53ab, new Uint8Array(idBytes(Number(id)))), uint(0x53ac, pos, 8)])));
    const probe = seekFor({ [SEG_CHILD.info]: 0, [SEG_CHILD.tracks]: 0, [SEG_CHILD.cues]: 0 });
    const infoPos = probe.length;
    const tracksPos = infoPos + info.length;
    let pos = tracksPos + tracksEl.length;
    const cuePoints = [];
    for (let i = 0; i < clusterEls.length; i++) {
      if (clusters[i].cue) cuePoints.push(el(0xbb, [uint(0xb3, clusters[i].tc), el(0xb7, [uint(0xf7, 1), uint(0xf1, pos)])]));
      pos += clusterEls[i].length;
    }
    const cues = el(SEG_CHILD.cues, cuePoints);
    const seek = seekFor({ [SEG_CHILD.info]: infoPos, [SEG_CHILD.tracks]: tracksPos, [SEG_CHILD.cues]: pos });

    const header = el(0x1a45dfa3, [uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 4), uint(0x4285, 2)]);
    const body = [seek, info, tracksEl, ...clusterEls, cues];
    const bodyLen = body.reduce((a, b) => a + b.length, 0);
    const segHead = concat([new Uint8Array(idBytes(0x18538067)), new Uint8Array(sizeBytes(bodyLen, 8))]);
    return new Blob([header, segHead, ...body], { type: 'video/webm' });
  }
}
