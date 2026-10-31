import { describe, expect, it } from 'vitest';

import {
  DiagnosticSessionSchema,
  PRIMARY_CHANNEL_BY_SERVICE,
  SERVICE_REGISTRY,
  ValidatedEvidenceInputSchema,
  classifyReproduction,
  evaluateBaselineTrial,
  evaluateMatchedPairAndBlastRadius,
  type DiagnosticPromptContext,
  type RequestSpan,
  type ServiceId,
  type ServiceMetric,
  type TrialTelemetry
} from '../../shared/types.js';
import { NosanaClient } from './agent/nosanaClient.js';
import { Neo4jGraphRepository } from './graph/neo4jClient.js';

const SOURCE_SHA = 'a'.repeat(40);
const PAYLOAD_HASH = 'b'.repeat(64);
const WORKLOAD_HASH = 'c'.repeat(64);
const TOPOLOGY_HASH = 'd'.repeat(64);
const TIME = '2026-01-01T00:00:00.000Z';

function buildMetrics(trialId: string, degraded: ServiceId[] = []): ServiceMetric[] {
  return SERVICE_REGISTRY.map((service) => {
    const channel = PRIMARY_CHANNEL_BY_SERVICE[service.id];
    const isDegraded = degraded.includes(service.id);
    const errorsTotal = isDegraded ? 30 : 0;
    return {
      id: `${trialId}:${service.id}:${channel}`,
      serviceId: service.id,
      channel,
      status: isDegraded ? 'DEGRADED' : 'HEALTHY',
      requestsStarted: 100,
      requestsCompleted: 100,
      errorsTotal,
      timeoutsTotal: errorsTotal,
      errorRate: errorsTotal / 100,
      latencyP50Ms: isDegraded ? 1200 : 12,
      latencyP95Ms: isDegraded ? 3100 : 25,
      latencyP99Ms: isDegraded ? 3200 : 30,
      sampleCount: 100,
      smallSample: false,
      ...(service.id === 'payment-service'
        ? { activeSlotsPeak: 4, longestSaturatedIntervalMs: isDegraded ? 900 : 0, queueLengthPeak: isDegraded ? 4 : 0, requestsQueued: isDegraded ? 18 : 0, queueRejected: isDegraded ? 12 : 0 }
        : {})
    };
  });
}

