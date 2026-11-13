import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { dataUrlToInlineData, gemini, hasGemini } from '../../core/gemini';
import { useUi } from '../../ui/uiStore';
import { buildModel, type RoomDraft } from './build';
import { Calibrate, type TapPoint } from './Calibrate';
import { DrawRoom } from './DrawRoom';
import './capture.css';

type Sub = 'scan' | 'photos' | 'draw';
interface Shot { url: string; label: string }

function fileToDataUrl(f: File): Promise<string> {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(f); });
}

function ShotPicker({ shots, pick, onPick }: { shots: Shot[]; pick: number; onPick: (i: number) => void }) {
  return (
    <div className="capture-strip">
      {shots.map((s, i) => (
        <button key={i} className={`capture-thumb ${i === pick ? 'is-on' : ''}`} onClick={() => onPick(i)} aria-label={`Use ${s.label}`}>
          <img src={s.url} alt="" />
        </button>
      ))}
    </div>
  );
}

function ScanMode({ shots, setShots }: { shots: Shot[]; setShots: (f: (s: Shot[]) => Shot[]) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const secure = window.isSecureContext && !!navigator.mediaDevices?.getUserMedia;

  const start = async () => {
    setErr(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } }, audio: false });
      streamRef.current = s;
      if (videoRef.current) { videoRef.current.srcObject = s; await videoRef.current.play(); }
      setLive(true);
    } catch (e) {
      setErr(e instanceof Error && e.name === 'NotAllowedError' ? 'Camera access was blocked. Allow it in the browser and try again.' : 'No camera found or it is in use.');
    }
  };
  const stop = () => { streamRef.current?.getTracks().forEach((t) => t.stop()); streamRef.current = null; setLive(false); };
  useEffect(() => stop, []);

  const snap = () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    const k = Math.min(1, 1600 / v.videoWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.85);
    setShots((s) => [...s, { url, label: `Scan frame ${s.length + 1}` }]);
  };

  if (!secure) return <p className="chip chip-warn capture-msg">The camera needs a secure page (https or localhost). Open SpaceLens over https on your phone, or use Photos.</p>;
  return (
    <div className="capture-scan">
      <div className="capture-video">
        <video ref={videoRef} playsInline muted />
        {live ? <div className="capture-guide">Show each corner and doorway. Put an A4 sheet flat on the floor in one shot.</div>
          : <button className="btn btn-primary capture-big" onClick={start}>Start camera</button>}
      </div>
      {err && <p className="chip chip-bad">{err}</p>}
      {live && <div className="row capture-wrap">
        <button className="btn btn-primary capture-big" onClick={snap}>Capture frame</button>
        <button className="btn btn-ghost" onClick={stop}>Stop camera</button>
        <span className="muted">{shots.length} captured</span>
      </div>}
    </div>
  );
}

interface GeminiFloor { corners: { x: number; y: number }[]; doors: number; windows: number }

