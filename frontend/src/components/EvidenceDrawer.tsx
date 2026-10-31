import { useState } from 'react';
import type { RunSnapshot, ServiceMetric, TrialKind } from '@entropy/shared';
import { api } from '../api';

interface Props { snapshot?: RunSnapshot; serviceId?: string; pair: 'original' | 'reproduction'; }
const count = (value: number | undefined) => value ?? 'not measured';
function metricFor(snapshot: RunSnapshot, kind: TrialKind, serviceId: string) { return snapshot.trials.find((trial) => trial.kind === kind)?.metrics.filter((metric) => metric.serviceId === serviceId) ?? []; }
function Metrics({ title, metrics }: { title: string; metrics: readonly ServiceMetric[] }) { return <div className="metric-channel"><strong>{title}</strong>{metrics.length === 0 ? <span className="muted">not measured</span> : metrics.map((metric) => <div key={metric.id}><small>{metric.channel}</small><span>requests {count(metric.requestsCompleted)} / started {count(metric.requestsStarted)} · errors {count(metric.errorsTotal)} / completed {count(metric.requestsCompleted)} · timeouts {count(metric.timeoutsTotal)}</span><span>p95 {metric.latencyP95Ms == null ? 'not measured' : `${metric.latencyP95Ms}ms`}{metric.smallSample ? ' - small sample' : ''}</span><span>slots {count(metric.activeSlotsPeak)} · queue {count(metric.queueLengthPeak)} · queued {count(metric.requestsQueued)} · rejected {count(metric.queueRejected)}</span></div>)}</div>; }
export function EvidenceDrawer({ snapshot, serviceId, pair }: Props) {
  const [artifact, setArtifact] = useState<string>(); const [artifactError, setArtifactError] = useState<string>();
  if (!snapshot || !serviceId) return <aside className="panel drawer"><p className="eyebrow">Evidence</p><h2>Select a service node</h2><p className="muted">Control and chaos evidence is available after measurements are saved.</p></aside>;
  const controlKind: TrialKind = pair === 'original' ? 'control' : 'reproduction-control';
  const chaosKind: TrialKind = pair === 'original' ? 'chaos' : 'reproduction-chaos';
  const control = metricFor(snapshot, controlKind, serviceId); const chaos = metricFor(snapshot, chaosKind, serviceId);
  const trials = snapshot.trials.filter((trial) => (trial.kind === controlKind || trial.kind === chaosKind) && trial.metrics.some((metric) => metric.serviceId === serviceId));
  const spanIds = trials.flatMap((trial) => trial.spans.filter((span) => span.serviceId === serviceId || span.downstreamId === serviceId).map((span) => span.id));
  const artifacts = trials.flatMap((trial) => trial.artifacts);
  const loadArtifact = async (id: string) => { setArtifactError(undefined); try { setArtifact((await api.artifact(id)).content); } catch (error) { setArtifactError(error instanceof Error ? error.message : 'Artifact unavailable'); } };
  return <aside className="panel drawer"><p className="eyebrow">Selected-node evidence - {pair}</p><h2>{serviceId}</h2><div className="evidence-grid"><Metrics title="Control" metrics={control}/><Metrics title="Chaos" metrics={chaos}/></div><h3>Supporting spans</h3><div className="chip-list">{spanIds.length ? spanIds.map((id) => <span className="chip" key={id}>{id}</span>) : <span className="muted">not measured</span>}</div><h3>Bounded artifacts</h3><div className="artifact-list">{artifacts.length ? artifacts.map((item) => <button className="text-button" key={item.id} disabled={!item.available} onClick={() => void loadArtifact(item.id)}>{item.kind} {item.truncated ? '(truncated)' : ''}</button>) : <span className="muted">No registered artifacts</span>}</div>{artifactError && <p className="error-message">{artifactError}</p>}{artifact && <pre className="artifact-content">{artifact}</pre>}<h3>Analysis evidence links</h3><div className="chip-list">{snapshot.analysis?.hypotheses.flatMap((item) => [...item.metricIds, ...item.spanIds]).map((id) => <span className="chip" key={id}>{id}</span>) ?? <span className="muted">Not generated yet.</span>}</div></aside>;
}
