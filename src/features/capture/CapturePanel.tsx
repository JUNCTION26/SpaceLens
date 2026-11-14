import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../core/store';
import { dataUrlToInlineData, gemini, hasGemini } from '../../core/gemini';
import { useUi } from '../../ui/uiStore';
import { buildModel, type RoomDraft } from './build';
import { Calibrate, type AiOpening, type TapPoint } from './Calibrate';
import { Stepper } from './Stepper';
import { signedArea } from '../../core/geometry';
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

interface Pt { x: number; y: number }
interface GeminiFloor { corners: Pt[]; a4?: Pt[]; openings?: { kind: string; x: number; y: number }[] }
const PT = { type: 'OBJECT', properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['x', 'y'] };
const inBox = (p: Pt) => p && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

interface Summary { areaM2: number; measured: number; estimated: number; errCm: number | null; openings: number }

function SummaryCard({ s, onDesign, onAgain }: { s: Summary; onDesign: () => void; onAgain: () => void }) {
  return (
    <div className="card capture-summary">
      <Stepper step={4} hint="Room created. Check the numbers, then start designing." />
      <div className="capture-stats">
        <div><b>{s.areaM2.toFixed(1)} m²</b><span>Floor area</span></div>
        <div><b>{s.measured}</b><span>Walls measured</span></div>
        <div><b>{s.estimated}</b><span>Walls estimated</span></div>
        <div><b>{s.errCm == null ? 'n/a' : `${Math.abs(s.errCm).toFixed(1)} cm`}</b><span>Tape check error</span></div>
      </div>
      {s.openings > 0 && <p className="muted">{s.openings} door or window{s.openings === 1 ? '' : 's'} added.</p>}
      <button className="btn btn-primary capture-big" onClick={onDesign}>Design this room</button>
      <button className="btn btn-ghost" onClick={onAgain}>Capture another</button>
    </div>
  );
}