export function CapturePanel() {
  const kind = useUi((s) => s.captureKind);
  const [sub, setSub] = useState<Sub>(kind === 'scan' ? 'scan' : kind === 'photos' ? 'photos' : 'draw');
  const [ceilingCm, setCeilingCm] = useState(250);
  const [addRoom, setAddRoom] = useState(false);
  const [shots, setShots] = useState<Shot[]>([]);
  const [pick, setPick] = useState(-1);
  const [aiPts, setAiPts] = useState<{ key: number; pts: TapPoint[] } | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [calKey, setCalKey] = useState(0);
  const { dispatch, toast, setMode, setBusy, model } = useStore();
  const hasRooms = model.sourceLabel !== 'Sample' && model.spaces.length > 0;

  useEffect(() => { if (kind === 'scan' || kind === 'photos' || kind === 'draw') setSub(kind); }, [kind]);

  const create = (draft: RoomDraft, source: string) => {
    const keep = addRoom && hasRooms ? model : undefined;
    const next = buildModel([draft], { name: 'My room', ceilingM: ceilingCm / 100, sourceLabel: source, keep });
    dispatch({ type: 'REPLACE_MODEL', model: next });
    toast(keep ? 'Room added. Join rooms by placing a doorway by hand.' : 'Room created', 'ok');
    setMode('design');
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const add = await Promise.all([...files].filter((f) => f.type.startsWith('image/')).map(async (f) => ({ url: await fileToDataUrl(f), label: f.name })));
    setShots((s) => { if (pick < 0) setPick(s.length); return [...s, ...add]; });
  };

  const askGemini = async () => {
    const shot = shots[pick];
    if (!shot) return;
    setBusy('Asking Gemini for floor corners');
    try {
      const r = await gemini<GeminiFloor>([dataUrlToInlineData(shot.url), { text: 'Find the corners where the floor meets the walls in this room photo. Return them in order going around the room, as x,y normalised to 0..1 of image width and height. Only include corners you can see. Also count visible doors and windows.' }], {
        json: true,
        schema: { type: 'OBJECT', properties: { corners: { type: 'ARRAY', items: { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] } }, doors: { type: 'INTEGER' }, windows: { type: 'INTEGER' } }, required: ['corners', 'doors', 'windows'] },
      });
      const pts = (r.corners ?? []).filter((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1).map((p) => ({ x: p.x, y: p.y, method: 'gemini' as const }));
      const k = calKey + 1;
      setCalKey(k); setAiPts({ key: k, pts });
      setAiNote(`Gemini found ${pts.length} floor corners, ${r.doors} doors and ${r.windows} windows. Check each corner. Add doors and windows in Design.`);
    } catch (e) {
      toast(`Gemini failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error');
    } finally { setBusy(null); }
  };

  const shot = shots[pick];
  return (
    <div className="panel capture">
      <div className="capture-seg" role="tablist" aria-label="Capture method">
        {(['scan', 'photos', 'draw'] as Sub[]).map((s) => (
          <button key={s} role="tab" aria-selected={sub === s} className={`btn ${sub === s ? 'btn-primary' : ''}`} onClick={() => setSub(s)}>
            {s === 'scan' ? 'Scan' : s === 'photos' ? 'Photos' : 'Draw'}
          </button>
        ))}
      </div>

      {hasRooms && <label className="row capture-check"><input type="checkbox" checked={addRoom} onChange={(e) => setAddRoom(e.target.checked)} /> Add as another room next to the current ones</label>}

      {sub === 'draw' && <><p className="muted">Most reliable. Type what you measured with a tape.</p><DrawRoom ceilingCm={ceilingCm} setCeilingCm={setCeilingCm} onCreate={(d) => create(d, 'Measured by hand')} /></>}

      {sub === 'scan' && <ScanMode shots={shots} setShots={(f) => setShots((s) => { const n = f(s); if (pick < 0 && n.length) setPick(0); return n; })} />}

      {sub === 'photos' && (
        <label className="btn capture-big capture-upload">
          Add photos
          <input type="file" accept="image/*" multiple capture="environment" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
        </label>
      )}

      {sub !== 'draw' && shots.length > 0 && (
        <>
          <p className="muted">Pick a photo that shows an A4 sheet (or other known rectangle) flat on the floor.</p>
          <ShotPicker shots={shots} pick={pick} onPick={(i) => { setPick(i); setAiPts(null); setAiNote(null); setCalKey((k) => k + 1); }} />
          {sub === 'photos' && hasGemini() && shot && <button className="btn btn-sm" onClick={askGemini}>Ask Gemini for floor corners</button>}
          {aiNote && <p className="chip chip-warn">{aiNote}</p>}
          {shot && (
            <Calibrate key={`${pick}-${calKey}`} imageUrl={shot.url} label={shot.label} thicknessM={0.12}
              initialRoom={aiPts?.key === calKey ? aiPts.pts : undefined}
              onDone={(d) => create(d, sub === 'scan' ? 'Phone scan' : 'Photos')} />
          )}
          {shot && <label className="field capture-field"><span>Ceiling (cm, not measured from photo)</span><input type="number" value={ceilingCm} onChange={(e) => setCeilingCm(+e.target.value)} /></label>}
        </>
      )}
    </div>
  );
}
