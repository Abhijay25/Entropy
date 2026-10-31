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
import { realTrial, withRecomputedMetrics } from './fixtures/realTrials.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const sourceSha = 'a'.repeat(40);
const contentHash = 'b'.repeat(64);
const serviceIds: readonly ServiceId[] = ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache', 'postgres-db'];

function controlTrial(): TrialTelemetry {
  return realTrial('control', { id: 'control-trial', runId: 'run-1', sourceSha, payloadHash: contentHash, workloadHash: contentHash, runtimeIdentity: 'node-22' });
}

function chaosTrial(): TrialTelemetry {
  return realTrial('chaos', { id: 'chaos-trial', runId: 'run-1', sourceSha, payloadHash: contentHash, workloadHash: contentHash, runtimeIdentity: 'node-22' });
}

function reproductionTrials() {
  const identity = { runId: 'run-1', sourceSha, payloadHash: contentHash, workloadHash: contentHash, runtimeIdentity: 'node-22' };
  return {
    control: realTrial('control', { ...identity, id: 'reproduction-control-trial', kind: 'reproduction-control' }),
    chaos: realTrial('chaos', { ...identity, id: 'reproduction-chaos-trial', kind: 'reproduction-chaos' })
  };
}

/** Edits matching server spans, then recomputes metrics so the report stays self-consistent. */
function editServerSpans(trial: TrialTelemetry, match: (span: TrialTelemetry['spans'][number]) => boolean, edit: Partial<TrialTelemetry['spans'][number]>, gate?: Parameters<typeof withRecomputedMetrics>[1]): TrialTelemetry {
  return withRecomputedMetrics({ ...trial, spans: trial.spans.map((span) => span.kind === 'server' && match(span) ? { ...span, ...edit } : span) }, gate);
}

const withTruncatedSpans = (trial: TrialTelemetry): TrialTelemetry => ({ ...trial, artifacts: trial.artifacts.map((artifact) => artifact.kind === 'spans' ? { ...artifact, truncated: true } : artifact) });

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

    expect(evaluateBaselineTrial(withTruncatedSpans(controlTrial()))).toMatchObject({ validity: 'inconclusive', reasons: ['Required spans evidence is unavailable or truncated.'] });

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

    const degradedPrimary = editServerSpans(controlTrial(), (span) => span.serviceId === 'payment-service' && span.channel === 'business', { durationMs: 900 });
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

    expect(evaluateChaosTrial(withTruncatedSpans(chaosTrial()))).toMatchObject({ validity: 'inconclusive', reasons: ['Required spans evidence is unavailable or truncated.'] });

    // Overflow is reported by the payload (validity), not inferred from a full-but-complete span array.
    const overflowed = chaosTrial();
    overflowed.validity = 'inconclusive';
    expect(evaluateChaosTrial(overflowed)).toMatchObject({ validity: 'inconclusive', reasons: ['Chaos report is not valid.'] });

    const spanDerivedFailing = chaosTrial();
    delete spanDerivedFailing.clientSummary.sessionCompleted;
    delete spanDerivedFailing.clientSummary.redisCanaryCompleted;
    delete spanDerivedFailing.clientSummary.postgresCanaryCompleted;
    const checkoutTraces = new Set(spanDerivedFailing.spans.filter((span) => span.serviceId === 'order-service').map((span) => span.traceId));
    spanDerivedFailing.spans = spanDerivedFailing.spans.filter((span) => span.channel === 'business' && checkoutTraces.has(span.traceId));
    expect(evaluateChaosTrial(withRecomputedMetrics(spanDerivedFailing)).reasons).toEqual(expect.arrayContaining([
      'Insufficient session samples.',
      'Insufficient Redis canary samples.',
      'Insufficient Postgres canary samples.'
    ]));

    const spanDerivedPassing = chaosTrial();
    delete spanDerivedPassing.clientSummary.sessionCompleted;
    delete spanDerivedPassing.clientSummary.redisCanaryCompleted;
    delete spanDerivedPassing.clientSummary.postgresCanaryCompleted;
    expect(evaluateChaosTrial(spanDerivedPassing)).toEqual({ validity: 'valid', reasons: [] });
  });
});

