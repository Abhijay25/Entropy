import { describe, expect, it } from 'vitest';
import {
  AgentStreamEventSchema,
  CATALOGUE_FALLBACK_HYPOTHESIS,
  ChaosHypothesisSchema,
  DEFAULT_CONFIGURED_TOPOLOGY,
  DEV_FIXTURE_DIAGNOSTIC_SESSION,
  DEV_FIXTURE_RUN_SNAPSHOT,
  DiagnosticSessionSchema,
  EvidenceAnalysisSchema,
  RunSnapshotSchema,
  TopologyGraphSchema,
  TrialTelemetrySchema,
  evaluateBaselineTrial,
  evaluateChaosTrial,
  evaluateMatchedPairAndBlastRadius,
  classifyReproduction,
  type ServiceId,
  type ServiceMetric,
  type TrialTelemetry
} from './types.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const sourceSha = 'a'.repeat(40);
const contentHash = 'b'.repeat(64);
const serviceIds: readonly ServiceId[] = ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache', 'postgres-db'];

function metric(serviceId: ServiceId, status: ServiceMetric['status'] = 'HEALTHY'): ServiceMetric {
  const empty = status === 'UNKNOWN';
  return {
    id: `metric-${serviceId}`,
    serviceId,
    channel: serviceId === 'redis-cache' || serviceId === 'postgres-db' ? 'canary' : 'business',
    status,
    requestsStarted: empty ? 0 : 100,
    requestsCompleted: empty ? 0 : 100,
    errorsTotal: 0,
    timeoutsTotal: 0,
    errorRate: empty ? null : 0,
    latencyP50Ms: empty ? null : 10,
    latencyP95Ms: empty ? null : 10,
    latencyP99Ms: empty ? null : 10,
    sampleCount: empty ? 0 : 100,
    smallSample: empty
  };
}

function controlTrial(): TrialTelemetry {
  return {
    id: 'control-trial',
    runId: 'run-1',
    kind: 'control',
    status: 'COMPLETED',
    executionMode: 'development-local',
    cleanupStatus: 'DELETED',
    startedAt: timestamp,
    finishedAt: timestamp,
    sourceSha,
    payloadHash: contentHash,
    workloadHash: contentHash,
    runtimeIdentity: 'node-22',
    faultWitnessed: false,
    metrics: serviceIds.map((serviceId) => metric(serviceId)),
    spans: [],
    artifacts: [],
    clientSummary: {
      scheduled: 130,
      started: 130,
      completed: 130,
      skipped: 0,
      errors: 0,
      checkoutStarted: 100,
      checkoutCompleted: 100,
      checkoutErrors: 0,
      checkoutErrorRate: 0,
      checkoutP95Ms: 10,
      businessSkipped: 0,
      sessionCompleted: 10,
      redisCanaryCompleted: 10,
      postgresCanaryCompleted: 10
    },
    validity: 'valid',
    warnings: []
  };
}

function chaosTrial(): TrialTelemetry {
  const trial = controlTrial();
  trial.id = 'chaos-trial';
  trial.kind = 'chaos';
  trial.faultWitnessed = true;
  trial.clientSummary.errors = 30;
  trial.clientSummary.checkoutErrors = 30;
  trial.clientSummary.checkoutErrorRate = 0.3;
  trial.metrics = serviceIds.map((serviceId) => metric(serviceId, serviceId === 'postgres-db' ? 'HEALTHY' : 'DEGRADED'));
  trial.spans = [
    { id: 'span-frontend', kind: 'server', traceId: 'trace-1', serviceId: 'frontend', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-order', kind: 'server', traceId: 'trace-1', serviceId: 'order-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-payment', kind: 'server', traceId: 'trace-1', serviceId: 'payment-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-auth', kind: 'server', traceId: 'trace-1', serviceId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-redis-witness', kind: 'server', traceId: 'trace-1', serviceId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: true }
  ];
  return trial;
}

function runSnapshot(control: TrialTelemetry, chaos: TrialTelemetry) {
  const comparison = evaluateMatchedPairAndBlastRadius(control, chaos);
  return {
    id: 'run-1',
    status: 'COMPLETED' as const,
    createdAt: timestamp,
    sourceSha,
    payloadHash: contentHash,
    topologyHash: contentHash,
    trials: [control, chaos],
    actualBlastRadiusIds: comparison.actualBlastRadiusIds,
    comparisonValidity: comparison.comparisonValidity,
    comparisonReasons: comparison.comparisonReasons,
    graph: DEFAULT_CONFIGURED_TOPOLOGY,
    lastEventSeq: 0,
    warnings: []
  };
}

