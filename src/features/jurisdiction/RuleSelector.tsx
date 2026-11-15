import type { CSSProperties } from 'react';
import { PACKS, packFor, type PackId } from './rulepacks';

const cell: CSSProperties = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12 };

/** Country dropdown plus the rules of that country, each with its value and a link to its source. */
export function RuleSelector({ country, onChange }: { country: PackId; onChange: (id: PackId, pack: ReturnType<typeof packFor>) => void }) {
  const pack = PACKS[country] ?? PACKS.generic;
  return (
    <div data-testid="rule-selector">
      <select
        aria-label="Country"
        value={country}
        onChange={(e) => { const id = e.target.value as PackId; onChange(id, PACKS[id]); }}
        style={{ width: '100%', marginBottom: 6 }}
      >
        {(Object.keys(PACKS) as PackId[]).map((id) => <option key={id} value={id}>{PACKS[id].name}</option>)}
      </select>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {pack.rules.map((r) => (
          <li key={r.id} style={cell}>
            <span>{r.title}</span>
            <span style={{ whiteSpace: 'nowrap' }}>
              {r.value} {r.unit}{' '}
              {r.confidence === 'rule-of-thumb' ? null : (
                <a href={r.source.url} target="_blank" rel="noreferrer noopener" title={`${r.source.doc}, ${r.source.section}`} aria-label={`Source: ${r.source.doc}, ${r.source.section}`}>
                  <span aria-hidden="true">{'\u2197'}</span>
                </a>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