function buildChaosSpans(): RequestSpan[] {
  const checkoutTrace = 'trace-checkout-1';
  const checkoutSpans: RequestSpan[] = [
    { id: 'span-frontend-server', kind: 'server', traceId: checkoutTrace, serviceId: 'frontend', channel: 'business', startedAt: TIME, durationMs: 3110, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-frontend-client', kind: 'client', traceId: checkoutTrace, parentSpanId: 'span-frontend-server', serviceId: 'frontend', downstreamId: 'order-service', channel: 'business', startedAt: TIME, durationMs: 3100, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-order-server', kind: 'server', traceId: checkoutTrace, parentSpanId: 'span-frontend-client', serviceId: 'order-service', channel: 'business', startedAt: TIME, durationMs: 3090, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-order-client', kind: 'client', traceId: checkoutTrace, parentSpanId: 'span-order-server', serviceId: 'order-service', downstreamId: 'payment-service', channel: 'business', startedAt: TIME, durationMs: 3080, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-payment-server', kind: 'server', traceId: checkoutTrace, parentSpanId: 'span-order-client', serviceId: 'payment-service', channel: 'business', startedAt: TIME, durationMs: 3060, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-payment-client', kind: 'client', traceId: checkoutTrace, parentSpanId: 'span-payment-server', serviceId: 'payment-service', downstreamId: 'auth-service', channel: 'business', startedAt: TIME, durationMs: 3050, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-auth-server', kind: 'server', traceId: checkoutTrace, parentSpanId: 'span-payment-client', serviceId: 'auth-service', channel: 'business', startedAt: TIME, durationMs: 3030, statusCode: 504, errorClass: 'timeout', faultApplied: false },
    { id: 'span-auth-client', kind: 'client', traceId: checkoutTrace, parentSpanId: 'span-auth-server', serviceId: 'auth-service', downstreamId: 'redis-cache', channel: 'business', startedAt: TIME, durationMs: 3020, statusCode: 200, faultApplied: false },
    { id: 'span-redis-witness', kind: 'server', traceId: checkoutTrace, parentSpanId: 'span-auth-client', serviceId: 'redis-cache', channel: 'business', startedAt: TIME, durationMs: 3000, statusCode: 200, faultApplied: true }
  ];
  const sessionSpans = Array.from({ length: 10 }, (_, index): RequestSpan[] => {
    const traceId = `trace-session-${index}`;
    const frontendServer = `span-session-frontend-server-${index}`;
    const frontendClient = `span-session-frontend-client-${index}`;
    const authServer = `span-session-auth-server-${index}`;
    const authClient = `span-session-auth-client-${index}`;
    return [
      { id: frontendServer, kind: 'server', traceId, serviceId: 'frontend', channel: 'business', startedAt: TIME, durationMs: 3040, statusCode: 504, errorClass: 'timeout', faultApplied: false },
      { id: frontendClient, kind: 'client', traceId, parentSpanId: frontendServer, serviceId: 'frontend', downstreamId: 'auth-service', channel: 'business', startedAt: TIME, durationMs: 3030, statusCode: 504, errorClass: 'timeout', faultApplied: false },
      { id: authServer, kind: 'server', traceId, parentSpanId: frontendClient, serviceId: 'auth-service', channel: 'business', startedAt: TIME, durationMs: 3020, statusCode: 504, errorClass: 'timeout', faultApplied: false },
      { id: authClient, kind: 'client', traceId, parentSpanId: authServer, serviceId: 'auth-service', downstreamId: 'redis-cache', channel: 'business', startedAt: TIME, durationMs: 3010, statusCode: 200, faultApplied: false },
      { id: `span-session-redis-witness-${index}`, kind: 'server', traceId, parentSpanId: authClient, serviceId: 'redis-cache', channel: 'business', startedAt: TIME, durationMs: 3000, statusCode: 200, faultApplied: true }
    ];
  }).flat();
  const redisCanarySpans = Array.from({ length: 10 }, (_, index): RequestSpan => ({
    id: `span-redis-canary-${index}`, kind: 'server', traceId: `trace-redis-canary-${index}`, serviceId: 'redis-cache', channel: 'canary', startedAt: TIME, durationMs: 3000, statusCode: 200, faultApplied: true
  }));
  const postgresCanarySpans = Array.from({ length: 10 }, (_, index): RequestSpan => ({
    id: `span-postgres-canary-${index}`, kind: 'server', traceId: `trace-postgres-canary-${index}`, serviceId: 'postgres-db', channel: 'canary', startedAt: TIME, durationMs: 10, statusCode: 200, faultApplied: false
  }));
  return [...checkoutSpans, ...sessionSpans, ...redisCanarySpans, ...postgresCanarySpans];
}

