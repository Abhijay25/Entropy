import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CONFIGURED_TOPOLOGY,
  evaluateMatchedPairAndBlastRadius,
  PRIMARY_CHANNEL_BY_SERVICE,
  SERVICE_REGISTRY,
  type AgentStreamEvent,
  type ServiceId,
  type TrialTelemetry
} from '../../../shared/types.js';
import { Neo4jGraphRepository } from './neo4jClient.js';

const SHA = 'a'.repeat(40);
const HASH = 'b'.repeat(64);
const TIME = '2026-01-01T00:00:00.000Z';

function repository(): Neo4jGraphRepository {
  let number = 0;
  return new Neo4jGraphRepository({ inMemory: true, createId: () => `run-${++number}`, now: () => TIME });
}

function trial(runId: string, id: string, kind: TrialTelemetry['kind'], changed: ServiceId[] = []): TrialTelemetry {
  return {
    id, runId, kind, status: 'COMPLETED', executionMode: 'development-local', cleanupStatus: 'DELETED', startedAt: TIME, finishedAt: TIME,
    sourceSha: SHA, payloadHash: HASH, workloadHash: HASH, runtimeIdentity: 'test', faultWitnessed: kind === 'chaos',
    metrics: SERVICE_REGISTRY.map((node) => ({ id: `untrusted-${node.id}`, serviceId: node.id, channel: PRIMARY_CHANNEL_BY_SERVICE[node.id], status: changed.includes(node.id) ? 'DEGRADED' : 'HEALTHY', requestsStarted: 130, requestsCompleted: 130, errorsTotal: 0, timeoutsTotal: 0, errorRate: 0, latencyP50Ms: 1, latencyP95Ms: 1, latencyP99Ms: 1, sampleCount: 130, smallSample: false })),
    spans: kind === 'chaos' ? [
      { id: 'frontend-span', kind: 'server', traceId: 'business-trace', serviceId: 'frontend', downstreamId: 'auth-service', channel: 'business', startedAt: TIME, durationMs: 1, faultApplied: false },
      { id: 'auth-span', kind: 'server', traceId: 'business-trace', serviceId: 'auth-service', downstreamId: 'redis-cache', channel: 'business', startedAt: TIME, durationMs: 1, faultApplied: false },
      { id: 'redis-witness', kind: 'client', traceId: 'business-trace', serviceId: 'redis-cache', channel: 'business', startedAt: TIME, durationMs: 3000, faultApplied: true }
    ] : [],
    artifacts: [], clientSummary: { scheduled: 130, started: 130, completed: 130, skipped: 0, errors: 0, checkoutStarted: 100, checkoutCompleted: 100, checkoutErrors: kind === 'chaos' ? 30 : 0, checkoutErrorRate: kind === 'chaos' ? .3 : 0, checkoutP95Ms: 1 }, validity: 'valid', warnings: []
  };
}

function event(runId: string, seq: number): AgentStreamEvent {
  return { id: `${runId}:${seq}`, runId, seq, type: 'TERMINAL_LOG', timestamp: TIME, message: `event ${seq}` };
}

describe('Neo4jGraphRepository in explicit test-memory mode', () => {
  it('returns the six-node, six-edge configured template topology', async () => {
    const graph = await repository().seedTopology();
    assert.equal(graph.nodes.length, 6);
    assert.deepEqual(graph.edges.map((edge) => `${edge.source}:${edge.relationship}:${edge.target}`), [
      'frontend:CALLS:order-service', 'order-service:CALLS:payment-service', 'payment-service:WRITES:postgres-db',
      'frontend:CALLS:auth-service', 'auth-service:READS:redis-cache', 'payment-service:VERIFY_TOKEN:auth-service'
    ]);
  });

  it('returns fixed parameterized risk context for a run', async () => {
    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA });
    const context = await graph.retrieveRiskContext(run.id);
    assert.match(context.fixedCypherQuery, /r\.key = \$redisKey/);
    assert.deepEqual(context.fixedCypherParameters, { redisKey: `entropy:${run.id}:redis-cache`, projectId: 'entropy', scope: run.id });
    assert.ok(context.pathsToRedis.every((path) => path.at(-1) === 'redis-cache'));
  });

  it('persists trials with deterministic metric IDs and uses persisted metrics for graph status', async () => {
    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA });
    await graph.saveTrial(trial(run.id, 'chaos-1', 'chaos', ['auth-service']));
    const stored = await graph.getRun(run.id);
    const topology = await graph.getGraph({ runId: run.id, trialId: 'chaos-1' });
    assert.equal(stored?.trials[0]?.metrics[0]?.id, 'chaos-1:frontend:business');
    assert.equal(topology.nodes.find((node) => node.id === 'auth-service')?.status, 'DEGRADED');
    assert.equal(topology.nodes.find((node) => node.id === 'payment-service')?.status, 'HEALTHY');
  });

  it('stores only evidence-supported reverse blast-radius overlays', async () => {
    const control = trial('run-1', 'control-1', 'control');
    const chaos = trial('run-1', 'chaos-1', 'chaos', ['frontend', 'auth-service', 'redis-cache']);
    const result = evaluateMatchedPairAndBlastRadius(control, chaos, DEFAULT_CONFIGURED_TOPOLOGY);
    assert.equal(result.comparisonValidity, 'valid');
    assert.deepEqual(result.actualBlastRadiusIds, ['frontend', 'auth-service', 'redis-cache']);
    assert.deepEqual(result.observedCascadeEdges.map((edge) => `${edge.source}->${edge.target}`), ['auth-service->frontend', 'redis-cache->auth-service']);
    assert.ok(result.observedCascadeEdges.every((edge) => edge.supportingSpanIds.includes('redis-witness')));

    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA });
    await graph.saveComparison(run.id, result);
    const persisted = await graph.getGraph({ runId: run.id });
    assert.deepEqual(persisted.edges.filter((edge) => edge.relationship === 'CASCADED_TO').map((edge) => edge.id), result.observedCascadeEdges.map((edge) => edge.id));
  });

  it('caps each durable event log at 250 and flags replay before its retained sequence', async () => {
    const graph = repository();
    const run = await graph.createRun({ sourceSha: SHA });
    await Promise.all(Array.from({ length: 251 }, (_, index) => graph.appendEvent(event(run.id, index + 1))));
    const replay = await graph.getEventsAfter(run.id, 0);
    assert.equal(replay.events.length, 250);
    assert.equal(replay.events[0]?.seq, 2);
    assert.equal(replay.truncated, true);
  });

  it('returns the original operation claim for an idempotency key', async () => {
    const graph = repository();
    const first = await graph.claimOperationKey('operation-1', 'start', 'run-1');
    const retry = await graph.claimOperationKey('operation-1', 'cancel', 'run-2');
    assert.deepEqual(retry, first);
  });
});
