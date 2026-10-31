import { describe, expect, it } from 'vitest';
import {
  AgentStreamEventSchema,
  CATALOGUE_FALLBACK_HYPOTHESIS,
  ChaosHypothesisSchema,
  DEFAULT_CONFIGURED_TOPOLOGY,
  DEV_FIXTURE_DIAGNOSTIC_SESSION,
  DEV_FIXTURE_RUN_SNAPSHOT,
  DependencyEdgeSchema,
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
    { id: 'client-frontend-order', kind: 'client', traceId: 'trace-1', serviceId: 'frontend', downstreamId: 'order-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-order', kind: 'server', traceId: 'trace-1', serviceId: 'order-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'client-order-payment', kind: 'client', traceId: 'trace-1', serviceId: 'order-service', downstreamId: 'payment-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-payment', kind: 'server', traceId: 'trace-1', serviceId: 'payment-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'client-payment-auth', kind: 'client', traceId: 'trace-1', serviceId: 'payment-service', downstreamId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-auth', kind: 'server', traceId: 'trace-1', serviceId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'client-auth-redis', kind: 'client', traceId: 'trace-1', serviceId: 'auth-service', downstreamId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
    { id: 'span-redis-witness', kind: 'server', traceId: 'trace-1', serviceId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: true }
  ];
  return trial;
}

