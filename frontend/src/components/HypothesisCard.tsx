import { useState } from 'react';
import type { ChaosHypothesis, ServiceId } from '@entropy/shared';

interface Props { hypothesis?: ChaosHypothesis; retrievedPaths?: readonly (readonly ServiceId[])[]; cypherParameters?: Readonly<Record<string, string>>; }
export function HypothesisCard({ hypothesis, retrievedPaths, cypherParameters }: Props) {
  const [showQuery, setShowQuery] = useState(false);
  if (!hypothesis) return <section className="panel hypothesis-card"><p className="eyebrow">Hypothesis</p><h2>Awaiting graph retrieval</h2><p className="muted">The experiment will retrieve the fixed graph context before proposing a bounded fault.</p></section>;
  const provenance = hypothesis.source === 'nosana' ? `Nosana${hypothesis.model ? ` · ${hypothesis.model}` : ''}` : `Catalogue fallback${hypothesis.model ? ` · ${hypothesis.model}` : ''}`;
  return <section className="panel hypothesis-card"><div className="panel-heading"><div><p className="eyebrow">Hypothesis</p><h2>{hypothesis.title}</h2></div><span className={`badge ${hypothesis.source}`}>{provenance}</span></div><p>{hypothesis.question}</p><dl className="detail-list"><div><dt>Target fault</dt><dd>redis-cache · 3000ms · {hypothesis.faultParams.durationSec}s</dd></div><div><dt>Predicted path</dt><dd>{hypothesis.predictedBlastRadiusIds.join(' → ')}</dd></div><div><dt>Rationale</dt><dd>{hypothesis.rationale}</dd></div></dl><button className="text-button" onClick={() => setShowQuery((visible) => !visible)} aria-expanded={showQuery}>{showQuery ? 'Hide' : 'Inspect'} fixed Cypher query</button>{showQuery && <><pre className="code-block">{hypothesis.cypherQueryUsed}</pre>{retrievedPaths && <p className="muted">Retrieved paths: {retrievedPaths.map((path) => path.join(' → ')).join(' | ')}</p>}{cypherParameters && <pre className="code-block">{JSON.stringify(cypherParameters, null, 2)}</pre>}</>}</section>;
}