describe('matched trial blast-radius evaluation', () => {
  it('uses status rank, configured Redis paths, and shared witnessed business traces', () => {
    const result = evaluateMatchedPairAndBlastRadius(controlTrial(), chaosTrial());
    expect(result.comparisonValidity).toBe('valid');
    expect(result.actualBlastRadiusIds).toEqual(['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache']);
    // The real chaos report contains delayed checkout chains and delayed session chains (Frontend -> Auth -> Redis).
    expect(result.observedCascadeEdges).toEqual([
      expect.objectContaining({ source: 'order-service', target: 'frontend', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'payment-service', target: 'order-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'auth-service', target: 'frontend', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'redis-cache', target: 'auth-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' }),
      expect.objectContaining({ source: 'auth-service', target: 'payment-service', relationship: 'CASCADED_TO', evidenceKind: 'observed' })
    ]);
    const witnessIds = new Set(chaosTrial().spans.filter((span) => span.kind === 'server' && span.serviceId === 'redis-cache' && span.faultApplied).map((span) => span.id));
    expect(result.observedCascadeEdges.every((edge) => edge.supportingSpanIds.some((id) => witnessIds.has(id)))).toBe(true);
    expect(result.actualBlastRadiusIds).not.toContain('postgres-db');
  });

  it('does not infer affected nodes from status alone or compare UNKNOWN samples', () => {
    const withoutLinkedTrace = chaosTrial();
    withoutLinkedTrace.spans = withoutLinkedTrace.spans.filter((span) => span.serviceId === 'redis-cache');
    const noTraceResult = evaluateMatchedPairAndBlastRadius(controlTrial(), withoutLinkedTrace);
    expect(noTraceResult).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });

    // An unsampled node is not "unaffected": the whole comparison becomes inconclusive.
    const unknownAuth = withRecomputedMetrics({ ...chaosTrial(), spans: chaosTrial().spans.filter((span) => !(span.kind === 'server' && span.serviceId === 'auth-service')) });
    const unknownResult = evaluateMatchedPairAndBlastRadius(controlTrial(), unknownAuth);
    expect(unknownResult).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });
    expect(unknownResult.comparisonReasons).toContain('Primary metric for auth-service has no samples; impact cannot be evaluated.');

    // Off-path degradation (Postgres canary slow, but on no delayed-Redis chain) is not attributed to the fault.
    const degradedPostgres = editServerSpans(chaosTrial(), (span) => span.serviceId === 'postgres-db' && span.channel === 'canary', { durationMs: 3000 });
    expect(degradedPostgres.metrics.find((value) => value.serviceId === 'postgres-db' && value.channel === 'canary')?.status).toBe('DEGRADED');
    const postgresResult = evaluateMatchedPairAndBlastRadius(controlTrial(), degradedPostgres);
    expect(postgresResult.comparisonValidity).toBe('valid');
    expect(postgresResult.actualBlastRadiusIds).not.toContain('postgres-db');

    // Delayed Redis spans whose parent links are broken form no causal chain, so nothing is attributed.
    const brokenAncestry = chaosTrial();
    brokenAncestry.spans = brokenAncestry.spans.map((span) => span.kind === 'server' && span.serviceId === 'redis-cache' && span.faultApplied ? { ...span, parentSpanId: 'not-a-real-span' } : span);
    expect(evaluateMatchedPairAndBlastRadius(controlTrial(), brokenAncestry)).toMatchObject({ comparisonValidity: 'inconclusive', actualBlastRadiusIds: [] });

    // A client span marked faultApplied is never a witness; only the receiving Redis server span is.
    const clientOnlyWitness = chaosTrial();
    clientOnlyWitness.spans = clientOnlyWitness.spans.map((span) => span.kind === 'server' && span.serviceId === 'redis-cache' ? { ...span, faultApplied: false } : span.kind === 'client' && span.downstreamId === 'redis-cache' ? { ...span, faultApplied: true } : span);
    expect(evaluateMatchedPairAndBlastRadius(controlTrial(), clientOnlyWitness).comparisonValidity).toBe('inconclusive');
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
    partialPair.chaos = editServerSpans(partialPair.chaos, (span) => span.serviceId === 'auth-service', { durationMs: 5 });
    expect(classifyReproduction(original, partialPair.control, partialPair.chaos).classification).toBe('partial');

    const noImpactPair = reproductionTrials();
    noImpactPair.chaos = editServerSpans(noImpactPair.chaos, () => true, { durationMs: 5, statusCode: 200, errorClass: undefined }, { requestsQueued: 0, queueRejected: 0, longestSaturatedIntervalMs: 0 });
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

describe('fail-closed blast radius (audit P0-1/P0-3)', () => {
  const baseline = () => evaluateMatchedPairAndBlastRadius(controlTrial(), chaosTrial());
  const primaryIds: readonly ServiceId[] = ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache', 'postgres-db'];
  const primaryChannel = (serviceId: ServiceId) => serviceId === 'redis-cache' || serviceId === 'postgres-db' ? 'canary' : 'business';
  const expectNotValid = (chaos: TrialTelemetry) => {
    const result = evaluateMatchedPairAndBlastRadius(controlTrial(), chaos);
    expect(result.comparisonValidity).toBe('inconclusive');
    expect(result.actualBlastRadiusIds).toEqual([]);
  };

  it('measures five affected nodes on the real pair', () => {
    expect(baseline()).toMatchObject({ comparisonValidity: 'valid', actualBlastRadiusIds: ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache'] });
  });

  it.each(primaryIds)('removing the %s primary metric never yields a valid smaller radius', (serviceId) => {
    const chaos = chaosTrial();
    chaos.metrics = chaos.metrics.filter((metric) => !(metric.serviceId === serviceId && metric.channel === primaryChannel(serviceId)));
    expectNotValid(chaos);
    const control = controlTrial();
    control.metrics = control.metrics.filter((metric) => !(metric.serviceId === serviceId && metric.channel === primaryChannel(serviceId)));
    expect(evaluateMatchedPairAndBlastRadius(control, chaosTrial()).comparisonValidity).toBe('inconclusive');
  });

  it('rejects an UNKNOWN label on a sampled metric and a duplicated metric row', () => {
    const unknownLabel = chaosTrial();
    unknownLabel.metrics = unknownLabel.metrics.map((metric) => metric.serviceId === 'auth-service' && metric.channel === 'business' ? { ...metric, status: 'UNKNOWN' as const } : metric);
    expectNotValid(unknownLabel);

    const duplicated = chaosTrial();
    duplicated.metrics = [...duplicated.metrics, duplicated.metrics.find((metric) => metric.serviceId === 'order-service' && metric.channel === 'business')!];
    expectNotValid(duplicated);
  });

  it('never trusts a status label that contradicts its counters (suppression or inflation)', () => {
    const allHealthy = chaosTrial();
    allHealthy.metrics = allHealthy.metrics.map((metric) => metric.sampleCount > 0 ? { ...metric, status: 'HEALTHY' as const } : metric);
    expectNotValid(allHealthy);

    const inflatedControl = controlTrial();
    inflatedControl.metrics = inflatedControl.metrics.map((metric) => metric.serviceId === 'postgres-db' && metric.channel === 'canary' ? { ...metric, status: 'DEGRADED' as const } : metric);
    expect(evaluateMatchedPairAndBlastRadius(inflatedControl, chaosTrial()).comparisonValidity).toBe('inconclusive');

    const inflatedChaos = chaosTrial();
    inflatedChaos.metrics = inflatedChaos.metrics.map((metric) => metric.serviceId === 'postgres-db' && metric.channel === 'canary' ? { ...metric, status: 'DOWN' as const } : metric);
    expectNotValid(inflatedChaos);
  });

  it('rejects sample-count, percentile, and span disagreements', () => {
    const sampleMismatch = chaosTrial();
    sampleMismatch.metrics = sampleMismatch.metrics.map((metric) => metric.serviceId === 'frontend' && metric.channel === 'business' ? { ...metric, sampleCount: metric.sampleCount - 1, smallSample: metric.sampleCount - 1 < 20 } : metric);
    expectNotValid(sampleMismatch);

    const reordered = chaosTrial();
    reordered.metrics = reordered.metrics.map((metric) => metric.serviceId === 'auth-service' && metric.channel === 'business' ? { ...metric, latencyP50Ms: metric.latencyP99Ms, latencyP99Ms: metric.latencyP50Ms } : metric);
    expectNotValid(reordered);

    const invented = chaosTrial();
    invented.metrics = invented.metrics.map((metric) => metric.serviceId === 'auth-service' && metric.channel === 'business' ? { ...metric, latencyP50Ms: 1, latencyP95Ms: 2, latencyP99Ms: 3, status: 'HEALTHY' as const } : metric);
    expectNotValid(invented);

    const droppedSpans = chaosTrial();
    const firstOrderSpan = droppedSpans.spans.findIndex((span) => span.kind === 'server' && span.serviceId === 'order-service');
    droppedSpans.spans = droppedSpans.spans.filter((_, index) => index !== firstOrderSpan);
    expectNotValid(droppedSpans);
  });

  it('treats unfinished handlers as censored, not as fast completions', () => {
    const censored = chaosTrial();
    censored.metrics = censored.metrics.map((metric) => metric.serviceId === 'auth-service' && metric.channel === 'business' ? { ...metric, requestsStarted: metric.requestsStarted + 5 } : metric);
    expectNotValid(censored);
  });

  it('rejects corrupted checkout totals at the schema boundary', () => {
    const report = chaosTrial();
    expect(TrialTelemetrySchema.safeParse({ ...report, clientSummary: { ...report.clientSummary, checkoutCompleted: report.clientSummary.checkoutStarted + 1 } }).success).toBe(false);
    expect(TrialTelemetrySchema.safeParse({ ...report, clientSummary: { ...report.clientSummary, checkoutErrors: report.clientSummary.errors + 1, checkoutErrorRate: (report.clientSummary.errors + 1) / report.clientSummary.checkoutCompleted } }).success).toBe(false);
    expect(TrialTelemetrySchema.safeParse({ ...report, clientSummary: { ...report.clientSummary, sessionCompleted: report.clientSummary.completed + 1 } }).success).toBe(false);
  });

  it('requires every evidence kind to be present and available', () => {
    for (const kind of ['metrics', 'spans', 'fault_witness', 'runtime'] as const) {
      const missing = chaosTrial();
      missing.artifacts = missing.artifacts.filter((artifact) => artifact.kind !== kind);
      expectNotValid(missing);
      const unavailable = chaosTrial();
      unavailable.artifacts = unavailable.artifacts.map((artifact) => artifact.kind === kind ? { ...artifact, available: false } : artifact);
      expectNotValid(unavailable);
    }
    const noArtifacts = chaosTrial();
    noArtifacts.artifacts = [];
    expectNotValid(noArtifacts);
  });

  it('a witness only on canary traffic does not establish a checkout cascade', () => {
    const canaryOnly = chaosTrial();
    canaryOnly.spans = canaryOnly.spans.map((span) => span.kind === 'server' && span.serviceId === 'redis-cache' && span.channel === 'business' ? { ...span, faultApplied: false } : span);
    expectNotValid(canaryOnly);
  });

  it('an entirely healthy no-fault pair is a valid zero-impact negative control only when it carries a witness; otherwise inconclusive', () => {
    const noFault = realTrial('control', { id: 'chaos-trial', runId: 'run-1', kind: 'chaos', sourceSha, payloadHash: contentHash, workloadHash: contentHash, runtimeIdentity: 'node-22' });
    expectNotValid({ ...noFault, faultWitnessed: true });
  });
});
