import { useMemo, useRef, useState } from 'react';
import { useShownFurniture, useStore } from '../../core/store';
import { fmtSek } from '../../core/geometry';
import { planToSvg, uncertainWalls, type PlanOptions } from './svg';
import { scheduleCsv, itemPrice } from './csv';
import { quantities } from './quantities';
import { exportGlb } from './glb';
import { validateModel } from './validate';
import { shareLink } from './share';
import { Icon } from '../../ui/icons';
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
  const rows: Array<{ k: string; icon: string; name: string; desc: string; size: string; run: () => void }> = [
    { k: 'svg', icon: 'image', name: 'SVG', desc: 'Dimensioned plan', size: kb(svg.length), run: () => download(`${base}.svg`, svg, 'image/svg+xml') },
    { k: 'csv', icon: 'grid', name: 'CSV', desc: `${furniture.length} items, ${fmtSek(total)}`, size: kb(csv.length), run: () => download(`${base}-schedule.csv`, csv, 'text/csv') },
    { k: 'glb', icon: 'cube', name: '3D model', desc: 'GLB for Blender or SketchUp', size: kb(glbEst), run: () => void glb() },
    { k: 'json', icon: 'file', name: 'Project file', desc: 'Re-importable JSON', size: kb(json.length), run: () => download(`${base}.json`, json, 'application/json') },
    { k: 'link', icon: 'share', name: 'Share link', desc: 'Read-only, no photos', size: '', run: () => void share() },
  ];
  const [more, setMore] = useState(false);
  const toggle = (k: keyof PlanOptions, label: string) => (
    <label className="export-toggle"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} />{label}</label>
  );

  return (
    <div className="export">
      <button className="btn btn-primary export-primary" onClick={printPdf}><Icon name="download" size={14} />Download PDF</button>

      <ul className="export-list">
        {rows.map((r) => (
          <li key={r.k}>
            <button className="export-row" onClick={r.run} title={r.desc}>
              <Icon name={r.icon} size={15} />
              <span className="export-name">{r.k === 'link' && shared ? 'Link copied' : r.name}</span>
              <span className="export-size">{r.size}</span>
            </button>
          </li>
        ))}
        <li>
          <button className="export-row" onClick={() => fileRef.current?.click()}>
            <Icon name="plus" size={15} /><span className="export-name">Import project</span><span className="export-size" />
          </button>
          <input ref={fileRef} type="file" accept=".json,application/json" hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void importJson(f); e.target.value = ''; }} />
        </li>
      </ul>

      <div className="export-preview" dangerouslySetInnerHTML={{ __html: preview }} />

      <button className="export-more" aria-expanded={more} onClick={() => setMore(!more)}>
        <Icon name={more ? 'chevronDown' : 'chevronRight'} size={14} />More
      </button>
      {more && (
        <div className="export-section">
          <div className="export-toggles">
            {toggle('furniture', 'Furniture')}{toggle('dimensions', 'Dimensions')}{toggle('titleBlock', 'Title block')}
          </div>
          <button className="btn btn-sm" onClick={printSheet}>Print room sheet</button>
          <div className="export-label">Quantities (estimate)</div>
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
      )}
    </div>
  );
}
