import neo4j from 'neo4j-driver';
import { describe, expect, it, vi } from 'vitest';

import {
  PRIMARY_CHANNEL_BY_SERVICE,
  SERVICE_REGISTRY,
  type AgentStreamEvent,
  type ComparisonResult,
  type DiagnosticSession,
  type ServiceId,
  type TrialTelemetry
} from '../../../shared/types.js';
import { Neo4jGraphRepository } from './neo4jClient.js';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const TIME = '2026-01-01T00:00:00.000Z';

function repository(): Neo4jGraphRepository {
  let sequence = 0;
  return new Neo4jGraphRepository({ inMemory: true, createId: () => `run-${++sequence}`, now: () => TIME });
}
function trial(runId: string, id: string, kind: TrialTelemetry['kind'], options: { status?: TrialTelemetry['status']; cleanupStatus?: TrialTelemetry['cleanupStatus']; wrongChannel?: boolean; sandboxId?: string; degraded?: ServiceId[] } = {}): TrialTelemetry {
  return {
    id, runId, kind, status: options.status ?? 'COMPLETED', executionMode: 'development-local', cleanupStatus: options.cleanupStatus ?? 'DELETED', ...(options.sandboxId ? { sandboxId: options.sandboxId } : {}), startedAt: TIME, finishedAt: TIME,
    sourceSha: SHA, payloadHash: HASH, workloadHash: HASH, runtimeIdentity: 'test', faultWitnessed: kind.includes('chaos'),
    metrics: SERVICE_REGISTRY.map((node) => ({ id: `untrusted:${node.id}`, serviceId: node.id, channel: options.wrongChannel && node.id === 'auth-service' ? (PRIMARY_CHANNEL_BY_SERVICE[node.id] === 'business' ? 'canary' : 'business') : PRIMARY_CHANNEL_BY_SERVICE[node.id], status: options.degraded?.includes(node.id) ? 'DEGRADED' : 'HEALTHY', requestsStarted: 130, requestsCompleted: 130, errorsTotal: 0, timeoutsTotal: 0, errorRate: 0, latencyP50Ms: 1, latencyP95Ms: 1, latencyP99Ms: 1, sampleCount: 130, smallSample: false })),
    spans: [], artifacts: [], clientSummary: { scheduled: 130, started: 130, completed: 130, skipped: 0, errors: 0, checkoutStarted: 100, checkoutCompleted: 100, checkoutErrors: 0, checkoutErrorRate: 0, checkoutP95Ms: 1 }, validity: 'valid', warnings: []
  };
}
function event(runId: string, seq: number): AgentStreamEvent { return { id: `${runId}:${seq}`, runId, seq, type: 'TERMINAL_LOG', timestamp: TIME, message: `event ${seq}` }; }
function comparison(chaosTrialId: string, affected: ComparisonResult['actualBlastRadiusIds'] = ['auth-service']): ComparisonResult {
  return { comparisonValidity: 'valid', comparisonReasons: [], actualBlastRadiusIds: affected, observedCascadeEdges: [{ id: `observed:${chaosTrialId}:redis-cache:auth-service`, source: 'redis-cache', target: 'auth-service', relationship: 'CASCADED_TO', evidenceKind: 'observed', circuitBreaker: false, supportingSpanIds: ['witness'] }] };
}

