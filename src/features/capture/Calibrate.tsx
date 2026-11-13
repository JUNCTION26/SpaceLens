import { useMemo, useRef, useState } from 'react';
import { dist, uid } from '../../core/geometry';
import type { Evidence, Measurement, Vec2, WallMeta } from '../../core/types';
import { applyH, homography } from './homography';
import type { RoomDraft } from './build';

export type Method = 'tap' | 'gemini';
export interface TapPoint { x: number; y: number; method: Method }

interface Props {
  imageUrl: string;
  label: string;
  initialRoom?: TapPoint[];
  thicknessM: number;
  onDone: (draft: RoomDraft) => void;
}

const REF_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];

/** Floor-plane calibration: tap a known rectangle, then the room's floor corners, then confirm with a tape. */
export function Calibrate({ imageUrl, label, initialRoom, thicknessM, onDone }: Props) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [nat, setNat] = useState({ w: 1, h: 1 });
  const [refPts, setRefPts] = useState<TapPoint[]>([]);
  const [roomPts, setRoomPts] = useState<TapPoint[]>(initialRoom ?? []);
  const [refKind, setRefKind] = useState<'a4' | 'custom'>('a4');
  const [cw, setCw] = useState(100);
  const [ch, setCh] = useState(100);
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [tapeWall, setTapeWall] = useState(0);
  const [tapeCm, setTapeCm] = useState('');
  const [loupe, setLoupe] = useState<Vec2 | null>(null);

  const step: 'ref' | 'room' = refPts.length < 4 ? 'ref' : 'room';
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
    if (step === 'ref') setRefPts((a) => [...a, tp]);
    else setRoomPts((a) => [...a, tp]);
  };
  const viaGemini = (i: number) => roomPts[i]?.method === 'gemini' || roomPts[(i + 1) % roomPts.length]?.method === 'gemini';

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
    onDone({ polygon: poly, walls, openings: [], measurements, evidence });
  };

  const dots = [...refPts.map((p) => ({ ...p, ref: true })), ...roomPts.map((p) => ({ ...p, ref: false }))];

  return (
    <div className="capture-cal">
      <div className="row capture-wrap">
        <span className={`chip ${step === 'ref' ? 'chip-warn' : 'chip-ok'}`}>1. Reference {Math.min(4, refPts.length)}/4</span>
        <span className={`chip ${step === 'room' ? (closed ? 'chip-ok' : 'chip-warn') : ''}`}>2. Floor corners {roomPts.length}</span>
      </div>
      {step === 'ref' ? (
        <div className="row capture-wrap">
          <select value={refKind} onChange={(e) => setRefKind(e.target.value as 'a4' | 'custom')}>
            <option value="a4">A4 sheet on the floor</option>
            <option value="custom">Other rectangle (cm)</option>
          </select>
          {refKind === 'custom' && <><input className="capture-num" type="number" value={cw} onChange={(e) => setCw(+e.target.value)} /> x <input className="capture-num" type="number" value={ch} onChange={(e) => setCh(+e.target.value)} /></>}
          <span className="muted">Tap its {REF_NAMES[refPts.length]} corner{refKind === 'a4' && refPts.length === 0 ? ' (short side along the top)' : ''}.</span>
        </div>
      ) : (
        <p className="muted">Tap the floor corners of the room in order, going around. Only points on the floor measure correctly.</p>
      )}
      <div className="capture-imgbox"
        onPointerDown={(e) => { (e.currentTarget as Element).setPointerCapture?.(e.pointerId); setLoupe(norm(e)); }}
        onPointerMove={(e) => { if (loupe) setLoupe(norm(e)); }}
        onPointerUp={(e) => { if (loupe) place(norm(e)); setLoupe(null); }}
        onPointerCancel={() => setLoupe(null)}>
        <img ref={imgRef} src={imageUrl} alt={label} draggable={false} onLoad={(e) => setNat({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none">
          {refPts.length > 1 && <polygon points={refPts.map((p) => `${p.x},${p.y}`).join(' ')} className="capture-refpoly" />}
          {roomPts.length > 1 && <polygon points={roomPts.map((p) => `${p.x},${p.y}`).join(' ')} className="capture-roompoly" />}
        </svg>
        {dots.map((p, i) => <span key={i} className={`capture-dot ${p.ref ? 'is-ref' : p.method === 'gemini' ? 'is-ai' : ''}`} style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }} />)}
        {loupe && <div className="capture-loupe" style={{ left: `${loupe.x * 100}%`, top: `${loupe.y * 100}%`, backgroundImage: `url(${imageUrl})`, backgroundPosition: `${loupe.x * 100}% ${loupe.y * 100}%` }} />}
      </div>
      <div className="row capture-wrap">
        <button className="btn btn-sm" disabled={!dots.length} onClick={() => (roomPts.length ? setRoomPts((a) => a.slice(0, -1)) : setRefPts((a) => a.slice(0, -1)))}>Undo point</button>
        <button className="btn btn-sm btn-ghost" onClick={() => { setRefPts([]); setRoomPts(initialRoom ?? []); }}>Start over</button>
        <span className="muted capture-legend"><i className="capture-dot is-ref" /> reference <i className="capture-dot" /> your tap <i className="capture-dot is-ai" /> Gemini</span>
      </div>
      {badH && <p className="chip chip-bad">These reference taps don't give a usable floor. Start over.</p>}
      {closed && !badH && (
        <div className="card">
          <div className="list">
            {lengths.map((l, i) => (
              <label key={i} className="row capture-wall">
                <span>Wall {i + 1}</span>
                <b className="capture-mono">{Math.round(l * scale * 100)} cm</b>
                <span className="muted">{viaGemini(i) ? 'Gemini + you' : 'taps'}</span>
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
          <button className="btn btn-primary capture-big" onClick={finish}>Create room</button>
        </div>
      )}
    </div>
  );
}