function buildTrial(runId: string, id: string, kind: TrialTelemetry['kind'], degraded: ServiceId[] = []): TrialTelemetry {
  const isChaos = kind === 'chaos' || kind === 'reproduction-chaos';
  const checkoutErrors = isChaos ? 30 : 0;
  return {
    id,
    runId,
    kind,
    status: 'COMPLETED',
    executionMode: 'daytona',
    sandboxId: `sandbox-${id}`,
    cleanupStatus: 'DELETED',
    startedAt: TIME,
    finishedAt: TIME,
    sourceSha: SOURCE_SHA,
    payloadHash: PAYLOAD_HASH,
    workloadHash: WORKLOAD_HASH,
    runtimeIdentity: 'node-v22.22.2',
    faultWitnessed: isChaos,
    metrics: buildMetrics(id, degraded),
    spans: isChaos ? buildChaosSpans() : [],
    artifacts: [],
    clientSummary: {
      scheduled: 130,
      started: 130,
      completed: 130,
      skipped: 0,
      errors: checkoutErrors,
      checkoutStarted: 100,
      checkoutCompleted: 100,
      checkoutErrors,
      checkoutErrorRate: checkoutErrors / 100,
      checkoutP95Ms: isChaos ? 3100 : 25
    },
    validity: 'valid',
    warnings: []
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 180 } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('Lane B contract and repository state-flow integration test (in-memory Neo4j + stubbed Nosana)', () => {
  it('verifies topology seeding, hypothesis, baseline, matched pair comparison, analysis, reproduction, and diagnostic state persistence', async () => {
    let idCounter = 0;
    const repository = new Neo4jGraphRepository({
      inMemory: true,
      createId: () => `entity-${++idCounter}`,
      now: () => TIME
    });

    const capturedPrompts: string[] = [];
    const responses: Response[] = [
      jsonResponse({
        title: 'Redis latency spike saturates Payment concurrency gate',
        question: 'Does a 3,000 ms Redis delay propagate through Auth and Payment to checkout?',
        targetServiceId: 'redis-cache',
        faultType: 'LATENCY_SPIKE',
        faultParams: { delayMs: 3000, durationSec: 10 },
        predictedBlastRadiusIds: ['redis-cache', 'auth-service', 'payment-service', 'order-service', 'frontend'],
        rationale: 'Synchronous token verification on Redis holds Payment slots and cascades upstream.'
      }),
      jsonResponse({
        summary: 'Observed 3,000 ms Redis witness spans caused Payment gate saturation and 30% checkout failures.',
        hypotheses: [
          {
            explanation: 'Auth token reads waited on delayed Redis responses, exhausting Payment active slots.',
            metricIds: ['trial-chaos:payment-service:business', 'trial-chaos:redis-cache:canary'],
            spanIds: ['span-redis-witness', 'span-payment-client']
          }
        ],
        remediation: [
          {
            proposal: 'Bound Auth-to-Redis timeout below Payment queue budget and isolate token cache checks.',
            limitation: 'Proposed advice only; fail-closed authentication still rejects unverified tokens during outages.',
            metricIds: ['trial-chaos:payment-service:business']
          }
        ]
      }),
      jsonResponse({ action: 'read_evidence' }),
      jsonResponse({
        action: 'finish',
        summary: 'Confirmed Payment queue saturation and delayed Redis witness trace in uploaded diagnostic bundle.',
        metricIds: ['trial-chaos:payment-service:business'],
        spanIds: ['span-redis-witness']
      })
    ];

    const nosana = new NosanaClient({
      baseUrl: 'https://nosana.example/v1',
      apiKey: 'test-nosana-key',
      model: 'nosana-pinned-model',
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
        capturedPrompts.push(body.messages[0]?.content ?? '');
        return responses.shift() ?? jsonResponse({});
      },
      createId: () => `nosana-${++idCounter}`,
      now: () => Date.parse(TIME)
    });

    // 1. Seed topology, create run with operationKey idempotency, retrieve risk context, and save hypothesis.
    const templateGraph = await repository.seedTopology();
    expect(templateGraph.nodes).toHaveLength(6);
    expect(templateGraph.edges).toHaveLength(6);

    const operationKey = '11111111-1111-4111-8111-111111111111';
    const createdRun = await repository.createRun({
      id: 'run-live-1',
      sourceSha: SOURCE_SHA,
      payloadHash: PAYLOAD_HASH,
      topologyHash: TOPOLOGY_HASH,
      operationKey
    });
    const duplicateRun = await repository.createRun({
      id: 'run-live-duplicate',
      sourceSha: SOURCE_SHA,
      payloadHash: PAYLOAD_HASH,
      topologyHash: TOPOLOGY_HASH,
      operationKey
    });
    expect(duplicateRun.id).toBe('run-live-1');

    const riskContext = await repository.retrieveRiskContext(createdRun.id);
    expect(riskContext.pathsToRedis.length).toBeGreaterThan(0);

    const hypothesis = await nosana.hypothesize(riskContext);
    expect(hypothesis.source).toBe('nosana');
    expect(capturedPrompts[0]).toContain('"retrievedPaths"');
    expect(capturedPrompts[0]).toContain('"redis-cache"');
    await repository.saveHypothesis(createdRun.id, hypothesis);

    // 2. Run baseline trial, evaluate baseline quality, and persist.
    const baselineTrial = buildTrial(createdRun.id, 'trial-baseline', 'baseline');
    expect(evaluateBaselineTrial(baselineTrial)).toEqual({ validity: 'valid', reasons: [] });
    await repository.saveTrial(baselineTrial);

    // 3. Save control and chaos trials in parallel, evaluate blast radius, and persist comparison.
    const affectedServices: ServiceId[] = ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache'];
    const controlTrial = buildTrial(createdRun.id, 'trial-control', 'control');
    const chaosTrial = buildTrial(createdRun.id, 'trial-chaos', 'chaos', affectedServices);
    await Promise.all([repository.saveTrial(controlTrial), repository.saveTrial(chaosTrial)]);

    const comparison = evaluateMatchedPairAndBlastRadius(controlTrial, chaosTrial, templateGraph);
    expect(comparison.comparisonValidity).toBe('valid');
    expect(comparison.actualBlastRadiusIds).toEqual(affectedServices);
    expect(comparison.observedCascadeEdges.map((edge) => `${edge.source}->${edge.target}`)).toEqual([
      'order-service->frontend',
      'payment-service->order-service',
      'auth-service->frontend',
      'redis-cache->auth-service',
      'auth-service->payment-service'
    ]);

    await repository.saveComparison(createdRun.id, comparison);
    const snapshotAfterComparison = await repository.getRun(createdRun.id);
    const measuredGraph = await repository.getGraph({ runId: createdRun.id });
    expect(snapshotAfterComparison?.actualBlastRadiusIds).toEqual(affectedServices);
    expect(measuredGraph.nodes.find((node) => node.id === 'payment-service')?.status).toBe('DEGRADED');
    expect(measuredGraph.nodes.find((node) => node.id === 'postgres-db')?.status).toBe('HEALTHY');
    expect(measuredGraph.edges.filter((edge) => edge.relationship === 'CASCADED_TO')).toHaveLength(5);

    // 4. Run Nosana evidence analysis citing real persisted metricIds and spanIds, then save.
    const persistedChaos = snapshotAfterComparison!.trials.find((trial) => trial.id === 'trial-chaos')!;
    const persistedControl = snapshotAfterComparison!.trials.find((trial) => trial.id === 'trial-control')!;
    const validatedEvidence = ValidatedEvidenceInputSchema.parse({
      run: snapshotAfterComparison,
      control: persistedControl,
      chaos: persistedChaos,
      comparison,
      metricIds: persistedChaos.metrics.map((metric) => metric.id),
      spanIds: persistedChaos.spans.slice(0, 10).map((span) => span.id)
    });

    const analysis = await nosana.analyze(validatedEvidence);
    expect(analysis.status).toBe('available');
    expect(analysis.source).toBe('nosana');
    expect(analysis.model).toBe('nosana-pinned-model');
    expect(capturedPrompts[1]).toContain('"checkoutErrorRate":0.3');
    expect(capturedPrompts[1]).toContain('"checkoutP95Ms":3100');
    await repository.saveAnalysis(createdRun.id, analysis);
    expect((await repository.getRun(createdRun.id))?.analysis?.id).toBe(analysis.id);

    // 5. Run reproduction control + chaos trials, classify reproduction, and verify isolation of original blast radius.
    const reproControl = buildTrial(createdRun.id, 'trial-repro-control', 'reproduction-control');
    const reproChaos = buildTrial(createdRun.id, 'trial-repro-chaos', 'reproduction-chaos', affectedServices);
    await Promise.all([repository.saveTrial(reproControl), repository.saveTrial(reproChaos)]);

    const currentRun = (await repository.getRun(createdRun.id))!;
    const reproSummary = classifyReproduction(currentRun, reproControl, reproChaos);
    expect(reproSummary.classification).toBe('reproduced');

    const reproComparison = evaluateMatchedPairAndBlastRadius(reproControl, reproChaos, currentRun.graph);
    await repository.saveComparison(createdRun.id, reproComparison, {
      controlTrialId: reproControl.id,
      chaosTrialId: reproChaos.id
    });

    const snapshotAfterRepro = (await repository.getRun(createdRun.id))!;
    expect(snapshotAfterRepro.actualBlastRadiusIds).toEqual(affectedServices);
    expect(snapshotAfterRepro.reproduction?.classification).toBe('reproduced');
    expect(snapshotAfterRepro.graph.edges.filter((edge) => edge.relationship === 'CASCADED_TO').every((edge) => edge.id.includes(':trial-chaos:'))).toBe(true);

    const reproGraph = await repository.getGraph({ runId: createdRun.id, trialId: reproChaos.id });
    expect(reproGraph.edges.filter((edge) => edge.relationship === 'CASCADED_TO').every((edge) => edge.id.includes(':trial-repro-chaos:'))).toBe(true);

    // 6. Execute Nosana diagnostic loop (read_evidence -> finish) and persist diagnostic session.
    const baseDiagnosticContext: DiagnosticPromptContext = {
      runId: createdRun.id,
      diagnosticId: 'diag-1',
      allowedServiceIds: SERVICE_REGISTRY.map((service) => service.id),
      evidence: validatedEvidence
    };
    const firstAction = await nosana.nextDiagnosticAction(baseDiagnosticContext);
    expect(firstAction).toEqual({ action: 'read_evidence' });

    const secondAction = await nosana.nextDiagnosticAction({
      ...baseDiagnosticContext,
      toolTrace: [
        {
          id: 'trace-1',
          action: 'read_evidence',
          toolName: 'daytona_read_file',
          success: true,
          startedAt: TIME,
          finishedAt: TIME,
          elapsedMs: 45,
          argumentSummary: '{"path":".entropy-diagnostic/evidence.json"}',
          resultSummary: '{"paymentQueuePeak":4,"witnessCount":1}'
        }
      ]
    });
    expect(secondAction).toMatchObject({
      action: 'finish',
      metricIds: ['trial-chaos:payment-service:business'],
      spanIds: ['span-redis-witness']
    });

    const diagnosticSession = DiagnosticSessionSchema.parse({
      id: 'diag-1',
      runId: createdRun.id,
      sandboxId: 'sandbox-diag-1',
      status: 'COMPLETED',
      cleanupStatus: 'DELETED',
      createdAt: TIME,
      finishedAt: TIME,
      toolTrace: [
        {
          id: 'trace-1',
          action: 'read_evidence',
          toolName: 'daytona_read_file',
          success: true,
          startedAt: TIME,
          finishedAt: TIME,
          elapsedMs: 45,
          argumentSummary: '{"path":".entropy-diagnostic/evidence.json"}',
          resultSummary: '{"paymentQueuePeak":4,"witnessCount":1}'
        }
      ],
      finalExplanation: secondAction.action === 'finish' ? secondAction.summary : undefined,
      analysis
    });
    await repository.saveDiagnostic(diagnosticSession);
    expect(await repository.getDiagnostic('diag-1')).toEqual(diagnosticSession);
  });
});