describe('Neo4jGraphRepository explicit test-memory mode', () => {
  it('preserves concurrent control and chaos trial writes and supports idempotent trial re-import', async () => {
    const graph = repository();
    expect((await graph.seedTopology()).edges).toHaveLength(6);
    const run = await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    expect((await graph.retrieveRiskContext(run.id)).fixedCypherParameters.redisKey).toBe(`entropy:${run.id}:redis-cache`);
    await Promise.all([graph.saveTrial(trial(run.id, 'control', 'control')), graph.saveTrial(trial(run.id, 'chaos', 'chaos'))]);
    await graph.saveTrial(trial(run.id, 'chaos', 'chaos', { degraded: ['auth-service'] }));
    const stored = await graph.getRun(run.id);
    expect(stored?.trials.map((item) => item.id).sort()).toEqual(['chaos', 'control']);
    expect(stored?.trials.find((item) => item.id === 'chaos')?.metrics[0]?.id).toBe('chaos:frontend:business');
    expect(stored?.trials.find((item) => item.id === 'chaos')?.metrics.find((metric) => metric.serviceId === 'auth-service')?.status).toBe('DEGRADED');
  });

  it('preserves original comparison while recording a reproduction pair separately and rejecting mismatched pairs', async () => {
    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    await graph.saveTrial(trial(run.id, 'control', 'control'));
    await graph.saveTrial(trial(run.id, 'chaos', 'chaos'));
    await graph.saveComparison(run.id, comparison('chaos', ['auth-service']));
    await graph.saveTrial(trial(run.id, 'repro-control', 'reproduction-control'));
    await graph.saveTrial(trial(run.id, 'repro-chaos', 'reproduction-chaos'));
    await graph.saveComparison(run.id, comparison('repro-chaos', ['frontend']), { controlTrialId: 'repro-control', chaosTrialId: 'repro-chaos' });
    await graph.saveTrial(trial(run.id, 'repro-chaos', 'reproduction-chaos', { cleanupStatus: 'DELETED' }));
    await expect(graph.saveComparison(run.id, comparison('repro-chaos', ['frontend']), { controlTrialId: 'control', chaosTrialId: 'repro-chaos' })).rejects.toThrow('Mismatched');
    await expect(graph.saveComparison(run.id, comparison('repro-chaos', ['frontend']), { controlTrialId: 'missing', chaosTrialId: 'repro-chaos' })).rejects.toThrow('Unknown comparison trial');
    const stored = await graph.getRun(run.id);
    expect(stored?.actualBlastRadiusIds).toEqual(['auth-service']);
    expect(stored?.comparisonValidity).toBe('valid');
    expect(stored?.reproduction?.controlTrialId).toBe('repro-control');
    expect(stored?.graph.edges.filter((edge) => edge.relationship === 'CASCADED_TO').map((edge) => edge.id)).toEqual(['observed:chaos:redis-cache:auth-service']);
    expect((await graph.getGraph({ runId: run.id, trialId: 'repro-chaos' })).edges.filter((edge) => edge.relationship === 'CASCADED_TO').map((edge) => edge.id)).toEqual(['observed:repro-chaos:redis-cache:auth-service']);
  });

  it('keeps a missing primary metric UNKNOWN and rejects unknown run/trial selection', async () => {
    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    await graph.saveTrial(trial(run.id, 'control', 'control', { wrongChannel: true }));
    expect((await graph.getGraph({ runId: run.id, trialId: 'control' })).nodes.find((node) => node.id === 'auth-service')?.status).toBe('UNKNOWN');
    await expect(graph.getGraph({ runId: run.id, trialId: 'missing' })).rejects.toThrow('Unknown trial');
    await expect(graph.getGraph({ runId: 'missing' })).rejects.toThrow('Unknown run');
  });

  it('deduplicates event retries and retains only the latest 250 events', async () => {
    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    await Promise.all([graph.appendEvent(event(run.id, 1)), graph.appendEvent(event(run.id, 1))]);
    await Promise.all(Array.from({ length: 250 }, (_, index) => graph.appendEvent(event(run.id, index + 2))));
    const replay = await graph.getEventsAfter(run.id, 0);
    expect(replay.events).toHaveLength(250);
    expect(replay.events[0]?.seq).toBe(2);
    expect(replay.truncated).toBe(true);
  });

  it('finds completed resources that still require cleanup across more than 20 runs and diagnostics', async () => {
    const graph = repository();
    const first = await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    await graph.saveTrial(trial(first.id, 'completed-pending', 'chaos', { cleanupStatus: 'PENDING', sandboxId: 'sandbox-trial' }));
    for (let index = 0; index < 21; index += 1) await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    const diagnostic = { id: 'diagnostic-pending', runId: first.id, sandboxId: 'sandbox-diagnostic', status: 'COMPLETED', cleanupStatus: 'FAILED', createdAt: TIME, toolTrace: [] } as DiagnosticSession;
    await graph.saveDiagnostic(diagnostic);
    await expect(graph.saveDiagnostic({ ...diagnostic, id: 'unknown-run-diagnostic', runId: 'missing-run' })).rejects.toThrow('Unknown run');
    expect(await graph.findUnfinishedResources()).toEqual(expect.arrayContaining([
      { runId: first.id, trialId: 'completed-pending', sandboxId: 'sandbox-trial', cleanupStatus: 'PENDING' },
      { runId: first.id, diagnosticId: 'diagnostic-pending', sandboxId: 'sandbox-diagnostic', cleanupStatus: 'FAILED' }
    ]));
  });

  it('returns the existing claim for duplicate operation keys, rejects conflicting actions, and isolates run graphs', async () => {
    const graph = repository();
    const firstClaim = await graph.claimOperationKey('11111111-1111-4111-8111-111111111111', 'reproduce');
    const backfilledClaim = await graph.claimOperationKey('11111111-1111-4111-8111-111111111111', 'reproduce', 'run-1', ['repro-control', 'repro-chaos']);
    const duplicateClaim = await graph.claimOperationKey('11111111-1111-4111-8111-111111111111', 'reproduce', 'run-2', ['ignored-1', 'ignored-2']);
    await expect(graph.claimOperationKey('11111111-1111-4111-8111-111111111111', 'investigate', 'run-2')).rejects.toThrow('already claimed for action reproduce');
    await expect(graph.createRun({ sourceSha: SHA, payloadHash: HASH, operationKey: '11111111-1111-4111-8111-111111111111' })).rejects.toThrow('already claimed for action reproduce');
    expect(firstClaim).toEqual({ id: '11111111-1111-4111-8111-111111111111', action: 'reproduce', replayed: false });
    expect(backfilledClaim).toEqual({ id: '11111111-1111-4111-8111-111111111111', action: 'reproduce', targetId: 'run-1', trialIds: ['repro-control', 'repro-chaos'], replayed: true });
    expect(duplicateClaim).toEqual({ id: '11111111-1111-4111-8111-111111111111', action: 'reproduce', targetId: 'run-1', trialIds: ['repro-control', 'repro-chaos'], replayed: true });

    await graph.claimOperationKey('33333333-3333-4333-8333-333333333333', 'run', 'preclaimed-run-id');
    const preclaimedRun = await graph.createRun({ id: 'ignored-id', sourceSha: SHA, payloadHash: HASH, operationKey: '33333333-3333-4333-8333-333333333333' });
    expect(preclaimedRun.id).toBe('preclaimed-run-id');

    const firstRun = await graph.createRun({ sourceSha: SHA, payloadHash: HASH, operationKey: '22222222-2222-4222-8222-222222222222' });
    const replayedRun = await graph.createRun({ sourceSha: SHA, payloadHash: HASH, operationKey: '22222222-2222-4222-8222-222222222222' });
    expect(replayedRun.id).toBe(firstRun.id);
    await graph.saveTrial(trial(firstRun.id, 'control-1', 'control'));
    await graph.saveTrial(trial(firstRun.id, 'chaos-1', 'chaos', { degraded: ['auth-service'] }));
    await graph.saveComparison(firstRun.id, comparison('chaos-1', ['auth-service']));
    expect((await graph.getRun(firstRun.id))?.graph.nodes.find((node) => node.id === 'auth-service')?.status).toBe('DEGRADED');
    const secondRun = await graph.createRun({ sourceSha: SHA, payloadHash: HASH });
    await graph.saveTrial(trial(secondRun.id, 'chaos-2', 'chaos'));
    expect((await graph.getGraph({ runId: firstRun.id })).nodes.find((node) => node.id === 'auth-service')?.status).toBe('DEGRADED');
    expect((await graph.getGraph({ runId: secondRun.id })).nodes.find((node) => node.id === 'auth-service')?.status).toBe('HEALTHY');
  });
});