describe('strict executable schemas', () => {
  const validValues = [
    [TopologyGraphSchema, DEFAULT_CONFIGURED_TOPOLOGY],
    [ChaosHypothesisSchema, CATALOGUE_FALLBACK_HYPOTHESIS],
    [TrialTelemetrySchema, controlTrial()],
    [EvidenceAnalysisSchema, { id: 'analysis-1', source: 'deterministic', status: 'available', summary: 'Measurements are available.', hypotheses: [], remediation: [], promptVersion: 'v1', createdAt: timestamp }],
    [RunSnapshotSchema, DEV_FIXTURE_RUN_SNAPSHOT],
    [DiagnosticSessionSchema, DEV_FIXTURE_DIAGNOSTIC_SESSION],
    [AgentStreamEventSchema, { id: 'run-1:1', runId: 'run-1', seq: 1, type: 'GRAPH_LOADED', timestamp, message: 'Graph loaded.' }]
  ] as const;

  for (const [schema, value] of validValues) {
    it(`accepts the documented ${schema.description || 'contract'} shape and rejects unknown fields`, () => {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, unexpected: true }).success).toBe(false);
    });
  }
});

describe('trial quality evaluation', () => {
  it('accepts a complete healthy baseline and rejects a missing healthy primary metric', () => {
    expect(evaluateBaselineTrial(controlTrial())).toEqual({ validity: 'valid', reasons: [] });
    const incomplete = controlTrial();
    incomplete.metrics = incomplete.metrics.filter((value) => value.serviceId !== 'auth-service');
    expect(evaluateBaselineTrial(incomplete).validity).toBe('inconclusive');

    const truncated = controlTrial();
    truncated.artifacts = [{ id: 'spans', kind: 'spans', sizeBytes: 10, sha256: contentHash, truncated: true, available: true }];
    expect(evaluateBaselineTrial(truncated)).toMatchObject({ validity: 'inconclusive', reasons: expect.arrayContaining(['Required evidence is incomplete.']) });

    const wrongState = controlTrial();
    wrongState.status = 'RUNNING';
    wrongState.faultWitnessed = true;
    expect(evaluateBaselineTrial(wrongState).validity).toBe('inconclusive');
  });

  it('requires sufficient chaos samples and a delayed Redis business witness', () => {
    expect(evaluateChaosTrial(chaosTrial())).toEqual({ validity: 'valid', reasons: [] });
    const missingWitness = chaosTrial();
    missingWitness.faultWitnessed = false;
    missingWitness.spans = [];
    expect(evaluateChaosTrial(missingWitness).validity).toBe('inconclusive');

    const insufficientCheckouts = chaosTrial();
    insufficientCheckouts.clientSummary.checkoutStarted = 94;
    insufficientCheckouts.clientSummary.checkoutCompleted = 94;
    insufficientCheckouts.clientSummary.checkoutErrors = 28;
    insufficientCheckouts.clientSummary.checkoutErrorRate = 28 / 94;
    expect(evaluateChaosTrial(insufficientCheckouts).validity).toBe('inconclusive');

    const fiveBusinessSkips = chaosTrial();
    fiveBusinessSkips.clientSummary.businessSkipped = 5;
    expect(evaluateChaosTrial(fiveBusinessSkips).validity).toBe('valid');

    const sixBusinessSkips = chaosTrial();
    sixBusinessSkips.clientSummary.businessSkipped = 6;
    expect(evaluateChaosTrial(sixBusinessSkips).validity).toBe('inconclusive');

    const missingCanaryClass = chaosTrial();
    missingCanaryClass.clientSummary.redisCanaryCompleted = 8;
    expect(evaluateChaosTrial(missingCanaryClass).validity).toBe('inconclusive');

    const sessionOnlyWitness = chaosTrial();
    sessionOnlyWitness.spans = sessionOnlyWitness.spans.filter((span) => !['order-service', 'payment-service'].includes(span.serviceId));
    expect(evaluateChaosTrial(sessionOnlyWitness).validity).toBe('inconclusive');

    const wrongState = chaosTrial();
    wrongState.status = 'RUNNING';
    wrongState.kind = 'control';
    expect(evaluateChaosTrial(wrongState).validity).toBe('inconclusive');
  });
});