function reproductionTrials() {
  const control = controlTrial();
  control.id = 'reproduction-control-trial';
  control.kind = 'reproduction-control';
  const chaos = chaosTrial();
  chaos.id = 'reproduction-chaos-trial';
  chaos.kind = 'reproduction-chaos';
  return { control, chaos };
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

  it('enforces edge, blast-radius uniqueness, and inconclusive snapshot invariants', () => {
    expect(DependencyEdgeSchema.safeParse({
      id: 'observed:1',
      source: 'redis-cache',
      target: 'auth-service',
      relationship: 'CASCADED_TO',
      evidenceKind: 'observed',
      circuitBreaker: false,
      supportingSpanIds: ['span-1']
    }).success).toBe(true);

    expect(DependencyEdgeSchema.safeParse({
      id: 'observed:empty',
      source: 'redis-cache',
      target: 'auth-service',
      relationship: 'CASCADED_TO',
      evidenceKind: 'observed',
      circuitBreaker: false,
      supportingSpanIds: []
    }).success).toBe(false);

    expect(DependencyEdgeSchema.safeParse({
      id: 'observed:configured',
      source: 'redis-cache',
      target: 'auth-service',
      relationship: 'CASCADED_TO',
      evidenceKind: 'configured',
      circuitBreaker: false,
      supportingSpanIds: ['span-1']
    }).success).toBe(false);

    expect(DependencyEdgeSchema.safeParse({
      id: 'calls:observed',
      source: 'auth-service',
      target: 'redis-cache',
      relationship: 'READS',
      evidenceKind: 'observed',
      circuitBreaker: false,
      supportingSpanIds: ['span-1']
    }).success).toBe(false);

    expect(ChaosHypothesisSchema.safeParse({
      ...CATALOGUE_FALLBACK_HYPOTHESIS,
      predictedBlastRadiusIds: ['redis-cache', 'redis-cache']
    }).success).toBe(false);

    expect(RunSnapshotSchema.safeParse({
      ...DEV_FIXTURE_RUN_SNAPSHOT,
      comparisonValidity: 'inconclusive',
      actualBlastRadiusIds: ['redis-cache']
    }).success).toBe(false);
  });
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

    const wrongStatus = controlTrial();
    wrongStatus.status = 'RUNNING';
    expect(evaluateBaselineTrial(wrongStatus)).toMatchObject({ validity: 'inconclusive', reasons: ['Trial did not complete.'] });

    const unexpectedWitness = controlTrial();
    unexpectedWitness.faultWitnessed = true;
    expect(evaluateBaselineTrial(unexpectedWitness)).toMatchObject({ validity: 'inconclusive', reasons: ['Healthy trial recorded a fault witness.'] });

    const wrongKind = controlTrial();
    wrongKind.kind = 'chaos';
    expect(evaluateBaselineTrial(wrongKind)).toMatchObject({ validity: 'inconclusive', reasons: ['Healthy trial has an invalid kind.'] });

    const withErrors = controlTrial();
    withErrors.clientSummary.errors = 1;
    expect(evaluateBaselineTrial(withErrors)).toMatchObject({ validity: 'inconclusive', reasons: ['Healthy trial did not complete 130 error-free requests.'] });

    const degradedPrimary = controlTrial();
    degradedPrimary.metrics = degradedPrimary.metrics.map((value) => value.serviceId === 'payment-service' ? metric('payment-service', 'DEGRADED') : value);
    expect(evaluateBaselineTrial(degradedPrimary)).toMatchObject({ validity: 'inconclusive', reasons: ['Primary metric for payment-service is not HEALTHY.'] });

    const invalidBaselineReport = controlTrial();
    invalidBaselineReport.validity = 'invalid';
    expect(evaluateBaselineTrial(invalidBaselineReport)).toMatchObject({ validity: 'inconclusive', reasons: ['Trial report is not valid.'] });
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

    const wrongStatus = chaosTrial();
    wrongStatus.status = 'RUNNING';
    expect(evaluateChaosTrial(wrongStatus)).toMatchObject({ validity: 'inconclusive', reasons: ['Trial did not complete.'] });

    const wrongKind = chaosTrial();
    wrongKind.kind = 'control';
    expect(evaluateChaosTrial(wrongKind)).toMatchObject({ validity: 'inconclusive', reasons: ['Chaos trial has an invalid kind.'] });

    const invalidChaosReport = chaosTrial();
    invalidChaosReport.validity = 'invalid';
    expect(evaluateChaosTrial(invalidChaosReport)).toMatchObject({ validity: 'inconclusive', reasons: ['Chaos report is not valid.'] });

    const missingSessions = chaosTrial();
    missingSessions.clientSummary.sessionCompleted = 8;
    expect(evaluateChaosTrial(missingSessions)).toMatchObject({ validity: 'inconclusive', reasons: ['Insufficient session samples.'] });

    const missingPostgresCanaries = chaosTrial();
    missingPostgresCanaries.clientSummary.postgresCanaryCompleted = 8;
    expect(evaluateChaosTrial(missingPostgresCanaries)).toMatchObject({ validity: 'inconclusive', reasons: ['Insufficient Postgres canary samples.'] });

    const truncatedChaos = chaosTrial();
    truncatedChaos.artifacts = [{ id: 'spans', kind: 'spans', sizeBytes: 10, sha256: contentHash, truncated: true, available: true }];
    expect(evaluateChaosTrial(truncatedChaos)).toMatchObject({ validity: 'inconclusive', reasons: ['Required evidence is incomplete.'] });

    const overflowedSpans = chaosTrial();
    overflowedSpans.spans = [
      ...overflowedSpans.spans,
      ...Array.from({ length: 3000 - overflowedSpans.spans.length }, (_, index) => ({
        id: `extra-span-${index}`,
        kind: 'server' as const,
        traceId: 'trace-extra',
        serviceId: 'frontend' as const,
        channel: 'business' as const,
        startedAt: timestamp,
        durationMs: 10,
        faultApplied: false
      }))
    ];
    expect(evaluateChaosTrial(overflowedSpans)).toMatchObject({ validity: 'inconclusive', reasons: ['Required evidence is incomplete.'] });

    const spanDerivedFailing = chaosTrial();
    delete spanDerivedFailing.clientSummary.sessionCompleted;
    delete spanDerivedFailing.clientSummary.redisCanaryCompleted;
    delete spanDerivedFailing.clientSummary.postgresCanaryCompleted;
    expect(evaluateChaosTrial(spanDerivedFailing)).toMatchObject({
      validity: 'inconclusive',
      reasons: [
        'Insufficient session samples.',
        'Insufficient Redis canary samples.',
        'Insufficient Postgres canary samples.'
      ]
    });

    const spanDerivedPassing = chaosTrial();
    delete spanDerivedPassing.clientSummary.sessionCompleted;
    delete spanDerivedPassing.clientSummary.redisCanaryCompleted;
    delete spanDerivedPassing.clientSummary.postgresCanaryCompleted;
    for (let index = 0; index < 9; index += 1) {
      spanDerivedPassing.spans.push(
        { id: `session-span-${index}`, kind: 'server', traceId: `session-trace-${index}`, serviceId: 'frontend', channel: 'business', startedAt: timestamp, durationMs: 10, faultApplied: false },
        { id: `redis-canary-span-${index}`, kind: 'server', traceId: `redis-canary-trace-${index}`, serviceId: 'redis-cache', channel: 'canary', startedAt: timestamp, durationMs: 10, faultApplied: false },
        { id: `postgres-canary-span-${index}`, kind: 'server', traceId: `postgres-canary-trace-${index}`, serviceId: 'postgres-db', channel: 'canary', startedAt: timestamp, durationMs: 10, faultApplied: false }
      );
    }
    expect(evaluateChaosTrial(spanDerivedPassing)).toEqual({ validity: 'valid', reasons: [] });
  });
});

