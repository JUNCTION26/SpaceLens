import { useMemo, useRef, useState } from 'react';
import { closestPointOnSegment, dist, uid } from '../../core/geometry';
import type { Evidence, Measurement, Vec2, WallMeta } from '../../core/types';
import { applyH, homography } from './homography';
import type { RoomDraft } from './build';
import { HintA4, HintCorners, Stepper } from './Stepper';

export type Method = 'tap' | 'gemini';
export interface TapPoint { x: number; y: number; method: Method }

interface Props {
  imageUrl: string;
  label: string;
  initialRoom?: TapPoint[];
  initialRef?: TapPoint[];
  aiOpenings?: AiOpening[];
  thicknessM: number;
  onDone: (draft: RoomDraft, info: { errCm: number | null }) => void;
  onBack: () => void;
  aiSlot?: React.ReactNode;
}

export interface AiOpening { kind: 'door' | 'window'; x: number; y: number }

const REF_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];

/** Floor-plane calibration: tap a known rectangle, then the room's floor corners, then confirm with a tape. */
export function Calibrate({ imageUrl, label, initialRoom, initialRef, aiOpenings = [], thicknessM, onDone, onBack, aiSlot }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState({ w: 1, h: 1 });
  const [refPts, setRefPts] = useState<TapPoint[]>(initialRef ?? []);
  const [roomPts, setRoomPts] = useState<TapPoint[]>(initialRoom ?? []);
  const [refKind, setRefKind] = useState<'a4' | 'custom'>('a4');
  const [cw, setCw] = useState(100);
  const [ch, setCh] = useState(100);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [tapeWall, setTapeWall] = useState(0);
  const [tapeCm, setTapeCm] = useState('');
  const [loupe, setLoupe] = useState<Vec2 | null>(null);

  const [sub, setSub] = useState<'ref' | 'room' | 'check'>('ref');
  const [drag, setDrag] = useState<{ ref: boolean; i: number } | null>(null);
  const step: 'ref' | 'room' = sub === 'ref' ? 'ref' : 'room';
  const refW = refKind === 'a4' ? 0.21 : cw / 100;
  const refH = refKind === 'a4' ? 0.297 : ch / 100;

  const H = useMemo(() => {
    if (refPts.length < 4) return null;
    return homography(refPts.map((p) => ({ x: p.x * nat.w, y: p.y * nat.h })), [{ x: 0, y: 0 }, { x: refW, y: 0 }, { x: refW, y: refH }, { x: 0, y: refH }]);
  }, [refPts, refW, refH, nat]);

  const floor = useMemo(() => (H ? roomPts.map((p) => applyH(H, { x: p.x * nat.w, y: p.y * nat.h })) : []), [H, roomPts, nat]);
  const closed = floor.length >= 3;
  const lengths = closed ? floor.map((p, i) => dist(p, floor[(i + 1) % floor.length])) : [];
  const badH = (refPts.length === 4 && !H) || floor.some((p) => !isFinite(p.x) || !isFinite(p.y) || Math.abs(p.x) > 100 || Math.abs(p.y) > 100);
  const tapeM = parseFloat(tapeCm) / 100;
  const computed = lengths[tapeWall] ?? 0;
  const scale = tapeM > 0 && computed > 0 ? tapeM / computed : 1;
  const errCm = tapeM > 0 && computed ? (computed - tapeM) * 100 : null;

  const norm = (e: React.PointerEvent): Vec2 => {
    const r = imgRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const place = (p: Vec2) => {
    const tp: TapPoint = { ...p, method: 'tap' };
    if (step === 'ref') setRefPts((a) => (a.length < 4 ? [...a, tp] : a));
    else setRoomPts((a) => [...a, tp]);
  };
  const viaGemini = (i: number) => roomPts[i]?.method === 'gemini' || roomPts[(i + 1) % roomPts.length]?.method === 'gemini';

  const hit = (p: Vec2): { ref: boolean; i: number } | null => {
    const r = imgRef.current?.getBoundingClientRect();
    if (!r) return null;
    const list = step === 'ref' ? refPts : roomPts;
    const i = list.findIndex((q) => Math.hypot((q.x - p.x) * r.width, (q.y - p.y) * r.height) < 22);
    return i < 0 ? null : { ref: step === 'ref', i };
  };
  const move = (d: { ref: boolean; i: number }, p: Vec2) => {
    const upd = (a: TapPoint[]) => a.map((q, j) => (j === d.i ? { ...p, method: 'tap' as const } : q));
    if (d.ref) setRefPts(upd); else setRoomPts(upd);
  };

  const finish = () => {
    if (!closed || badH) return;
    const poly = floor.map((p) => ({ x: p.x * scale, y: p.y * scale }));
    const evId = uid('ev');
    const evidence: Evidence[] = [];
    const measurements: Measurement[] = [];
    const walls: WallMeta[] = poly.map((_, i) => {
      const a = roomPts[i], b = roomPts[(i + 1) % roomPts.length];
      const bbox: [number, number, number, number] = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x) || 0.01, Math.abs(a.y - b.y) || 0.01];
      const wev = `${evId}_${i}`;
      const via = viaGemini(i) ? 'a Gemini guess you confirmed' : 'your taps';
      const ref = refKind === 'a4' ? 'an A4 sheet' : `a ${cw} x ${ch} cm rectangle`;
      evidence.push({ id: wev, kind: 'photo', label: `${label}, wall ${i + 1}`, imageUrl, bbox, note: `Floor corners from ${via}. Scale from ${ref} on the floor.`, createdAt: Date.now() });
      if (hidden.has(i)) return { thicknessM, sourceKind: 'photo-inferred', status: 'unknown' };
      const measured = scale !== 1 && i === tapeWall;
      const l = dist(poly[i], poly[(i + 1) % poly.length]);
      measurements.push({
        id: uid('ms'), label: `Wall ${i + 1}`, valueM: measured ? tapeM : l,
        sourceKind: measured ? 'user-measured' : 'photo-inferred', status: measured ? 'verified' : 'estimated',
        toleranceM: measured ? 0.01 : Math.max(0.03, errCm != null ? Math.abs(errCm) / 100 : l * 0.05),
        evidenceIds: [wev], targetId: `#${i}`,
      });
      return measured ? { thicknessM, sourceKind: 'user-measured', status: 'verified' } : { thicknessM, sourceKind: 'photo-inferred', status: 'estimated' };
    });
    const openings: RoomDraft['openings'] = [];
    for (const o of aiOpenings) {
      let best = -1, bd = Infinity, bt = 0;
      roomPts.forEach((a, i) => {
        const c = closestPointOnSegment(o, a, roomPts[(i + 1) % roomPts.length]);
        const d = dist(o, c.point);
        if (d < bd) { bd = d; best = i; bt = c.t; }
      });
      if (best < 0 || hidden.has(best)) continue;
      const len = dist(poly[best], poly[(best + 1) % poly.length]);
      const w = Math.min(o.kind === 'door' ? 0.8 : 1.2, len * 0.8);
      const off = Math.min(len - w / 2, Math.max(w / 2, bt * len));
      openings.push({ id: uid(o.kind), kind: o.kind, wallIndex: best, offsetM: off, widthM: w, heightM: o.kind === 'door' ? 2 : 1.2, sillM: o.kind === 'door' ? 0 : 0.9, swing: o.kind === 'door' ? 'in' : 'none', hinge: 'start', sourceKind: 'photo-inferred', status: 'estimated' });
    }
    onDone({ polygon: poly, walls, openings, measurements, evidence }, { errCm });
  };

  const dots = [...refPts.map((p) => ({ ...p, ref: true })), ...roomPts.map((p) => ({ ...p, ref: false }))];

  const aiCount = [...roomPts, ...refPts].filter((p) => p.method === 'gemini').length;
  const stepNo = sub === 'ref' ? 1 : sub === 'room' ? 2 : 3;
  const hint = sub === 'ref'
    ? refPts.length < 4 ? `Tap the ${REF_NAMES[refPts.length]} corner of the ${refKind === 'a4' ? 'A4 sheet' : 'rectangle'}.` : 'Reference done. Drag a dot to fix it, or press Next.'
    : sub === 'room' ? 'Tap where the floor meets the walls, going around the room.' : 'Check the walls. Type one tape measurement for best accuracy.';
  const nav = sub === 'ref' ? { onBack, onNext: () => setSub('room'), nextOk: refPts.length === 4 && !badH }
    : sub === 'room' ? { onBack: () => setSub('ref'), onNext: () => setSub('check'), nextOk: closed && !badH }
      : { onBack: () => setSub('room'), onNext: finish, nextOk: closed && !badH, nextLabel: 'Create room' };

  return (
    <div className="capture-cal">
      <Stepper step={stepNo} hint={hint} {...nav}>
        {sub === 'ref' && refPts.length === 0 && <HintA4 />}
        {sub === 'room' && roomPts.length === 0 && <HintCorners />}
      </Stepper>
      {aiSlot}
      {aiCount > 0 && sub !== 'check' && <p className="chip chip-ai capture-msg">{aiCount} AI guess{aiCount === 1 ? '' : 'es'} in purple. Drag to fix.</p>}
      {sub === 'ref' && (
        <div className="row capture-wrap">
          <select value={refKind} onChange={(e) => setRefKind(e.target.value as 'a4' | 'custom')} aria-label="Reference">
            <option value="a4">A4 sheet on the floor</option>
            <option value="custom">Other rectangle (cm)</option>
          </select>
          {refKind === 'custom' && <><input className="capture-num" type="number" aria-label="Width cm" value={cw} onChange={(e) => setCw(+e.target.value)} /> x <input className="capture-num" type="number" aria-label="Height cm" value={ch} onChange={(e) => setCh(+e.target.value)} /></>}
          {refKind === 'a4' && refPts.length === 0 && <span className="muted">Short side along the top.</span>}
        </div>
      )}
      {sub === 'room' && <p className="muted">Only points on the floor measure correctly.</p>}
      <div className="capture-imgbox"
        onPointerDown={(e) => { if (sub === 'check') return; (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const p = norm(e); setDrag(hit(p)); setLoupe(p); }}
        onPointerMove={(e) => { if (!loupe) return; const p = norm(e); setLoupe(p); if (drag) move(drag, p); }}
        onPointerUp={(e) => { if (loupe && !drag) place(norm(e)); setLoupe(null); setDrag(null); }}
        onPointerCancel={() => { setLoupe(null); setDrag(null); }}>
        <img ref={imgRef} src={imageUrl} alt={label} draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none">
          {refPts.length > 1 && <polygon points={refPts.map((p) => `${p.x},${p.y}`).join(' ')} className="capture-refpoly" />}
          {roomPts.length > 1 && <polygon points={roomPts.map((p) => `${p.x},${p.y}`).join(' ')} className="capture-roompoly" />}
        </svg>
        {dots.map((p, i) => <span key={i} className={`capture-dot ${p.method === 'gemini' ? 'is-ai' : p.ref ? 'is-ref' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} title={p.method === 'gemini' ? 'AI guess, drag to fix' : undefined} />)}
        {aiOpenings.map((o, i) => <span key={`o${i}`} className="capture-ai-open" style={{ left: `${o.x * 100}%`, top: `${o.y * 100}%` }}>{o.kind === 'door' ? 'Door' : 'Window'} (AI)</span>)}
        {loupe && <div className="capture-loupe" style={{ left: `${loupe.x * 100}%`, top: `${loupe.y * 100}%`, backgroundImage: `url(${imageUrl})`, backgroundPosition: `${loupe.x * 100}% ${loupe.y * 100}%` }} />}
      </div>
      <div className="row capture-wrap">
        <button className="btn btn-sm" disabled={!dots.length || sub === 'check'} onClick={() => (roomPts.length ? setRoomPts((a) => a.slice(0, -1)) : setRefPts((a) => a.slice(0, -1)))}>Undo point</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setRefPts(initialRef ?? []); setRoomPts(initialRoom ?? []); setSub('ref'); }}>Start over</button>
        <span className="muted capture-legend"><i className="capture-dot is-ref" /> reference <i className="capture-dot" /> your tap <i className="capture-dot is-ai" /> AI guess</span>
      </div>
      {badH && <p className="chip chip-bad">These reference taps don't give a usable floor. Start over.</p>}
      {sub === 'check' && closed && !badH && (
        <div className="card">
          <div className="list">
            {lengths.map((l, i) => (
              <label key={i} className="row capture-wall">
                <span>Wall {i + 1}</span>
                <b className="capture-mono">{Math.round(l * scale * 100)} cm</b>
                <span className="muted">{viaGemini(i) ? 'AI + you' : 'taps'}</span>
                <span className="capture-check"><input type="checkbox" checked={hidden.has(i)} onChange={() => setHidden((s) => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n; })} /> not visible</span>
              </label>
            ))}
          </div>
          <div className="field">
            <span>Check one wall with a tape (cm)</span>
            <div className="row">
              <select value={tapeWall} onChange={(e) => setTapeWall(+e.target.value)}>{lengths.map((_, i) => <option key={i} value={i}>Wall {i + 1}</option>)}</select>
              <input className="capture-num" type="number" inputMode="decimal" placeholder="cm" value={tapeCm} onChange={(e) => setTapeCm(e.target.value)} />
            </div>
          </div>
          {errCm != null
            ? <p className={`chip ${Math.abs(errCm) < 5 ? 'chip-ok' : 'chip-warn'}`}>Photo said {Math.round(computed * 100)} cm, off by {errCm.toFixed(1)} cm ({((errCm / (tapeM * 100)) * 100).toFixed(1)}%). Walls rescaled to your tape.</p>
            : <p className="muted">Without a tape check, lengths depend on how well the reference was tapped.</p>}
        </div>
      )}
    </div>
  );
}
