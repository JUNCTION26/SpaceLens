export const STEPS = ['Photo', 'Reference', 'Corners', 'Check', 'Create'];

/** Five-step progress bar with a one-line instruction and back/next. */
export function Stepper({ step, hint, onBack, onNext, nextLabel = 'Next', nextOk = true, children }: {
  step: number; hint: string; onBack?: () => void; onNext?: () => void; nextLabel?: string; nextOk?: boolean; children?: React.ReactNode;
}) {
  return (
    <div className="capture-stepper">
      <ol className="capture-steps" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
        {STEPS.map((s, i) => (
          <li key={s} className={i < step ? 'is-done' : i === step ? 'is-on' : ''} aria-current={i === step ? 'step' : undefined}>
            <b>{i + 1}</b><span>{s}</span>
          </li>
        ))}
      </ol>
      <div className="capture-progress"><i style={{ width: `${(step / (STEPS.length - 1)) * 100}%` }} /></div>
      <p className="capture-hint">{hint}</p>
      {children}
      {(onBack || onNext) && (
        <div className="row capture-nav">
          {onBack ? <button className="btn" onClick={onBack}>Back</button> : <span />}
          {onNext && <button className="btn btn-primary" disabled={!nextOk} onClick={onNext}>{nextLabel}</button>}
        </div>
      )}
    </div>
  );
}

/** Small illustration: an A4 sheet on the floor with numbered tap order. */
export function HintA4() {
  return (
    <svg className="capture-illus" viewBox="0 0 160 90" role="img" aria-label="Tap the sheet corners: top left, top right, bottom right, bottom left">
      <polygon points="10,80 150,80 120,20 40,20" className="il-floor" />
      <polygon points="62,62 98,62 92,40 68,40" className="il-sheet" />
      {[[68, 40], [92, 40], [98, 62], [62, 62]].map(([x, y], i) => (
        <g key={i}><circle cx={x} cy={y} r="5" className="il-dot" /><text x={x} y={y + 0.5} className="il-num">{i + 1}</text></g>
      ))}
      <path d="M74 36 L86 36 M100 46 L102 56 M88 67 L72 67 M58 56 L62 46" className="il-arrow" markerEnd="url(#ilh)" />
      <defs><marker id="ilh" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L6 3 L0 6 z" className="il-head" /></marker></defs>
    </svg>
  );
}

/** Small illustration: floor corners tapped in order around the room. */
export function HintCorners() {
  const pts = [[30, 70], [50, 22], [112, 22], [132, 70]];
  return (
    <svg className="capture-illus" viewBox="0 0 160 90" role="img" aria-label="Tap where floor meets wall, going around the room">
      <polygon points="30,70 50,22 112,22 132,70" className="il-floor" />
      <path d="M50 22 L50 4 M112 22 L112 4" className="il-wall" />
      {pts.map(([x, y], i) => (
        <g key={i}><circle cx={x} cy={y} r="5" className="il-dot" /><text x={x} y={y + 0.5} className="il-num">{i + 1}</text></g>
      ))}
    </svg>
  );
}