describe('matched trial blast-radius evaluation', () => {
  it('uses status rank, configured Redis paths, and shared witnessed business traces', () => {
    const result = evaluateMatchedPairAndBlastRadius(controlTrial(), chaosTrial());
    expect(result.comparisonValidity).toBe('valid');
    expect(result.actualBlastRadiusIds).toEqual(['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache']);
    expect(result.observedCascadeEdges).toEqual([
      expect.objectContaining({ source: 'order-service', target: 'frontend', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'payment-service', target: 'order-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'redis-cache', target: 'auth-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'auth-service', target: 'payment-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' })
    ]);
    expect(result.observedCascadeEdges).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'auth-service', target: 'frontend' })
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

    const degradedPostgres = chaosTrial();
    degradedPostgres.metrics = degradedPostgres.metrics.map((value) => value.serviceId === 'postgres-db' ? metric('postgres-db', 'DEGRADED') : value);
    degradedPostgres.spans.push({ id: 'span-postgres', kind: 'server', traceId: 'trace-1', serviceId: 'postgres-db', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false });
    const postgresResult = evaluateMatchedPairAndBlastRadius(controlTrial(), degradedPostgres);
    expect(postgresResult.comparisonValidity).toBe('valid');
    expect(postgresResult.actualBlastRadiusIds).not.toContain('postgres-db');

    const unlinkedOrder = chaosTrial();
    unlinkedOrder.spans = [
      { id: 'span-payment', kind: 'server', traceId: 'trace-1', serviceId: 'payment-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'client-payment-auth', kind: 'client', traceId: 'trace-1', serviceId: 'payment-service', downstreamId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'span-auth', kind: 'server', traceId: 'trace-1', serviceId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'client-auth-redis', kind: 'client', traceId: 'trace-1', serviceId: 'auth-service', downstreamId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'span-redis-witness', kind: 'server', traceId: 'trace-1', serviceId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: true },
      { id: 'span-order-unlinked', kind: 'server', traceId: 'trace-2', serviceId: 'order-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false }
    ];
    const unlinkedOrderResult = evaluateMatchedPairAndBlastRadius(controlTrial(), unlinkedOrder);
    expect(unlinkedOrderResult.comparisonValidity).toBe('valid');
    expect(unlinkedOrderResult.actualBlastRadiusIds).not.toContain('order-service');

    const withSessionWitness = chaosTrial();
    withSessionWitness.spans.push(
      { id: 'span-session-frontend', kind: 'server', traceId: 'trace-session', serviceId: 'frontend', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'client-session-frontend-auth', kind: 'client', traceId: 'trace-session', serviceId: 'frontend', downstreamId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'span-session-auth', kind: 'server', traceId: 'trace-session', serviceId: 'auth-service', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'client-session-auth-redis', kind: 'client', traceId: 'trace-session', serviceId: 'auth-service', downstreamId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: false },
      { id: 'span-session-redis-witness', kind: 'server', traceId: 'trace-session', serviceId: 'redis-cache', channel: 'business', startedAt: timestamp, durationMs: 3000, faultApplied: true }
    );
    const sessionEdgeResult = evaluateMatchedPairAndBlastRadius(controlTrial(), withSessionWitness);
    expect(sessionEdgeResult.observedCascadeEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'auth-service', target: 'frontend', relationship: 'CASCADED_TO', evidenceKind: 'observed' })
    ]));
  });

  it('returns inconclusive, not zero impact, when witness or matched identity gates fail', () => {
    const missingWitness = chaosTrial();
    missingWitness.spans = [];
    missingWitness.faultWitnessed = false;
    const witnessResult = evaluateMatchedPairAndBlastRadius(controlTrial(), missingWitness);
    expect(witnessResult).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });

    const mismatchedWorkload = chaosTrial();
    mismatchedWorkload.workloadHash = 'c'.repeat(64);
    expect(evaluateMatchedPairAndBlastRadius(controlTrial(), mismatchedWorkload)).toMatchObject({
      comparisonValidity: 'inconclusive',
      comparisonReasons: ['Matched trials have different immutable identities.'],
      actualBlastRadiusIds: []
    });

    const mismatchedRun = chaosTrial();
    mismatchedRun.runId = 'another-run';
    expect(evaluateMatchedPairAndBlastRadius(controlTrial(), mismatchedRun)).toMatchObject({
      comparisonValidity: 'inconclusive',
      comparisonReasons: ['Matched trials have different immutable identities.'],
      actualBlastRadiusIds: []
    });

    const mismatchedMode = chaosTrial();
    mismatchedMode.executionMode = 'daytona';
    expect(evaluateMatchedPairAndBlastRadius(controlTrial(), mismatchedMode)).toMatchObject({
      comparisonValidity: 'inconclusive',
      comparisonReasons: ['Matched trials have different execution modes.'],
      actualBlastRadiusIds: []
    });

    const mismatchedKinds = chaosTrial();
    mismatchedKinds.kind = 'reproduction-chaos';
    expect(evaluateMatchedPairAndBlastRadius(controlTrial(), mismatchedKinds)).toMatchObject({
      comparisonValidity: 'inconclusive',
      comparisonReasons: ['Matched trials have incompatible kinds.'],
      actualBlastRadiusIds: []
    });
  });
});