export function CapturePanel() {
  const kind = useUi((s) => s.captureKind);
  const [sub, setSub] = useState<Sub>(kind === 'scan' ? 'scan' : kind === 'photos' ? 'photos' : 'draw');
  const [ceilingCm, setCeilingCm] = useState(250);
  const [addRoom, setAddRoom] = useState(false);
  const [shots, setShots] = useState<Shot[]>([]);
  const [pick, setPick] = useState(-1);
  const [stage, setStage] = useState<'photo' | 'cal'>('photo');
  const [ai, setAi] = useState<{ key: number; room: TapPoint[]; ref?: TapPoint[]; openings: AiOpening[] } | null>(null);
  const [aiNote, setAiNote] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [calKey, setCalKey] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null);
  const { dispatch, toast, setMode, model, settings } = useStore();
  const hasRooms = model.sourceLabel !== 'Sample' && model.spaces.length > 0;

  useEffect(() => { if (kind === 'scan' || kind === 'photos' || kind === 'draw') setSub(kind); }, [kind]);

  const create = (draft: RoomDraft, source: string, errCm: number | null = null) => {
    const keep = addRoom && hasRooms ? model : undefined;
    const next = buildModel([draft], { name: 'My room', ceilingM: ceilingCm / 100, sourceLabel: source, keep });
    dispatch({ type: 'REPLACE_MODEL', model: next });
    toast(keep ? 'Room added. Join rooms by placing a doorway by hand.' : 'Room created', 'ok');
    const measured = draft.walls.filter((w) => w.status === 'verified').length;
    setSummary({ areaM2: Math.abs(signedArea(draft.polygon)), measured, estimated: draft.walls.length - measured, errCm, openings: draft.openings.length });
  };

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const add = await Promise.all([...files].filter((f) => f.type.startsWith('image/')).map(async (f) => ({ url: await fileToDataUrl(f), label: f.name })));
    setShots((s) => { if (pick < 0) setPick(s.length); return [...s, ...add]; });
  };

  const choose = (i: number) => { setPick(i); setAi(null); setAiNote(null); setCalKey((k) => k + 1); };

  const askGemini = async () => {
    const shot = shots[pick];
    if (!shot) return;
    setAiBusy(true);
    const t0 = performance.now();
    try {
      const r = await gemini<GeminiFloor>([dataUrlToInlineData(shot.url), { text: 'Room photo. Return as x,y normalised 0..1 of image width and height: (1) corners where the floor meets the walls, in order around the room, only visible ones; (2) if an A4 sheet of paper lies on the floor, its 4 corners in order top left, top right, bottom right, bottom left, else an empty list; (3) doors and windows, each with kind "door" or "window" and the point where its centre meets the floor line.' }], {
        json: true,
        schema: { type: 'OBJECT', properties: { corners: { type: 'ARRAY', items: PT }, a4: { type: 'ARRAY', items: PT }, openings: { type: 'ARRAY', items: { type: 'OBJECT', properties: { kind: { type: 'STRING', enum: ['door', 'window'] }, x: { type: 'NUMBER' }, y: { type: 'NUMBER' } }, required: ['kind', 'x', 'y'] } } }, required: ['corners'] },
      });
      const ms = Math.round(performance.now() - t0);
      const room = (r.corners ?? []).filter(inBox).map((p) => ({ x: p.x, y: p.y, method: 'gemini' as const }));
      const a4 = (r.a4 ?? []).filter(inBox);
      const ref = a4.length === 4 ? a4.map((p) => ({ x: p.x, y: p.y, method: 'gemini' as const })) : undefined;
      const openings = (r.openings ?? []).filter((o) => inBox(o) && (o.kind === 'door' || o.kind === 'window')).map((o) => ({ kind: o.kind as 'door' | 'window', x: o.x, y: o.y }));
      const k = calKey + 1;
      setCalKey(k); setAi({ key: k, room, ref, openings });
      setAiNote(`${settings.geminiModel}, ${(ms / 1000).toFixed(1)} s: ${room.length} corners${ref ? ', A4 sheet' : ''}, ${openings.length} doors or windows.`);
      setStage('cal');
    } catch (e) {
      toast(`Auto-detect failed: ${e instanceof Error ? e.message : 'unknown error'}`, 'error');
    } finally { setAiBusy(false); }
  };

  const shot = shots[pick];
  const restart = () => { setSummary(null); setStage('photo'); setCalKey((k) => k + 1); };
  const aiBox = sub !== 'draw' && shot && (
    <div className="row capture-wrap">
      {hasGemini()
        ? <button className="btn btn-sm" disabled={aiBusy} onClick={askGemini}>{aiBusy ? 'Detecting...' : 'Auto-detect'}</button>
        : <span className="muted capture-small">Add a Gemini key in Settings for auto-detect.</span>}
      {aiNote && <span className="chip chip-ai">{aiNote}</span>}
    </div>
  );

  if (summary) return <div className="panel capture"><SummaryCard s={summary} onDesign={() => setMode('design')} onAgain={restart} /></div>;

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

      {sub !== 'draw' && (stage === 'photo' || !shot) && (
        <Stepper step={0} hint="Add a photo that shows the floor and an A4 sheet lying flat on it."
          onNext={() => setStage('cal')} nextOk={!!shot}>
          {sub === 'scan' && <ScanMode shots={shots} setShots={(f) => setShots((s) => { const n = f(s); if (pick < 0 && n.length) setPick(0); return n; })} />}
          {sub === 'photos' && (
            <label className="btn capture-big capture-upload">
              Add photos
              <input type="file" accept="image/*" multiple capture="environment" onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }} />
            </label>
          )}
          {shots.length > 0 && <ShotPicker shots={shots} pick={pick} onPick={choose} />}
          {aiBox}
        </Stepper>
      )}

      {sub !== 'draw' && stage === 'cal' && shot && (
        <>
          <Calibrate key={`${pick}-${calKey}`} imageUrl={shot.url} label={shot.label} thicknessM={0.12}
            initialRoom={ai?.key === calKey ? ai.room : undefined}
            initialRef={ai?.key === calKey ? ai.ref : undefined}
            aiOpenings={ai?.key === calKey ? ai.openings : undefined}
            aiSlot={aiBox}
            onBack={() => setStage('photo')}
            onDone={(d, info) => create(d, sub === 'scan' ? 'Phone scan' : 'Photos', info.errCm)} />
          <label className="field capture-field"><span>Ceiling (cm, not measured from photo)</span><input type="number" value={ceilingCm} onChange={(e) => setCeilingCm(+e.target.value)} /></label>
        </>
      )}
    </div>
  );
}