describe('matched trial blast-radius evaluation', () => {
  it('uses status rank, configured Redis paths, and shared witnessed business traces', () => {
    const result = evaluateMatchedPairAndBlastRadius(controlTrial(), chaosTrial());
    expect(result.comparisonValidity).toBe('valid');
    expect(result.actualBlastRadiusIds).toEqual(['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache']);
    expect(result.observedCascadeEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'order-service', target: 'frontend', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'auth-service', target: 'payment-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'redis-cache', target: 'auth-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' })
    ]));
    expect(result.observedCascadeEdges.every((edge) => edge.supportingSpanIds.includes('span-redis-witness'))).toBe(true);
    expect(result.actualBlastRadiusIds).not.toContain('postgres-db');
  });

  it('does not infer affected nodes from status alone or compare UNKNOWN samples', () => {
    const withoutLinkedTrace = chaosTrial();
    withoutLinkedTrace.spans = withoutLinkedTrace.spans.filter((span) => span.serviceId === 'redis-cache');
    const noTraceResult = evaluateMatchedPairAndBlastRadius(controlTrial(), withoutLinkedTrace);
    expect(noTraceResult).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });

    const unknownAuth = chaosTrial();
    unknownAuth.metrics = unknownAuth.metrics.map((value) => value.serviceId === 'auth-service' ? metric('auth-service', 'UNKNOWN') : value);
    const unknownResult = evaluateMatchedPairAndBlastRadius(controlTrial(), unknownAuth);
    expect(unknownResult.comparisonValidity).toBe('valid');
    expect(unknownResult.actualBlastRadiusIds).not.toContain('auth-service');
  });

  it('returns inconclusive, not zero impact, when witness or matched identity gates fail', () => {
    const missingWitness = chaosTrial();
    missingWitness.spans = [];
    missingWitness.faultWitnessed = false;
    const witnessResult = evaluateMatchedPairAndBlastRadius(controlTrial(), missingWitness);
    expect(witnessResult).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });

    const mismatched = chaosTrial();
    mismatched.workloadHash = 'c'.repeat(64);
    mismatched.runId = 'another-run';
    const identityResult = evaluateMatchedPairAndBlastRadius(controlTrial(), mismatched);
    expect(identityResult).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });
  });
});

describe('reproduction classification', () => {
  it('classifies reproduced, partial, not reproduced, and inconclusive pairs', () => {
    const originalControl = controlTrial();
    const originalChaos = chaosTrial();
    const original = runSnapshot(originalControl, originalChaos);

    expect(classifyReproduction(original, controlTrial(), chaosTrial()).classification).toBe('reproduced');

    const partial = chaosTrial();
    partial.metrics = partial.metrics.map((value) => value.serviceId === 'redis-cache' ? value : metric(value.serviceId));
    partial.clientSummary.checkoutErrors = 10;
    partial.clientSummary.checkoutErrorRate = 0.1;
    expect(classifyReproduction(original, controlTrial(), partial).classification).toBe('partial');

    const noImpact = chaosTrial();
    noImpact.metrics = noImpact.metrics.map((value) => metric(value.serviceId));
    noImpact.clientSummary.checkoutErrors = 0;
    noImpact.clientSummary.checkoutErrorRate = 0;
    expect(classifyReproduction(original, controlTrial(), noImpact).classification).toBe('not_reproduced');

    const invalid = chaosTrial();
    invalid.faultWitnessed = false;
    invalid.spans = [];
    const invalidResult = classifyReproduction(original, controlTrial(), invalid);
    expect(invalidResult.classification).toBe('inconclusive');
    expect(invalidResult.reasons).toContain('Chaos trial did not record a fault witness.');

    const mismatchedIdentity = chaosTrial();
    mismatchedIdentity.payloadHash = 'c'.repeat(64);
    const identityResult = classifyReproduction(original, controlTrial(), mismatchedIdentity);
    expect(identityResult).toMatchObject({ classification: 'inconclusive', reasons: ['Reproduction pair identities do not match the original pair.'] });
  });
});
