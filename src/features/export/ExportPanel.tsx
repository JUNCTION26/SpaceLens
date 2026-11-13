import { useMemo, useRef, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import { fmtSek } from '../../core/geometry';
import { planToSvg } from './svg';
import { scheduleCsv, itemPrice } from './csv';
import { quantities } from './quantities';
import { exportGlb } from './glb';
import { validateModel } from './validate';
import { shareLink } from './share';
import './export.css';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'spacelens';

function download(name: string, data: Blob | string, type = 'text/plain') {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function ExportPanel() {
  const model = useStore((s) => s.model);
  const dispatch = useStore((s) => s.dispatch);
  const toast = useStore((s) => s.toast);
  const furniture = useShownFurniture();
  const svg = useMemo(() => planToSvg(model, furniture), [model, furniture]);
  const q = useMemo(() => quantities(model), [model]);
  const [rates, setRates] = useState({ floor: '', paint: '', skirting: '' });
  const [shared, setShared] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = `${slug(model.name)}-v${model.version}`;
  const ver = <span className="chip">From version {model.version}</span>;

  const printPdf = () => {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print', 'warn'); return; }
    const rows = furniture.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.category)}</td><td>${Math.round(f.w * 100)} × ${Math.round(f.d * 100)} × ${Math.round(f.h * 100)}</td><td>${f.owned ? 'Owned' : fmtSek(itemPrice(f))}</td><td>${f.priceStatus}</td></tr>`).join('');
    const total = furniture.reduce((t, f) => t + itemPrice(f), 0);
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(model.name)} v${model.version}</title><style>
@page{size:A4 landscape;margin:12mm}body{font:12px Arial,sans-serif;color:#111}svg{width:100%;height:auto;max-height:170mm}
table{border-collapse:collapse;width:100%;margin-top:8mm;page-break-before:always}td,th{border:1px solid #999;padding:4px 6px;text-align:left}</style></head>
<body>${svg}<h3>Furniture schedule</h3><table><tr><th>Name</th><th>Category</th><th>W × D × H cm</th><th>Price</th><th>Price status</th></tr>${rows}
<tr><th colspan="3">Total</th><th>${fmtSek(total)}</th><th></th></tr></table><p>Prices are estimates unless marked. From version ${model.version}.</p>
<script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  };

  const glb = async () => {
    try { download(`${base}.glb`, await exportGlb(model, furniture)); } catch { toast('3D export failed', 'error'); }
  };

  const importJson = async (file: File) => {
    try {
      const m = validateModel(JSON.parse(await file.text()));
      dispatch({ type: 'REPLACE_MODEL', model: m });
      toast(`Imported ${m.name}`, 'ok');
    } catch (e) {
      toast(`Import failed: ${e instanceof Error && !(e instanceof SyntaxError) ? e.message : 'not valid JSON.'}`, 'error');
    }
  };

  const share = async () => {
    try {
      const url = await shareLink(model);
      history.replaceState(null, '', url);
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setShared(true);
      toast('Link copied', 'ok');
    } catch { toast('Could not create link', 'error'); }
  };

  const num = (s: string) => (s.trim() === '' ? null : Number(s));
  const qRows: Array<[string, string, number | null]> = [
    ['Floor', `${q.floorM2.toFixed(1)} m²`, num(rates.floor) !== null ? q.floorM2 * num(rates.floor)! : null],
    ['Walls, net', `${q.wallNetM2.toFixed(1)} m²`, null],
    ['Paint, 2 coats', `${q.paintL.toFixed(1)} l`, num(rates.paint) !== null ? q.paintL * num(rates.paint)! : null],
    ['Skirting', `${q.skirtingM.toFixed(1)} m`, num(rates.skirting) !== null ? q.skirtingM * num(rates.skirting)! : null],
  ];
  const anyCost = qRows.some((r) => r[2] !== null);

  return (
    <div className="export">
      <div className="card export-card">
        <div className="export-head"><b>Floor plan</b>{ver}</div>
        <div className="export-preview" dangerouslySetInnerHTML={{ __html: svg }} />
        <div className="row">
          <button className="btn btn-primary btn-sm" onClick={() => download(`${base}.svg`, svg, 'image/svg+xml')}>Download SVG</button>
          <button className="btn btn-sm" onClick={printPdf}>Print PDF</button>
        </div>
      </div>

      <div className="card export-card">
        <div className="export-head"><b>Furniture schedule</b>{ver}</div>
        <p className="muted">{furniture.length} items · {fmtSek(furniture.reduce((t, f) => t + itemPrice(f), 0))}. Prices are estimates unless marked.</p>
        <button className="btn btn-sm" onClick={() => download(`${base}-schedule.csv`, scheduleCsv(furniture), 'text/csv')}>Download CSV</button>
      </div>

      <div className="card export-card">
        <div className="export-head"><b>3D model</b>{ver}</div>
        <p className="muted">GLB for Blender, SketchUp or a viewer.</p>
        <button className="btn btn-sm" onClick={glb}>Download GLB</button>
      </div>

      <div className="card export-card">
        <div className="export-head"><b>Project file</b>{ver}</div>
        <div className="row">
          <button className="btn btn-sm" onClick={() => download(`${base}.json`, JSON.stringify(model, null, 2), 'application/json')}>Download JSON</button>
          <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>Import JSON</button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
        </div>
      </div>

      <div className="card export-card">
        <div className="export-head"><b>Share link</b>{ver}</div>
        <p className="muted">Read-only copy. Photos are not included.</p>
        <button className="btn btn-sm" onClick={share}>{shared ? 'Copy again' : 'Copy link'}</button>
      </div>

      <div className="card export-card">
        <div className="export-head"><b>Renovation quantities</b><span className="chip">Estimate</span>{ver}</div>
        <table className="export-table">
          <tbody>
            {qRows.map(([k, v, cost]) => (
              <tr key={k}><td>{k}</td><td>{v}</td>{anyCost && <td>{cost !== null && Number.isFinite(cost) ? fmtSek(cost) : ''}</td>}</tr>
            ))}
          </tbody>
        </table>
        <div className="export-rates">
          <label className="field">Floor kr/m²<input inputMode="decimal" value={rates.floor} onChange={(e) => setRates({ ...rates, floor: e.target.value })} /></label>
          <label className="field">Paint kr/l<input inputMode="decimal" value={rates.paint} onChange={(e) => setRates({ ...rates, paint: e.target.value })} /></label>
          <label className="field">Skirting kr/m<input inputMode="decimal" value={rates.skirting} onChange={(e) => setRates({ ...rates, skirting: e.target.value })} /></label>
        </div>
      </div>
    </div>
  );
}