describe('reproduction classification', () => {
  it('classifies reproduced, partial, not reproduced, and inconclusive pairs', () => {
    const originalControl = controlTrial();
    const originalChaos = chaosTrial();
    const original = runSnapshot(originalControl, originalChaos);

    const reproducedPair = reproductionTrials();
    expect(classifyReproduction(original, reproducedPair.control, reproducedPair.chaos).classification).toBe('reproduced');

    const partialPair = reproductionTrials();
    partialPair.chaos.metrics = partialPair.chaos.metrics.map((value) => value.serviceId === 'redis-cache' ? value : metric(value.serviceId));
    partialPair.chaos.clientSummary.checkoutErrors = 10;
    partialPair.chaos.clientSummary.checkoutErrorRate = 0.1;
    expect(classifyReproduction(original, partialPair.control, partialPair.chaos).classification).toBe('partial');

    const noImpactPair = reproductionTrials();
    noImpactPair.chaos.metrics = noImpactPair.chaos.metrics.map((value) => metric(value.serviceId));
    noImpactPair.chaos.clientSummary.checkoutErrors = 0;
    noImpactPair.chaos.clientSummary.checkoutErrorRate = 0;
    expect(classifyReproduction(original, noImpactPair.control, noImpactPair.chaos).classification).toBe('not_reproduced');

    const invalidPair = reproductionTrials();
    invalidPair.chaos.faultWitnessed = false;
    invalidPair.chaos.spans = [];
    const invalidResult = classifyReproduction(original, invalidPair.control, invalidPair.chaos);
    expect(invalidResult.classification).toBe('inconclusive');
    expect(invalidResult.reasons).toContain('Chaos trial did not record a fault witness.');

    const mismatchedIdentityPair = reproductionTrials();
    mismatchedIdentityPair.chaos.payloadHash = 'c'.repeat(64);
    const identityResult = classifyReproduction(original, mismatchedIdentityPair.control, mismatchedIdentityPair.chaos);
    expect(identityResult).toMatchObject({ classification: 'inconclusive', reasons: ['Reproduction pair identities do not match the original pair.'] });

    expect(classifyReproduction(original, controlTrial(), chaosTrial())).toMatchObject({
      classification: 'inconclusive',
      reasons: ['Reproduction trials must use reproduction-control and reproduction-chaos kinds.']
    });

    const reusedIdsPair = reproductionTrials();
    reusedIdsPair.control.id = originalControl.id;
    expect(classifyReproduction(original, reusedIdsPair.control, reusedIdsPair.chaos)).toMatchObject({
      classification: 'inconclusive',
      reasons: ['Reproduction trials must have new trial IDs.']
    });

    const mismatchedModePair = reproductionTrials();
    mismatchedModePair.chaos.executionMode = 'daytona';
    expect(classifyReproduction(original, mismatchedModePair.control, mismatchedModePair.chaos)).toMatchObject({
      classification: 'inconclusive',
      reasons: ['Reproduction pair execution modes do not match the original pair.']
    });

    const invalidOriginal = { ...original, comparisonValidity: 'inconclusive' as const, comparisonReasons: ['Original control failed.'] };
    expect(classifyReproduction(invalidOriginal, reproducedPair.control, reproducedPair.chaos)).toMatchObject({
      classification: 'inconclusive',
      reasons: ['Original control failed.']
    });

    const missingOriginalTrials = { ...original, trials: [originalControl] };
    expect(classifyReproduction(missingOriginalTrials, reproducedPair.control, reproducedPair.chaos)).toMatchObject({
      classification: 'inconclusive',
      reasons: ['Original run does not contain a matched control and chaos pair.']
    });
  });
});
