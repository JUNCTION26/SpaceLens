import { useMemo } from 'react';
import { useStore } from '../../core/store';
import type { FurnitureItem, LayoutCandidate, Relation, RuleVerdict, SpaceModel } from '../../core/types';
import { Icon } from '../../ui/icons';
import { describeFix, type Fix } from './critic';
import type { FullReport } from './pipeline';
import { describePlacement, wallInfo } from './planner';
import './design.css';

/** Plain words for a relation target. */
function targetName(t: string | undefined, names: Map<string, string>, walls: ReturnType<typeof wallInfo>): string {
  if (!t) return '';
  if (t.startsWith('wall:')) return `the ${walls[Number(t.slice(5))]?.name ?? 'nearest'} wall`;
  if (t === 'room-centre') return 'the room centre';
  if (t === 'window' || t === 'door') return `the ${t}`;
  return names.get(t) ?? 'another item';
}

/** What would usually fix a weak rule, by its name. */
export function fixHint(v: RuleVerdict): string {
  const n = `${v.ruleId} ${v.name}`.toLowerCase();
  if (/walk|route|path|aisle|circulation/.test(n)) return 'Clear the route or drop an optional item.';
  if (/door|swing|entr/.test(n)) return 'Clear the door swing.';
  if (/window|daylight|light/.test(n)) return 'Move tall pieces off the window wall.';
  if (/clearance|access|pull|front|use/.test(n)) return 'More free floor in front.';
  if (/wall|back/.test(n)) return 'Back it onto a wall.';
  if (/pair|group|seat|chair|night/.test(n)) return 'Keep it beside its pair.';
  if (/budget|cost|price/.test(n)) return 'Swap for cheaper or drop an optional item.';
  if (/face|view|screen|orient/.test(n)) return 'Turn it to face its target.';
  return v.severity === 'hard' ? 'Must be fixed.' : '';
}

function ItemRow({ f, model, relations, verdicts, verdict, names, walls, fixes }: {
  f: FurnitureItem; model: SpaceModel; relations: Relation[]; verdicts: RuleVerdict[];
  verdict?: { verdict: 'keep' | 'change'; reason: string }; names: Map<string, string>; walls: ReturnType<typeof wallInfo>; fixes: string[];
}) {
  const selected = useStore((s) => s.selection?.kind === 'furniture' && s.selection.id === f.id);
  return (
    <li className={`dec-item${selected ? ' on' : ''}`}>
      <button className="dec-item-head" aria-pressed={selected} onClick={() => useStore.getState().select({ kind: 'furniture', id: f.id })}>
        <span className="dec-swatch" style={{ background: f.color }} aria-hidden="true" />
        <span className="dec-item-name">{f.name}</span>
        {verdict && <span className={`dec-verdict is-${verdict.verdict}`}>{verdict.verdict === 'keep' ? 'Keep' : 'Change'}</span>}
      </button>
      <div className="dec-where muted">{describePlacement(model, f, walls)}</div>
      <ul className="dec-reasons">
        {relations.map((r, i) => (
          <li key={`r${i}`}>
            <span className="dec-kind">{r.kind.replace(/-/g, ' ')}{r.target ? ` ${targetName(r.target, names, walls)}` : ''}</span> {r.reason}
          </li>
        ))}
        {verdicts.map((v) => (
          <li key={v.ruleId} className={v.pass ? 'is-pass' : 'is-fail'}>
            <Icon name={v.pass ? 'check' : 'alert'} size={11} /> <span className="dec-kind">{v.name}</span> {v.message}
          </li>
        ))}
        {verdict && <li className="dec-critic"><span className="dec-kind">Second opinion</span> {verdict.reason}</li>}
        {fixes.map((x) => <li key={x} className="dec-critic"><span className="dec-kind">Fix</span> {x}</li>)}
      </ul>
    </li>
  );
}

/** "Why this layout": every placement with its reasons, measured rule results and the critic's verdict. */
export function DecisionsPanel({ model, candidate, report }: { model: SpaceModel; candidate: LayoutCandidate; report: FullReport }) {
  const walls = useMemo(() => wallInfo(model), [model]);
  const names = useMemo(() => new Map(candidate.furniture.map((f) => [f.id, f.name])), [candidate]);
  const name = (id: string) => names.get(id) ?? 'item';
  const weak = report.verdicts.filter((v) => !v.pass || v.score < 0.6).sort((a, b) => a.score - b.score);
  const passed = report.verdicts.filter((v) => v.pass).length;
  const fixesFor = (id: string) => (report.critique?.ops ?? []).filter((o: Fix) => (o.op === 'add' ? o.relation.subject : o.subject) === id).map((o) => describeFix(o, name, model));
  const order = [...candidate.furniture].sort((a, b) => (b.id === report.program.focalItemId ? 1 : 0) - (a.id === report.program.focalItemId ? 1 : 0));

  return (
    <details className="dec" open onClick={(e) => e.stopPropagation()}>
      <summary>Why this layout</summary>
      <div className="dec-body">
        {(report.idea || report.critique?.summary) && (
          <p className="dec-lede">
            {report.idea}
            {report.critique?.summary && <span className="muted"> {report.critique.summary}</span>}
          </p>
        )}
        <div className="dec-stats muted">
          <span>Rules {passed}/{report.verdicts.length}</span>
          {report.critique && <span>Second opinion {report.critique.score.toFixed(1)}/10 · {report.critique.by}</span>}
          {report.program.by === 'gemini' && report.program.model && <span>Plan · {report.program.model}</span>}
          {report.revised && <span>Revised after review</span>}
        </div>

        {weak.length > 0 && (
          <section>
            <h4 className="dec-h">Needs attention</h4>
            <ul className="dec-weak">
              {weak.map((v) => (
                <li key={v.ruleId} className={v.pass ? '' : `is-${v.severity}`}>
                  <div><strong>{v.name}</strong> <span className="muted">{v.message}</span></div>
                  {fixHint(v) && <div className="dec-fix">{fixHint(v)}</div>}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h4 className="dec-h">Each piece</h4>
          <ul className="dec-items">
            {order.map((f) => (
              <ItemRow key={f.id} f={f} model={model} names={names} walls={walls}
                relations={report.program.relations.filter((r) => r.subject === f.id).sort((a, b) => b.weight - a.weight)}
                verdicts={report.verdicts.filter((v) => v.itemIds.includes(f.id))}
                verdict={report.critique?.decisions.find((d) => d.itemId === f.id)}
                fixes={fixesFor(f.id)} />
            ))}
          </ul>
        </section>

        {report.program.notes.filter((n) => !n.startsWith('Planner unavailable')).length > 0 && (
          <ul className="dec-notes muted">{report.program.notes.filter((n) => !n.startsWith('Planner unavailable')).map((n) => <li key={n}>{n}</li>)}</ul>
        )}
      </div>
    </details>
  );
}