describe('Neo4j driver adapter', () => {
  it('uses parameterized reads/writes, neo4j Integer limits, scalar properties, atomic operation claims, and template topologyHash filtering', async () => {
    const queries: Array<{ text: string; params: Record<string, unknown> }> = [];
    const records = SERVICE_REGISTRY.map((node) => ({ get: (key: string) => key === 'n' ? { properties: { ...node, port: neo4j.int(node.port), status: 'UNKNOWN' } } : [] }));
    let snapshotJson = '';
    let firstToken: string | undefined;
    const transaction = {
      run: vi.fn(async (text: string, params: Record<string, unknown> = {}) => {
        queries.push({ text, params });
        if (typeof params.snapshotJson === 'string') snapshotJson = params.snapshotJson;
        if (text.includes('RETURN r.snapshotJson AS snapshotJson, r.eventsJson AS eventsJson')) {
          return { records: snapshotJson ? [{ get: (key: string) => key === 'snapshotJson' ? snapshotJson : '[]' }] : [] };
        }
        if (text.includes('o.firstCallToken=$callToken')) {
          const isReplay = firstToken !== undefined && firstToken !== params.callToken;
          if (!firstToken) firstToken = String(params.callToken);
          return {
            records: [{
              get: (key: string) => key === 'id' ? params.id : key === 'action' ? 'reproduce' : key === 'targetId' ? 'run-1' : key === 'trialIds' ? ['repro-control', 'repro-chaos'] : isReplay
            }]
          };
        }
        return { records: text.includes('LIMIT $limit') ? [] : records };
      })
    };
    let tokenCounter = 0;
    const session = { executeRead: vi.fn((work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)), executeWrite: vi.fn((work: (tx: typeof transaction) => Promise<unknown>) => work(transaction)), close: vi.fn(async () => undefined) };
    const driver = { session: vi.fn(() => session), verifyConnectivity: vi.fn(), close: vi.fn() };
    const graph = new Neo4jGraphRepository({ driver: driver as unknown as never, createId: () => `token-${++tokenCounter}`, now: () => TIME });
    const topology = await graph.getGraph({});
    await graph.listRuns(20);
    const firstClaim = await graph.claimOperationKey('44444444-4444-4444-8444-444444444444', 'reproduce', 'run-1', ['repro-control', 'repro-chaos']);
    const secondClaim = await graph.claimOperationKey('44444444-4444-4444-8444-444444444444', 'reproduce', 'run-1', ['repro-control', 'repro-chaos']);
    expect(firstClaim.replayed).toBe(false);
    expect(secondClaim.replayed).toBe(true);
    const run = await graph.createRun({ id: 'run-1', sourceSha: SHA, payloadHash: HASH, topologyHash: HASH });
    await graph.saveTrial(trial(run.id, 'control-1', 'control', { degraded: ['auth-service'] }));
    await graph.saveTrial(trial(run.id, 'chaos-1', 'chaos', { degraded: ['auth-service'] }));
    await graph.saveTrial(trial(run.id, 'repro-chaos-1', 'reproduction-chaos', { degraded: ['frontend'] }));
    await graph.saveDiagnostic({
      id: 'diag-1', runId: run.id, status: 'COMPLETED', cleanupStatus: 'DELETED', createdAt: TIME, toolTrace: [],
      analysis: { id: 'analysis-1', source: 'nosana', status: 'available', summary: 'Observed delay.', hypotheses: [{ explanation: 'Redis delayed auth.', metricIds: ['chaos-1:auth-service:business'], spanIds: [] }], remediation: [], promptVersion: 'v1', createdAt: TIME }
    });
    expect(topology.nodes[0]?.port).toBe(4100);
    expect(queries.some((query) => query.text.includes('n.key STARTS WITH $keyPrefix') && String(query.params.keyPrefix).startsWith('entropy:template:'))).toBe(true);
    expect(queries.some((query) => query.text.includes('r.status=$status') && query.params.sourceSha === SHA)).toBe(true);
    expect(queries.some((query) => query.text.includes('t.kind=$kind') && query.params.workloadHash === HASH)).toBe(true);
    expect(queries.some((query) => query.text.includes('m.latencyP95Ms=$latencyP95Ms') && neo4j.isInt(query.params.requestsCompleted))).toBe(true);
    expect(queries.filter((query) => query.text.includes('SET n.status=$status, n.metricId=$id')).every((query) => String(query.params.trialId) === 'chaos-1')).toBe(true);
    expect(queries.some((query) => query.text.includes('MERGE (d)-[:HAS_ANALYSIS]->(a)'))).toBe(true);
    const listQuery = queries.find((query) => query.text.includes('LIMIT $limit'));
    expect(neo4j.isInt(listQuery?.params.limit)).toBe(true);
  });
});
