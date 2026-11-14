import { useMemo, useRef, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import { fmtSek } from '../../core/geometry';
import { planToSvg, uncertainWalls, type PlanOptions } from './svg';
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

const kb = (n: number) => (n < 1024 ? `${Math.max(1, Math.round(n))} B` : n < 1048576 ? `~${Math.round(n / 1024)} KB` : `~${(n / 1048576).toFixed(1)} MB`);

const ICONS: Record<string, string> = {
  pdf: 'M6 2h9l5 5v15H6z M15 2v5h5 M9 13h6 M9 17h6',
  svg: 'M4 4h16v16H4z M4 12h16 M12 4v16',
  csv: 'M4 5h16v14H4z M4 10h16 M4 15h16 M10 5v14',
  glb: 'M12 2l9 5v10l-9 5-9-5V7z M12 12l9-5 M12 12v10 M12 12L3 7',
  json: 'M8 4c-2 0-2 2-2 4s-2 4-2 4 2 0 2 4 0 4 2 4 M16 4c2 0 2 2 2 4s2 4 2 4-2 0-2 4 0 4-2 4',
  link: 'M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1 1 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1-1',
};
const Icon = ({ k }: { k: string }) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICONS[k]} /></svg>
);

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function ExportPanel() {
  const model = useStore((s) => s.model);
  const dispatch = useStore((s) => s.dispatch);
  const toast = useStore((s) => s.toast);
  const furniture = useShownFurniture();
  const candidates = useStore((s) => s.candidates);
  const activeId = useStore((s) => s.activeCandidateId);
  const routes = useStore((s) => s.analysis.routes);
  const [layers, setLayers] = useState<Required<PlanOptions>>({ furniture: true, dimensions: true, titleBlock: true });
  const svg = useMemo(() => planToSvg(model, furniture), [model, furniture]);
  const preview = useMemo(() => planToSvg(model, furniture, new Date(), layers), [model, furniture, layers]);
  const checks = candidates.find((c) => c.id === activeId)?.checks ?? [];
  const csv = useMemo(() => scheduleCsv(furniture), [furniture]);
  const json = useMemo(() => JSON.stringify(model, null, 2), [model]);
  const q = useMemo(() => quantities(model), [model]);
  const [rates, setRates] = useState({ floor: '', paint: '', skirting: '' });
  const [shared, setShared] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const base = `${slug(model.name)}-v${model.version}`;

  const openPrint = (title: string, body: string, css: string) => {
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print', 'warn'); return; }
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:12px Helvetica,Arial,sans-serif;color:#111}${css}
td,th{border:1px solid #bbb;padding:3px 6px;text-align:left}table{border-collapse:collapse;width:100%}h3{margin:6mm 0 2mm;font-size:13px}</style></head>
<body>${body}<script>window.onload=function(){window.print()}</script></body></html>`);
    w.document.close();
  };
  const total = furniture.reduce((t, f) => t + itemPrice(f), 0);
  const schedTable = () => `<table><tr><th>Name</th><th>Category</th><th>W × D × H cm</th><th>Price</th><th>Price status</th></tr>${furniture.map((f) => `<tr><td>${esc(f.name)}</td><td>${esc(f.category)}</td><td>${Math.round(f.w * 100)} × ${Math.round(f.d * 100)} × ${Math.round(f.h * 100)}</td><td>${f.owned ? 'Owned' : fmtSek(itemPrice(f))}</td><td>${f.priceStatus}</td></tr>`).join('')}<tr><th colspan="3">Total</th><th>${fmtSek(total)}</th><th></th></tr></table>`;

  const printPdf = () => openPrint(`${model.name} v${model.version}`,
    `${svg}<h3 style="page-break-before:always">Furniture schedule</h3>${schedTable()}<p>Prices are estimates unless marked. From version ${model.version}.</p>`,
    '@page{size:A4 landscape;margin:12mm}svg{width:100%;height:auto;max-height:170mm}');

  const printSheet = () => {
    const pass = checks.filter((c) => c.result === 'pass').length, fail = checks.filter((c) => c.result === 'fail');
    const rOk = routes.filter((r) => r.ok).length;
    const uw = uncertainWalls(model);
    const qt = qRows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    const checkLines = [
      checks.length ? `${pass} of ${checks.length} layout checks pass${fail.length ? `. Failing: ${esc(fail.map((c) => c.rule).join(', '))}` : ''}` : 'No layout checks run yet',
      routes.length ? `${rOk} of ${routes.length} routes clear` : 'No routes checked yet',
      uw.length ? `${uw.length} walls not verified` : 'All walls verified',
    ].map((t) => `<li>${t}</li>`).join('');
    openPrint(`${model.name} room sheet`,
      `<h2 style="margin:0 0 2mm">${esc(model.name)} <small style="font-weight:400;color:#666">Room sheet · v${model.version}</small></h2>${svg}
<div class="cols"><div><h3>Furniture schedule</h3>${schedTable()}</div><div><h3>Quantities</h3><table>${qt}</table><h3>Checks</h3><ul>${checkLines}</ul>
<p style="color:#666">Estimates. Check values marked ? before building.</p></div></div>`,
      '@page{size:A4 portrait;margin:10mm}svg{width:100%;height:auto;max-height:150mm}.cols{display:grid;grid-template-columns:3fr 2fr;gap:6mm;font-size:10px}ul{padding-left:4mm;margin:0}');
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
      setTimeout(() => setShared(false), 4000);
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

  const glbEst = 2000 + furniture.length * 1500 + model.spaces.reduce((t, sp) => t + sp.walls.length * 900, 0);
  const tiles: Array<{ k: string; name: string; desc: string; size: string; run: () => void }> = [
    { k: 'pdf', name: 'PDF', desc: 'Plan and schedule, via print', size: '2 pages', run: printPdf },
    { k: 'svg', name: 'SVG', desc: 'Scalable dimensioned plan', size: kb(svg.length), run: () => download(`${base}.svg`, svg, 'image/svg+xml') },
    { k: 'csv', name: 'CSV', desc: `Schedule, ${furniture.length} items, ${fmtSek(total)}`, size: kb(csv.length), run: () => download(`${base}-schedule.csv`, csv, 'text/csv') },
    { k: 'glb', name: '3D GLB', desc: 'For Blender, SketchUp or a viewer', size: kb(glbEst), run: () => void glb() },
    { k: 'json', name: 'Project file', desc: 'Full model, re-importable', size: kb(json.length), run: () => download(`${base}.json`, json, 'application/json') },
    { k: 'link', name: 'Share link', desc: 'Read-only copy, no photos', size: kb(json.length / 4), run: () => void share() },
  ];
  const toggle = (k: keyof PlanOptions, label: string) => (
    <label className="export-toggle"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{label}</label>
  );

  return (
    <div className="export">
      <div className="card export-card">
        <div className="export-head"><b>Floor plan</b></div>
        <div className="export-preview" dangerouslySetInnerHTML={{ __html: preview }} />
        <div className="row export-toggles">
          {toggle('furniture', 'Furniture')}{toggle('dimensions', 'Dimensions')}{toggle('titleBlock', 'Title block')}
          <button className="btn btn-primary btn-sm" onClick={printSheet}>Print room sheet</button>
        </div>
      </div>

      <div className="export-tiles">
        {tiles.map((t) => (
          <button key={t.k} className="card export-tile" onClick={t.run}>
            <span className="export-icon"><Icon k={t.k} /></span>
            <b>{t.k === 'link' && shared ? 'Link copied' : t.name}</b>
            <span className="muted">{t.desc}</span>
            <span className="export-size">{t.size}</span>
          </button>
        ))}
      </div>
      <div className="row">
        <button className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>Import JSON</button>
        <input ref={fileRef} type="file" accept=".json,application/json" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
      </div>

      <div className="card export-card">
        <div className="export-head"><b>Renovation quantities</b><span className="chip">Estimate</span></div>
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
