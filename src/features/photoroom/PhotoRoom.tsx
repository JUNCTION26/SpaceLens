import { useState } from 'react';
import { apiBase } from '../../core/ai/transport';
import { useStore } from '../../core/store';
import type { SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import { useUi } from '../../ui/uiStore';
import { gatherImages } from './frames';
import { forgeUnknowns, MAX_PHOTOS, photoToRoom } from './pipeline';
import { mostVisibleWall, rescaleRoom, WALL_INDEX, WALL_LABEL, type PhotoRoomEstimate, type WallName } from './room';
import './photoroom.css';

const SIDES: WallName[] = ['back', 'left', 'right'];

/** One photo of a room becomes an editable 3D room. */
export function PhotoRoom() {
  const hasKey = useStore((s) => Boolean(s.settings.geminiKey)) || Boolean(apiBase());
  const { dispatch, setView, setMode } = useStore();
  const model = useStore((s) => s.model);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<{ est: PhotoRoomEstimate; photos: string[]; modelId: string } | null>(null);
  const [wall, setWall] = useState<WallName>('back');
  const [cm, setCm] = useState('');

  if (!hasKey) {
    return (
      <div className="proom">
        <button className="btn btn-primary proom-big" onClick={() => useUi.getState().setSettingsOpen(true)}>Add key</button>
      </div>
    );
  }

  const run = async (files: File[]) => {
    setBusy(true); setFailed(false); setResult(null);
    try {
      const r = await photoToRoom(await gatherImages(files, MAX_PHOTOS));
      dispatch({ type: 'REPLACE_MODEL', model: r.model });
      setView('3d');
      setResult({ est: r.estimate, photos: r.photos, modelId: r.model.id });
      setWall(mostVisibleWall(r.estimate.wallConfidence));
      setCm('');
      void forgeUnknowns(r.model);
    } catch {
      setFailed(true);
    } finally { setBusy(false); }
  };

  const live = result && model.id === result.modelId ? model : null;
  const space = live?.spaces[0];
  const len = (m: SpaceModel, w: WallName) => {
    const s = m.spaces[0]; const i = WALL_INDEX[w];
    const a = s.polygon[i], b = s.polygon[(i + 1) % s.polygon.length];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const typed = parseFloat(cm.replace(',', '.'));
  const rescale = () => {
    if (!live || !space || !(typed > 30 && typed < 3000)) return;
    dispatch({ type: 'REPLACE_MODEL', model: rescaleRoom(live, space.id, WALL_INDEX[wall], typed / 100) });
    setCm('');
  };

  return (
    <div className="proom">
      <label className={`btn ${result ? '' : 'btn-primary '}proom-big proom-upload`} aria-busy={busy}>
        {busy ? <span className="proom-spin" aria-label="Working" /> : <><Icon name={result ? 'plus' : 'image'} size={16} />{result ? <span className="sr-only">Photos or video</span> : ' Photos or video'}</>}
        <input type="file" accept="image/*,video/*" multiple disabled={busy} aria-label="Room photos or video" onChange={(e) => { const f = Array.from(e.target.files ?? []); if (f.length) void run(f); e.target.value = ''; }} />
      </label>

      {failed && <span className="chip chip-warn proom-fail"><Icon name="alert" size={12} /> No room found</span>}

      {result && live && space && (
        <>
          <div className="proom-strip">
            {result.photos.map((p, i) => <img key={i} src={p} alt="" />)}
          </div>
          <div className="proom-chips">
            <span className="chip" title="Size">{len(live, 'back').toFixed(1)} x {len(live, 'left').toFixed(1)} m</span>
            <span className="chip" title="Ceiling">{live.ceilingM.toFixed(1)} m <Icon name="maximize" size={12} /></span>
            <span className="chip" title="Items">{live.furniture.length} <Icon name="sofa" size={12} /></span>
            <span className={`chip ${space.walls.some((w) => w.status === 'verified') ? 'chip-ok' : result.est.confidence >= 0.7 ? 'chip-ok' : result.est.confidence >= 0.45 ? 'chip-warn' : 'chip-bad'}`} title="Scale">
              {space.walls.some((w) => w.status === 'verified') ? <Icon name="check" size={12} /> : `${Math.round(result.est.confidence * 100)}%`} <Icon name="ruler" size={12} />
            </span>
          </div>

          <form className="proom-scale" onSubmit={(e) => { e.preventDefault(); rescale(); }}>
            <select value={wall} onChange={(e) => setWall(e.target.value as WallName)} aria-label="Wall">
              {(SIDES.includes(wall) ? SIDES : [...SIDES, wall]).map((w) => <option key={w} value={w}>{WALL_LABEL[w]}</option>)}
            </select>
            <input inputMode="decimal" value={cm} onChange={(e) => setCm(e.target.value)} placeholder={String(Math.round(len(live, wall) * 100))} aria-label="Real length in cm" />
            <span className="muted">cm</span>
            <button className="btn btn-sm" disabled={!(typed > 30 && typed < 3000)} aria-label="Rescale"><Icon name="check" size={14} /></button>
          </form>

          <button className="btn btn-primary proom-big" onClick={() => setMode('design')}>Design</button>
        </>
      )}
    </div>
  );
}

export default PhotoRoom;
