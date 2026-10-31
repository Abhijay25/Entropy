import { useCallback, useEffect, useRef, useState } from 'react';
import { DEV_FIXTURE_BANNER, DEV_FIXTURE_DIAGNOSTIC_SESSION, DEV_FIXTURE_RUN_SNAPSHOT } from '@entropy/shared';
import type { DiagnosticSession, RunSnapshot, TopologyGraph } from '@entropy/shared';
import { api, listFrom, normalizeIntegrations, type IntegrationStatus, type RunSummary } from './api';
import { DiagnosticDrawer } from './components/DiagnosticDrawer';
import { EvidenceDrawer } from './components/EvidenceDrawer';
import { HypothesisCard } from './components/HypothesisCard';
import { TerminalFeed } from './components/TerminalFeed';
import { TopologyGraph as TopologyGraphView } from './components/TopologyGraph';
import { TrialComparison } from './components/TrialComparison';

const TERMINAL_RUN_STATUSES = new Set(['COMPLETED', 'BASELINE_FAILED', 'INCONCLUSIVE', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
const TERMINAL_DIAGNOSTIC_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export const isSmallCheckoutSample = (sampleCount: number) => sampleCount < 20;
export const liveStateAfterFixture = () => ({ snapshot: undefined, graph: undefined, diagnostic: undefined });
function updateUrl(runId?: string) { const url = new URL(window.location.href); if (runId) url.searchParams.set('runId', runId); else url.searchParams.delete('runId'); window.history.replaceState({}, '', url); }
function operationKey() { return crypto.randomUUID(); }

function AnalysisPanel({ snapshot }: { snapshot?: RunSnapshot }) {
  const analysis = snapshot?.analysis;
  return <section className="panel analysis-panel"><p className="eyebrow">Nosana evidence analysis</p><h2>Measured facts, hypotheses, and limitations</h2>{!analysis ? <p className="muted">Not generated yet.</p> : analysis.status === 'unavailable' ? <p className="muted">Analysis unavailable. Telemetry remains authoritative.</p> : <><p>{analysis.summary}</p><p className="muted">{analysis.source}{analysis.model ? ` - ${analysis.model}` : ''} - prompt {analysis.promptVersion} - {analysis.createdAt}</p><h3>Qualified hypotheses</h3>{analysis.hypotheses.map((item) => <article key={item.explanation}><p>{item.explanation}</p><div className="chip-list">{item.metricIds.map((id) => <button className="chip" title={`Metric ${id}`} key={id}>{id}</button>)}{item.spanIds.map((id) => <button className="chip" title={`Span ${id}`} key={id}>{id}</button>)}</div></article>)}<h3>Proposed remediation</h3>{analysis.remediation.map((item) => <article key={item.proposal}><p>{item.proposal}</p><p className="muted">Limitation: {item.limitation}</p><div className="chip-list">{item.metricIds.map((id) => <button className="chip" title={`Metric ${id}`} key={id}>{id}</button>)}</div></article>)}</>}</section>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<RunSnapshot>();
  const [graph, setGraph] = useState<TopologyGraph>();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationStatus[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string>();
  const [pair, setPair] = useState<'original' | 'reproduction'>('original');
  const [diagnostic, setDiagnostic] = useState<DiagnosticSession>();
  const [fixtureMode, setFixtureMode] = useState(false);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const lastStreamRefresh = useRef(0);

  const refreshRuns = useCallback(async () => setRuns(listFrom(await api.runs(), 'runs')), []);
  const refreshTopology = useCallback(async (runId?: string) => setGraph(await api.topology(runId)), []);
  const refreshRun = useCallback(async (runId: string) => {
    const [run] = await Promise.all([api.run(runId), refreshTopology(runId)]);
    setSnapshot(run); updateUrl(runId);
  }, [refreshTopology]);
  const refreshLive = useCallback(async () => {
    const [integrationsResult, topologyResult, runsResult] = await Promise.allSettled([api.integrations(), api.topology(), api.runs()]);
    const errors: string[] = [];
    if (integrationsResult.status === 'fulfilled') setIntegrations(normalizeIntegrations(integrationsResult.value)); else errors.push('integrations unavailable');
    if (topologyResult.status === 'fulfilled') setGraph(topologyResult.value); else errors.push('topology unavailable');
    if (runsResult.status === 'fulfilled') setRuns(listFrom(runsResult.value, 'runs')); else errors.push('saved runs unavailable');
    if (errors.length) setError(`Live API error: ${errors.join(', ')}.`);
  }, []);
  useEffect(() => { void (async () => { await refreshLive(); const requested = new URLSearchParams(window.location.search).get('runId'); if (requested) { try { await refreshRun(requested); } catch { setError('Live API error: unable to load selected run.'); } } setLoading(false); })(); }, [refreshLive, refreshRun]);

  const selectRun = useCallback(async (runId: string) => {
    setError(undefined); setPair('original');
    if (!runId) { setSnapshot(undefined); setDiagnostic(undefined); updateUrl(undefined); try { await refreshTopology(); } catch { setError('Live API error: unable to load template topology.'); } return; }
    try { await refreshRun(runId); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to load saved run.'); }
  }, [refreshRun, refreshTopology]);
  const refreshForStream = useCallback(async (runId: string) => {
    if (fixtureMode || Date.now() - lastStreamRefresh.current < 700) return;
    lastStreamRefresh.current = Date.now();
    try { await refreshRun(runId); } catch { setError('Live API error: unable to resync stream snapshot.'); }
  }, [fixtureMode, refreshRun]);
  const perform = useCallback(async (work: () => Promise<void>) => { setError(undefined); try { await work(); await refreshRuns(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Action failed.'); } }, [refreshRuns]);
  const runExperiment = () => { if (fixtureMode) return; const key = operationKey(); setPair('original'); void perform(async () => { const { runId } = await api.startRun(key); await refreshRun(runId); }); };
  const reproduce = () => { if (!snapshot || fixtureMode) return; const key = operationKey(); void perform(async () => { await api.reproduce(snapshot.id, key); await refreshRun(snapshot.id); }); };
  const investigate = () => { if (!snapshot || fixtureMode) return; const key = operationKey(); void perform(async () => { const result = await api.investigate(snapshot.id, key); setDiagnostic(await api.diagnostic(result.diagnosticId)); }); };
  const cancelRun = () => { if (!snapshot || fixtureMode) return; void perform(async () => { await api.cancel(snapshot.id); await refreshRun(snapshot.id); }); };
  const cancelDiagnostic = useCallback(() => { if (!diagnostic || fixtureMode) return; void (async () => { try { await api.cancelDiagnostic(diagnostic.id); setDiagnostic(await api.diagnostic(diagnostic.id)); } catch { setError('Live API error: unable to cancel diagnostic.'); } })(); }, [diagnostic, fixtureMode]);
  useEffect(() => {
    if (!diagnostic || fixtureMode || TERMINAL_DIAGNOSTIC_STATUSES.has(diagnostic.status)) return;
    const timer = window.setInterval(() => { void api.diagnostic(diagnostic.id).then(setDiagnostic).catch(() => setError('Live API error: unable to refresh diagnostic.')); }, 1_000);
    return () => window.clearInterval(timer);
  }, [diagnostic, fixtureMode]);
  const showFixture = useCallback((enabled: boolean) => {
    setFixtureMode(enabled); setError(undefined); setPair('original');
    if (enabled) { setSnapshot(DEV_FIXTURE_RUN_SNAPSHOT); setGraph(DEV_FIXTURE_RUN_SNAPSHOT.graph); setDiagnostic(DEV_FIXTURE_DIAGNOSTIC_SESSION); updateUrl(undefined); return; }
    const state = liveStateAfterFixture(); setSnapshot(state.snapshot); setGraph(state.graph); setDiagnostic(state.diagnostic); updateUrl(undefined); void refreshLive();
  }, [refreshLive]);

  const isFixtureSnapshot = fixtureMode || snapshot?.trials.some((trial) => trial.executionMode === 'development-local') === true;
  const isBusy = Boolean(snapshot && !TERMINAL_RUN_STATUSES.has(snapshot.status));
  return <main className="app-shell">{isFixtureSnapshot && <div className="fixture-banner" role="status">{DEV_FIXTURE_BANNER}</div>}<header className="app-header"><div className="brand"><strong>Entropy</strong><span>Cascade experiment</span></div><div className="header-meta"><span>Source revision <code>{snapshot?.sourceSha ?? 'not loaded'}</code></span><span>Stage <strong>{snapshot?.status ?? (loading ? 'LOADING' : 'IDLE')}</strong></span></div><div className="integration-status">{integrations.map((item) => <span key={item.name} className={`status-text ${item.status}`}>● {item.name}</span>)}</div><div className="header-actions"><button className="primary" onClick={runExperiment} disabled={isBusy || fixtureMode}>Run Experiment</button><button onClick={cancelRun} disabled={!snapshot || !isBusy || fixtureMode}>Cancel</button><button onClick={reproduce} disabled={!snapshot || isBusy || fixtureMode}>Reproduce</button><button onClick={investigate} disabled={!snapshot || isBusy || fixtureMode}>Investigate</button><label className="compact-label">Saved runs <select value={snapshot?.id ?? ''} onChange={(event) => void selectRun(event.target.value)} disabled={fixtureMode}><option value="">Select a run</option>{runs.map((run) => <option value={run.id} key={run.id}>{run.id} · {run.status}</option>)}</select></label><label className="fixture-toggle"><input type="checkbox" checked={fixtureMode} onChange={(event) => showFixture(event.target.checked)} /> Load Labeled Dev Fixture</label></div></header>{error && <div className="error-message" role="alert">{error}</div>}<div className="dashboard-grid"><HypothesisCard hypothesis={snapshot?.hypothesis} /><TrialComparison snapshot={snapshot} pair={pair} onPairChange={setPair} /><TopologyGraphView graph={graph} predictedIds={snapshot?.hypothesis?.predictedBlastRadiusIds ?? []} selectedNodeId={selectedNodeId} onSelect={setSelectedNodeId} /><EvidenceDrawer snapshot={snapshot} serviceId={selectedNodeId} pair={pair} /><AnalysisPanel snapshot={snapshot} />{snapshot && !fixtureMode && <TerminalFeed runId={snapshot.id} terminal={TERMINAL_RUN_STATUSES.has(snapshot.status)} onResync={refreshForStream} />}<DiagnosticDrawer diagnostic={diagnostic} onCancel={cancelDiagnostic} /></div></main>;
}
