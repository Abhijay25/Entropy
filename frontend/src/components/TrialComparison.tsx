import type { RunSnapshot, TrialTelemetry } from '@entropy/shared';

interface Props { snapshot?: RunSnapshot; pair: 'original' | 'reproduction'; onPairChange: (pair: 'original' | 'reproduction') => void; }
const labels: Record<string, string> = { baseline: 'Baseline', control: 'Control', chaos: 'Chaos', 'reproduction-control': 'Reproduction control', 'reproduction-chaos': 'Reproduction chaos' };
const measured = (value: number | null | undefined, suffix = '') => value == null ? 'not measured' : `${value}${suffix}`;
function trialFor(trials: readonly TrialTelemetry[], kind: string) { return trials.find((trial) => trial.kind === kind); }
function Metric({ trial, row }: { trial?: TrialTelemetry; row: 'errors' | 'p95' | 'samples' | 'skipped' | 'queue' }) {
  if (!trial) return <>not measured</>;
  const payment = trial.metrics.find((metric) => metric.serviceId === 'payment-service' && metric.channel === 'business');
  if (row === 'errors') return <>{measured(trial.clientSummary.checkoutErrorRate == null ? null : trial.clientSummary.checkoutErrorRate * 100, '%')} <small>({trial.clientSummary.checkoutErrors} / {trial.clientSummary.checkoutCompleted})</small></>;
  if (row === 'p95') return <>{measured(trial.clientSummary.checkoutP95Ms, 'ms')} <small>includes failures</small></>;
  if (row === 'samples') return <>{payment?.sampleCount ?? 'not measured'}{payment?.smallSample ? ' - small sample' : ''}</>;
  if (row === 'skipped') return <>{trial.clientSummary.skipped}</>;
  return <>{payment ? `slots ${measured(payment.activeSlotsPeak)} · queue ${measured(payment.queueLengthPeak)} · queued ${measured(payment.requestsQueued)} · rejected ${measured(payment.queueRejected)} · saturated ${measured(payment.longestSaturatedIntervalMs, 'ms')}` : 'not measured'}</>;
}
function TrialCard({ trial }: { trial?: TrialTelemetry }) {
  if (!trial) return <article className="trial-card muted">not measured</article>;
  return <article className="trial-card"><strong>{labels[trial.kind] ?? trial.kind}</strong><span className={`status-text ${trial.validity}`}>● {trial.status}</span><small>ID: {trial.id}</small><small>{trial.startedAt ?? 'not started'} → {trial.finishedAt ?? 'in progress'}</small><small>Sandbox: {trial.sandboxId ?? 'not created'}</small><small>Runtime: {trial.runtimeIdentity}</small><small>{trial.executionMode} · validity {trial.validity} · cleanup {trial.cleanupStatus}</small>{trial.error && <small className="error-message">{trial.error.code}: {trial.error.message}</small>}{trial.warnings.map((warning) => <small className="warning" key={warning}>{warning}</small>)}</article>;
}
export function TrialComparison({ snapshot, pair, onPairChange }: Props) {
  if (!snapshot) return <section className="panel comparison"><p className="eyebrow">Trials</p><h2>Matched measurement comparison</h2><p className="muted">Select a saved run to compare measurements.</p></section>;
  const reproductionAvailable = snapshot.trials.some((trial) => trial.kind.startsWith('reproduction-'));
  const control = trialFor(snapshot.trials, pair === 'original' ? 'control' : 'reproduction-control');
  const chaos = trialFor(snapshot.trials, pair === 'original' ? 'chaos' : 'reproduction-chaos');
  const baseline = trialFor(snapshot.trials, 'baseline');
  const classification = snapshot.reproduction?.classification;
  return <section className="panel comparison"><div className="panel-heading"><div><p className="eyebrow">Trials</p><h2>Matched measurement comparison</h2></div>{reproductionAvailable && <label className="compact-label">Pair <select value={pair} onChange={(event) => onPairChange(event.target.value as 'original' | 'reproduction')}><option value="original">Original</option><option value="reproduction">Reproduction</option></select></label>}</div><div className="trial-cards"><TrialCard trial={baseline}/><TrialCard trial={control}/><TrialCard trial={chaos}/><article className="trial-card"><strong>Cleanup</strong><span>{[baseline, control, chaos].filter(Boolean).map((trial) => trial?.cleanupStatus).join(' · ') || 'not measured'}</span>{pair === 'reproduction' && classification && <small>Classification: {classification}</small>}</article></div><div className="comparison-validity">Comparison: <strong>{snapshot.comparisonValidity}</strong>{snapshot.comparisonValidity !== 'valid' && <span> - no zero-impact conclusion</span>}{snapshot.comparisonReasons.length > 0 && <small>{snapshot.comparisonReasons.join(' · ')}</small>}</div><table><thead><tr><th>Measure</th><th>Control</th><th>Chaos</th></tr></thead><tbody>{(['errors', 'p95', 'samples', 'skipped', 'queue'] as const).map((row) => <tr key={row}><th>{({ errors: 'Checkout error fraction', p95: 'Checkout p95 latency', samples: 'Sample count N', skipped: 'Generator skipped', queue: 'Payment queue pressure' })[row]}</th><td><Metric trial={control} row={row}/></td><td><Metric trial={chaos} row={row}/></td></tr>)}</tbody></table></section>;
}
