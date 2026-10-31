import { z } from 'zod';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/);
const text = (maximum: number) => z.string().trim().min(1).max(maximum);
const timestamp = z.string().datetime({ offset: true });
const count = z.number().int().nonnegative();
const duration = z.number().finite().nonnegative();

export const EntityIdSchema = id;
export type EntityId = z.infer<typeof EntityIdSchema>;
export const ServiceIdSchema = z.enum(['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache', 'postgres-db']);
export type ServiceId = z.infer<typeof ServiceIdSchema>;
export const NodeHealthStatusSchema = z.enum(['HEALTHY', 'DEGRADED', 'DOWN', 'UNKNOWN']);
export type NodeHealthStatus = z.infer<typeof NodeHealthStatusSchema>;
export const TrialKindSchema = z.enum(['baseline', 'control', 'chaos', 'reproduction-control', 'reproduction-chaos']);
export type TrialKind = z.infer<typeof TrialKindSchema>;
export const RunStatusSchema = z.enum(['QUEUED', 'HYPOTHESIZING', 'BASELINING', 'RUNNING_TRIALS', 'ANALYZING', 'COMPLETED', 'BASELINE_FAILED', 'INCONCLUSIVE', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const TrialStatusSchema = z.enum(['QUEUED', 'PROVISIONING', 'PREPARING', 'RUNNING', 'COLLECTING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);
export type TrialStatus = z.infer<typeof TrialStatusSchema>;
export const CleanupStatusSchema = z.enum(['NOT_CREATED', 'PENDING', 'DELETED', 'FAILED']);
export type CleanupStatus = z.infer<typeof CleanupStatusSchema>;
export const ComparisonValiditySchema = z.enum(['not_evaluated', 'valid', 'inconclusive']);
export type ComparisonValidity = z.infer<typeof ComparisonValiditySchema>;
export const ReproductionClassificationSchema = z.enum(['reproduced', 'partial', 'not_reproduced', 'inconclusive']);
export type ReproductionClassification = z.infer<typeof ReproductionClassificationSchema>;

export const ServiceNodeSchema = z.object({
  id: ServiceIdSchema,
  name: text(80),
  type: z.enum(['Service', 'Datastore']),
  port: z.number().int().min(1).max(65535),
  mock: z.boolean(),
  status: NodeHealthStatusSchema,
  metricId: id.optional()
}).strict();
export type ServiceNode = z.infer<typeof ServiceNodeSchema>;

const uniqueServiceIds = (minimum = 0) => z.array(ServiceIdSchema).min(minimum).max(6).refine((ids) => new Set(ids).size === ids.length, 'Service IDs must be unique.');

export const DependencyEdgeSchema = z.object({
  id: id,
  source: ServiceIdSchema,
  target: ServiceIdSchema,
  relationship: z.enum(['CALLS', 'READS', 'WRITES', 'VERIFY_TOKEN', 'CASCADED_TO']),
  evidenceKind: z.enum(['configured', 'predicted', 'observed']),
  timeoutMs: duration.optional(),
  circuitBreaker: z.boolean(),
  supportingSpanIds: z.array(id).max(32)
}).strict().superRefine((edge, context) => {
  if (edge.source === edge.target) context.addIssue({ code: 'custom', message: 'Dependency edges require distinct endpoints' });
  if (edge.relationship === 'CASCADED_TO' && (edge.evidenceKind !== 'observed' || edge.supportingSpanIds.length === 0)) {
    context.addIssue({ code: 'custom', message: 'CASCADED_TO edges require observed evidence and supportingSpanIds.' });
  }
  if (edge.evidenceKind === 'observed' && edge.relationship !== 'CASCADED_TO') {
    context.addIssue({ code: 'custom', message: 'Observed edges must use CASCADED_TO relationship.' });
  }
});
export type DependencyEdge = z.infer<typeof DependencyEdgeSchema>;

export const TopologyGraphSchema = z.object({
  runId: id.optional(),
  trialId: id.optional(),
  nodes: z.array(ServiceNodeSchema).length(6),
  edges: z.array(DependencyEdgeSchema).max(18)
}).strict().superRefine((graph, context) => {
  if (new Set(graph.nodes.map((node) => node.id)).size !== 6) context.addIssue({ code: 'custom', message: 'Topology nodes must be unique.' });
});
export type TopologyGraph = z.infer<typeof TopologyGraphSchema>;

export const SERVICE_REGISTRY = [
  { id: 'frontend', name: 'Frontend', type: 'Service', port: 4100, mock: true },
  { id: 'order-service', name: 'OrderService', type: 'Service', port: 4101, mock: true },
  { id: 'payment-service', name: 'PaymentService', type: 'Service', port: 4102, mock: true },
  { id: 'auth-service', name: 'AuthService', type: 'Service', port: 4103, mock: true },
  { id: 'redis-cache', name: 'RedisCache', type: 'Datastore', port: 4104, mock: true },
  { id: 'postgres-db', name: 'PostgresDB', type: 'Datastore', port: 4105, mock: true }
] as const;
export const CONFIGURED_DEPENDENCIES = [
  ['frontend', 'order-service', 'CALLS', 1600],
  ['order-service', 'payment-service', 'CALLS', 1200],
  ['payment-service', 'postgres-db', 'WRITES', undefined],
  ['frontend', 'auth-service', 'CALLS', 800],
  ['auth-service', 'redis-cache', 'READS', 4000],
  ['payment-service', 'auth-service', 'VERIFY_TOKEN', 4500]
] as const;
export const PRIMARY_CHANNEL_BY_SERVICE: Record<ServiceId, 'business' | 'canary'> = {
  frontend: 'business', 'order-service': 'business', 'payment-service': 'business', 'auth-service': 'business', 'redis-cache': 'canary', 'postgres-db': 'canary'
};
export const DEFAULT_CONFIGURED_TOPOLOGY: TopologyGraph = TopologyGraphSchema.parse({
  nodes: SERVICE_REGISTRY.map((node) => ({ ...node, status: 'UNKNOWN' })),
  edges: CONFIGURED_DEPENDENCIES.map(([source, target, relationship, timeoutMs]) => ({
    id: `configured:${source}:${target}`, source, target, relationship, evidenceKind: 'configured', ...(timeoutMs === undefined ? {} : { timeoutMs }), circuitBreaker: false, supportingSpanIds: []
  }))
});

export const SUPPORTED_FAULT = { targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', delayMs: 3000, durationSec: 10, durationMs: 10000 } as const;
export const FaultSchema = z.union([
  z.null(),
  z.object({ targetServiceId: z.literal('redis-cache'), faultType: z.literal('LATENCY_SPIKE'), delayMs: z.literal(3000), durationMs: z.literal(10000) }).strict()
]);
export type Fault = z.infer<typeof FaultSchema>;
export const SCHEDULED_BUSINESS_LAUNCHES = 110;
export const LIMITS = { maxSandboxes: 2, maxSpans: 3000, maxEvents: 250, maxArtifactBytes: 5 * 1024 * 1024, maxArtifactLogBytes: 256 * 1024, maxArtifactReportBytes: 2 * 1024 * 1024, bodyBytes: 16 * 1024, workloadScheduled: 130 } as const;
export const WORKLOAD = { checkoutOffsetsMs: Array.from({ length: 100 }, (_, index) => index * 100), secondaryOffsetsMs: Array.from({ length: 10 }, (_, index) => index * 1000), totalScheduled: 130 } as const;

export const ChaosHypothesisSchema = z.object({
  id, title: text(160), question: text(500), targetServiceId: z.literal('redis-cache'), faultType: z.literal('LATENCY_SPIKE'),
  faultParams: z.object({ delayMs: z.literal(3000), durationSec: z.literal(10) }).strict(),
  predictedBlastRadiusIds: uniqueServiceIds(1), rationale: text(2000), cypherQueryUsed: text(4000), source: z.enum(['nosana', 'catalogue_fallback']), model: text(160).optional()
}).strict();
export type ChaosHypothesis = z.infer<typeof ChaosHypothesisSchema>;
export const ChaosHypothesisDraftSchema = ChaosHypothesisSchema.omit({ id: true, cypherQueryUsed: true, source: true, model: true });
export type ChaosHypothesisDraft = z.infer<typeof ChaosHypothesisDraftSchema>;
export const FIXED_RISK_CYPHER_QUERY = 'MATCH p=(s:Service)-[:CALLS|READS|VERIFY_TOKEN*1..5]->(r:Datastore) WHERE r.key = $redisKey AND all(n IN nodes(p) WHERE n.projectId = $projectId AND n.scope = $scope) RETURN [n IN nodes(p) | n.id] AS path, [e IN relationships(p) | {type: type(e), timeoutMs: e.timeoutMs}] AS edges ORDER BY size(path) DESC LIMIT 10;';
export const CATALOGUE_FALLBACK_HYPOTHESIS: ChaosHypothesis = ChaosHypothesisSchema.parse({ id: 'catalogue-redis-delay', title: 'Redis delay may exhaust Payment capacity', question: 'Will the Redis delay occupy Payment capacity and affect checkout?', targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', faultParams: { delayMs: 3000, durationSec: 10 }, predictedBlastRadiusIds: ['redis-cache', 'auth-service', 'payment-service', 'order-service', 'frontend'], rationale: 'Configured synchronous dependencies connect Redis latency to the checkout path.', cypherQueryUsed: FIXED_RISK_CYPHER_QUERY, source: 'catalogue_fallback' });

export const ServiceMetricSchema = z.object({
  id, serviceId: ServiceIdSchema, channel: z.enum(['business', 'canary']), status: NodeHealthStatusSchema,
  requestsStarted: count, requestsCompleted: count, errorsTotal: count, timeoutsTotal: count,
  errorRate: z.number().min(0).max(1).nullable(), latencyP50Ms: duration.nullable(), latencyP95Ms: duration.nullable(), latencyP99Ms: duration.nullable(), sampleCount: count, smallSample: z.boolean(),
  activeSlotsPeak: count.optional(), longestSaturatedIntervalMs: duration.optional(), queueLengthPeak: count.optional(), requestsQueued: count.optional(), queueRejected: count.optional()
}).strict().superRefine((metric, context) => {
  if (metric.requestsCompleted > metric.requestsStarted) context.addIssue({ code: 'custom', message: 'Completed requests exceed starts.' });
  if (metric.errorsTotal > metric.requestsCompleted || metric.timeoutsTotal > metric.errorsTotal) context.addIssue({ code: 'custom', message: 'Invalid error counters.' });
  const expected = metric.requestsCompleted === 0 ? null : metric.errorsTotal / metric.requestsCompleted;
  if (metric.errorRate !== expected) context.addIssue({ code: 'custom', message: 'errorRate must match counters.' });
  if (metric.smallSample !== (metric.sampleCount < 20)) context.addIssue({ code: 'custom', message: 'smallSample must match sample count.' });
});
export type ServiceMetric = z.infer<typeof ServiceMetricSchema>;

export const RequestSpanSchema = z.object({
  id, kind: z.enum(['server', 'client']), traceId: id, parentSpanId: id.optional(), serviceId: ServiceIdSchema, downstreamId: ServiceIdSchema.optional(), channel: z.enum(['business', 'canary']), startedAt: timestamp, durationMs: duration, statusCode: z.number().int().min(100).max(599).optional(), errorClass: z.enum(['timeout', 'queue_full', 'queue_timeout', 'dependency_error']).optional(), faultApplied: z.boolean()
}).strict();
export type RequestSpan = z.infer<typeof RequestSpanSchema>;
export const ArtifactRefSchema = z.object({ id, kind: z.enum(['metrics', 'spans', 'fault_witness', 'runtime', 'terminal', 'diagnostic']), sizeBytes: count, sha256: z.string().regex(/^[a-f0-9]{64}$/), truncated: z.boolean(), available: z.boolean() }).strict();
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export const ClientSummarySchema = z.object({ scheduled: count, started: count, completed: count, skipped: count, errors: count, checkoutStarted: count, checkoutCompleted: count, checkoutErrors: count, checkoutErrorRate: z.number().min(0).max(1).nullable(), checkoutP95Ms: duration.nullable(), businessSkipped: count.optional(), sessionCompleted: count.optional(), redisCanaryCompleted: count.optional(), postgresCanaryCompleted: count.optional() }).strict().superRefine((summary, context) => {
  if (summary.completed > summary.started || summary.started > summary.scheduled || summary.skipped !== summary.scheduled - summary.started || summary.errors > summary.completed) context.addIssue({ code: 'custom', message: 'Invalid client counters.' });
  const expected = summary.checkoutCompleted === 0 ? null : summary.checkoutErrors / summary.checkoutCompleted;
  if (summary.checkoutErrorRate !== expected) context.addIssue({ code: 'custom', message: 'checkoutErrorRate must match counters.' });
  if (summary.businessSkipped !== undefined && summary.businessSkipped > summary.skipped) context.addIssue({ code: 'custom', message: 'businessSkipped cannot exceed skipped launches.' });
});
export type ClientSummary = z.infer<typeof ClientSummarySchema>;

export const TrialTelemetrySchema = z.object({
  id, runId: id, kind: TrialKindSchema, status: TrialStatusSchema, executionMode: z.enum(['daytona', 'development-local']), sandboxId: text(256).optional(), cleanupStatus: CleanupStatusSchema, startedAt: timestamp.optional(), finishedAt: timestamp.optional(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), workloadHash: z.string().regex(/^[a-f0-9]{64}$/), runtimeIdentity: text(256), faultWitnessed: z.boolean(), metrics: z.array(ServiceMetricSchema).max(12), spans: z.array(RequestSpanSchema).max(LIMITS.maxSpans), artifacts: z.array(ArtifactRefSchema).max(8), clientSummary: ClientSummarySchema, validity: z.enum(['valid', 'invalid', 'inconclusive']), warnings: z.array(text(512)).max(32), error: z.object({ code: text(80), message: text(512) }).strict().optional()
}).strict();
export type TrialTelemetry = z.infer<typeof TrialTelemetrySchema>;

const AnalysisHypothesisSchema = z.object({ explanation: text(2000), metricIds: z.array(id).min(1).max(24), spanIds: z.array(id).max(24) }).strict();
const RemediationSchema = z.object({ proposal: text(1000), limitation: text(1000), metricIds: z.array(id).max(24) }).strict();
export const EvidenceAnalysisSchema = z.object({ id, source: z.enum(['nosana', 'deterministic']), model: text(160).optional(), status: z.enum(['available', 'unavailable']), summary: text(2000), hypotheses: z.array(AnalysisHypothesisSchema).max(12), remediation: z.array(RemediationSchema).max(12), promptVersion: text(80), createdAt: timestamp }).strict();
export type EvidenceAnalysis = z.infer<typeof EvidenceAnalysisSchema>;

export const ComparisonResultSchema = z.object({ comparisonValidity: ComparisonValiditySchema, comparisonReasons: z.array(text(512)).max(32), actualBlastRadiusIds: z.array(ServiceIdSchema).max(6), observedCascadeEdges: z.array(DependencyEdgeSchema).max(6) }).strict();
export type ComparisonResult = z.infer<typeof ComparisonResultSchema>;
export const ReproductionSummarySchema = z.object({ controlTrialId: id, chaosTrialId: id, classification: ReproductionClassificationSchema, reasons: z.array(text(512)).max(32) }).strict();
export type ReproductionSummary = z.infer<typeof ReproductionSummarySchema>;

export const DiagnosticActionSchema = z.discriminatedUnion('action', [z.object({ action: z.literal('read_evidence') }).strict(), z.object({ action: z.literal('probe_auth') }).strict(), z.object({ action: z.literal('finish'), summary: text(2000), metricIds: z.array(id).max(24), spanIds: z.array(id).max(24) }).strict()]);
export type DiagnosticAction = z.infer<typeof DiagnosticActionSchema>;
export const DiagnosticTraceEntrySchema = z.object({ id, action: z.enum(['read_evidence', 'probe_auth', 'finish']), toolName: text(160), success: z.boolean(), startedAt: timestamp, finishedAt: timestamp, elapsedMs: duration, argumentSummary: text(1024), resultSummary: text(4096), error: text(512).optional() }).strict();
export type DiagnosticTraceEntry = z.infer<typeof DiagnosticTraceEntrySchema>;
export const DiagnosticSessionSchema = z.object({ id, runId: id, sandboxId: text(256).optional(), status: z.enum(['QUEUED', 'PREPARING', 'RUNNING', 'ANALYZING', 'COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']), cleanupStatus: CleanupStatusSchema, createdAt: timestamp, finishedAt: timestamp.optional(), toolTrace: z.array(DiagnosticTraceEntrySchema).max(2), finalExplanation: text(2000).optional(), analysis: EvidenceAnalysisSchema.optional(), error: z.object({ code: text(80), message: text(512) }).strict().optional() }).strict();
export type DiagnosticSession = z.infer<typeof DiagnosticSessionSchema>;

export const RunSnapshotSchema = z.object({ id, status: RunStatusSchema, createdAt: timestamp, finishedAt: timestamp.optional(), sourceSha: z.string().regex(/^[a-f0-9]{40}$/), payloadHash: z.string().regex(/^[a-f0-9]{64}$/), topologyHash: z.string().regex(/^[a-f0-9]{64}$/), hypothesis: ChaosHypothesisSchema.optional(), trials: z.array(TrialTelemetrySchema).max(5), actualBlastRadiusIds: uniqueServiceIds(), comparisonValidity: ComparisonValiditySchema, comparisonReasons: z.array(text(512)).max(32), graph: TopologyGraphSchema, analysis: EvidenceAnalysisSchema.optional(), reproduction: ReproductionSummarySchema.optional(), lastEventSeq: count, warnings: z.array(text(512)).max(32) }).strict().superRefine((snapshot, context) => {
  if (snapshot.comparisonValidity !== 'valid' && snapshot.actualBlastRadiusIds.length > 0) {
    context.addIssue({ code: 'custom', message: 'Non-valid comparisons must have an empty actualBlastRadiusIds.' });
  }
});
export type RunSnapshot = z.infer<typeof RunSnapshotSchema>;
export const RunSummarySchema = z.object({ id, status: RunStatusSchema, createdAt: timestamp, finishedAt: timestamp.optional(), actualBlastRadiusIds: z.array(ServiceIdSchema).max(6), comparisonValidity: ComparisonValiditySchema, warnings: z.array(text(512)).max(8) }).strict();
export type RunSummary = z.infer<typeof RunSummarySchema>;

export const AgentEventTypeSchema = z.enum(['GRAPH_LOADED', 'HYPOTHESIS_GENERATED', 'SANDBOX_PROVISIONING', 'BASELINE_TRAFFIC_COMPLETE', 'TRIAL_STARTED', 'FAULT_INJECTED', 'TELEMETRY_COLLECTED', 'CASCADE_DETECTED', 'NEO4J_BLAST_RADIUS_UPDATED', 'ANALYSIS_GENERATED', 'REMEDIATION_PROPOSED', 'DIAGNOSTIC_TOOL_RESULT', 'CLEANUP_COMPLETE', 'RUN_COMPLETE', 'TERMINAL_LOG', 'ERROR', 'RESYNC']);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;
export const AgentStreamEventSchema = z.object({ id, runId: id, seq: count, type: AgentEventTypeSchema, timestamp, message: text(1024), payload: z.object({ trialId: id.optional(), diagnosticId: id.optional(), status: RunStatusSchema.optional(), trialStatus: TrialStatusSchema.optional(), affectedIds: z.array(ServiceIdSchema).max(6).optional(), comparisonValidity: ComparisonValiditySchema.optional(), logLine: text(4096).optional(), errorCode: text(80).optional() }).strict().optional() }).strict().refine((event) => JSON.stringify(event).length <= LIMITS.bodyBytes, 'Event exceeds bounded payload size');
export type AgentStreamEvent = z.infer<typeof AgentStreamEventSchema>;

export const RiskContextSchema = z.object({ runId: id, graph: TopologyGraphSchema, pathsToRedis: z.array(z.array(ServiceIdSchema).min(2).max(6)).max(10), fixedCypherQuery: text(4000), fixedCypherParameters: z.record(text(128), z.string().max(256)).refine((parameters) => Object.keys(parameters).length <= 8) }).strict();
export type RiskContext = z.infer<typeof RiskContextSchema>;
export const ValidatedEvidenceInputSchema = z.object({ run: RunSnapshotSchema, control: TrialTelemetrySchema, chaos: TrialTelemetrySchema, comparison: ComparisonResultSchema, metricIds: z.array(id).max(24), spanIds: z.array(id).max(24) }).strict();
export type ValidatedEvidenceInput = z.infer<typeof ValidatedEvidenceInputSchema>;
export const DiagnosticPromptContextSchema = z.object({ runId: id, diagnosticId: id, allowedServiceIds: z.array(ServiceIdSchema).max(6), evidence: ValidatedEvidenceInputSchema, toolTrace: z.array(DiagnosticTraceEntrySchema).max(2).optional() }).strict();
export type DiagnosticPromptContext = z.infer<typeof DiagnosticPromptContextSchema>;
export const IntegrationsStatusSchema = z.object({ daytona: z.object({ available: z.boolean(), checkedAt: timestamp.optional(), message: text(512).optional() }).strict(), nosana: z.object({ available: z.boolean(), checkedAt: timestamp.optional(), model: text(160).optional(), message: text(512).optional() }).strict(), neo4j: z.object({ available: z.boolean(), checkedAt: timestamp.optional(), message: text(512).optional() }).strict(), mcp: z.object({ available: z.boolean(), checkedAt: timestamp.optional(), message: text(512).optional() }).strict() }).strict();
export type IntegrationsStatus = z.infer<typeof IntegrationsStatusSchema>;
export const ApiErrorEnvelopeSchema = z.object({ error: z.object({ code: text(80), message: text(512), requestId: id }).strict() }).strict();
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;
export const EmptyBodySchema = z.object({}).strict();
export type EmptyBody = z.infer<typeof EmptyBodySchema>;
export const OperationKeySchema = z.string().uuid();
export type OperationKey = z.infer<typeof OperationKeySchema>;
export const OperationKeyHeaderSchema = z.object({ 'idempotency-key': OperationKeySchema }).passthrough();
export type OperationKeyHeader = z.infer<typeof OperationKeyHeaderSchema>;
export const RunAcceptedResponseSchema = z.object({ runId: id }).strict();
export type RunAcceptedResponse = z.infer<typeof RunAcceptedResponseSchema>;
export const ReproduceAcceptedResponseSchema = z.object({ reproductionId: id, trialIds: z.array(id).length(2) }).strict();
export type ReproduceAcceptedResponse = z.infer<typeof ReproduceAcceptedResponseSchema>;
export const InvestigateAcceptedResponseSchema = z.object({ diagnosticId: id }).strict();
export type InvestigateAcceptedResponse = z.infer<typeof InvestigateAcceptedResponseSchema>;
export const OperationActionSchema = z.enum(['run', 'reproduce', 'investigate']);
export type OperationAction = z.infer<typeof OperationActionSchema>;
export const OperationClaimSchema = z.object({ id, action: OperationActionSchema, targetId: id.optional(), trialIds: z.array(id).max(2).optional(), replayed: z.boolean() }).strict();
export type OperationClaim = z.infer<typeof OperationClaimSchema>;

export interface GraphRepository { ensureSchema(): Promise<void>; seedTopology(): Promise<TopologyGraph>; createRun(input: { id?: string; sourceSha: string; payloadHash: string; topologyHash: string; operationKey?: string }): Promise<RunSnapshot>; retrieveRiskContext(runId: EntityId): Promise<RiskContext>; saveHypothesis(runId: EntityId, hypothesis: ChaosHypothesis): Promise<void>; updateRun(runId: EntityId, patch: Partial<RunSnapshot>): Promise<RunSnapshot>; saveTrial(trial: TrialTelemetry): Promise<void>; saveComparison(runId: EntityId, result: ComparisonResult, pair?: { controlTrialId: string; chaosTrialId: string }): Promise<void>; saveAnalysis(runId: EntityId, analysis: EvidenceAnalysis): Promise<void>; appendEvent(event: AgentStreamEvent): Promise<void>; getRun(runId: EntityId): Promise<RunSnapshot | null>; listRuns(limit: number): Promise<RunSummary[]>; getEventsAfter(runId: EntityId, seq: number): Promise<{ events: AgentStreamEvent[]; truncated: boolean }>; getGraph(query: { runId?: EntityId; trialId?: EntityId }): Promise<TopologyGraph>; saveDiagnostic(session: DiagnosticSession): Promise<void>; getDiagnostic(diagnosticId: string): Promise<DiagnosticSession | null>; claimOperationKey(operationKey: string, action: OperationAction, targetId?: string, trialIds?: string[]): Promise<OperationClaim>; findUnfinishedResources(): Promise<Array<{ runId: EntityId; trialId?: EntityId; diagnosticId?: EntityId; sandboxId: string; cleanupStatus?: CleanupStatus }>>; }
export interface RequestControl { signal?: AbortSignal; deadlineMs?: number; }
export interface NosanaClientContract { hypothesize(context: RiskContext, control?: RequestControl): Promise<ChaosHypothesis | ChaosHypothesisDraft>; analyze(evidence: ValidatedEvidenceInput, control?: RequestControl): Promise<EvidenceAnalysis>; nextDiagnosticAction(context: DiagnosticPromptContext, control?: RequestControl): Promise<DiagnosticAction>; }
export interface OrchestratorContract { startRun(operationKey: string): Promise<{ runId: EntityId }>; cancel(runId: EntityId): Promise<RunSnapshot>; reproduce(runId: EntityId, operationKey: string): Promise<{ reproductionId: EntityId; trialIds: EntityId[] }>; investigate(runId: EntityId, operationKey: string): Promise<{ diagnosticId: EntityId }>; }

const rank: Record<NodeHealthStatus, number | undefined> = { HEALTHY: 0, DEGRADED: 1, DOWN: 2, UNKNOWN: undefined };
const primaryMetric = (trial: TrialTelemetry, serviceId: ServiceId) => trial.metrics.find((metric) => metric.serviceId === serviceId && metric.channel === PRIMARY_CHANNEL_BY_SERVICE[serviceId]);
const requiredEvidenceIsComplete = (trial: TrialTelemetry) => trial.spans.length < LIMITS.maxSpans && !trial.artifacts.some((artifact) => artifact.truncated && ['metrics', 'spans', 'fault_witness', 'runtime'].includes(artifact.kind));
const delayedBusinessWitnesses = (trial: TrialTelemetry) => trial.spans.filter((span) => span.channel === 'business' && span.serviceId === 'redis-cache' && span.faultApplied);
const witnessedCheckoutTraces = (trial: TrialTelemetry) => delayedBusinessWitnesses(trial).filter((span) => trial.spans.some((candidate) => candidate.traceId === span.traceId && candidate.channel === 'business' && (candidate.serviceId === 'order-service' || candidate.serviceId === 'payment-service')));
const traceExercisesConfiguredEdge = (spans: RequestSpan[], source: ServiceId, target: ServiceId) => spans.some((span) => span.kind === 'client' && span.serviceId === source && span.downstreamId === target);
const countTraceIds = (spans: RequestSpan[]) => new Set(spans.map((span) => span.traceId)).size;
const completedSessionCount = (trial: TrialTelemetry) => trial.clientSummary.sessionCompleted ?? countTraceIds(trial.spans.filter((span) => span.channel === 'business' && span.serviceId === 'frontend' && !trial.spans.some((candidate) => candidate.traceId === span.traceId && (candidate.serviceId === 'order-service' || candidate.serviceId === 'payment-service'))));
const completedCanaryCount = (trial: TrialTelemetry, serviceId: 'redis-cache' | 'postgres-db') => serviceId === 'redis-cache' ? trial.clientSummary.redisCanaryCompleted ?? countTraceIds(trial.spans.filter((span) => span.channel === 'canary' && span.serviceId === serviceId)) : trial.clientSummary.postgresCanaryCompleted ?? countTraceIds(trial.spans.filter((span) => span.channel === 'canary' && span.serviceId === serviceId));
const hasPathToRedis = (serviceId: ServiceId, graph: TopologyGraph) => { const visit = (node: ServiceId, seen: Set<ServiceId>): boolean => node === 'redis-cache' || graph.edges.some((edge) => edge.evidenceKind === 'configured' && edge.source === node && !seen.has(edge.target) && visit(edge.target, new Set([...seen, edge.target]))); return visit(serviceId, new Set([serviceId])); };
const healthyQuality = (trial: TrialTelemetry): string[] => { const reasons: string[] = []; if (!['baseline', 'control', 'reproduction-control'].includes(trial.kind)) reasons.push('Healthy trial has an invalid kind.'); if (trial.status !== 'COMPLETED') reasons.push('Trial did not complete.'); if (trial.faultWitnessed) reasons.push('Healthy trial recorded a fault witness.'); if (trial.clientSummary.scheduled !== 130 || trial.clientSummary.started !== 130 || trial.clientSummary.completed !== 130 || trial.clientSummary.errors !== 0) reasons.push('Healthy trial did not complete 130 error-free requests.'); if (trial.validity !== 'valid') reasons.push('Trial report is not valid.'); if (!requiredEvidenceIsComplete(trial)) reasons.push('Required evidence is incomplete.'); for (const node of SERVICE_REGISTRY) { const metric = primaryMetric(trial, node.id); if (!metric || metric.status !== 'HEALTHY') reasons.push(`Primary metric for ${node.id} is not HEALTHY.`); } return reasons; };
export function evaluateBaselineTrial(trial: TrialTelemetry): { validity: 'valid' | 'inconclusive'; reasons: string[] } { return (() => { const reasons = healthyQuality(trial); return { validity: reasons.length ? 'inconclusive' : 'valid', reasons }; })(); }
export function evaluateChaosTrial(trial: TrialTelemetry): { validity: 'valid' | 'inconclusive'; reasons: string[] } { const reasons: string[] = []; const clientSummary = trial.clientSummary; if (!['chaos', 'reproduction-chaos'].includes(trial.kind)) reasons.push('Chaos trial has an invalid kind.'); if (trial.status !== 'COMPLETED') reasons.push('Trial did not complete.'); if (trial.validity !== 'valid') reasons.push('Chaos report is not valid.'); if (!trial.faultWitnessed) reasons.push('Chaos trial did not record a fault witness.'); if (clientSummary.checkoutStarted < 95 || clientSummary.checkoutCompleted < 95) reasons.push('Insufficient checkout samples.'); if (completedSessionCount(trial) < 9) reasons.push('Insufficient session samples.'); if (completedCanaryCount(trial, 'redis-cache') < 9) reasons.push('Insufficient Redis canary samples.'); if (completedCanaryCount(trial, 'postgres-db') < 9) reasons.push('Insufficient Postgres canary samples.'); if ((clientSummary.businessSkipped ?? clientSummary.skipped) > Math.floor(SCHEDULED_BUSINESS_LAUNCHES * 0.05)) reasons.push('Generator skipped more than 5% of user workload.'); if (!witnessedCheckoutTraces(trial).length) reasons.push('Missing delayed Redis checkout business fault witness.'); if (!requiredEvidenceIsComplete(trial)) reasons.push('Required evidence is incomplete.'); return { validity: reasons.length ? 'inconclusive' : 'valid', reasons }; }
export function evaluateMatchedPairAndBlastRadius(control: TrialTelemetry, chaos: TrialTelemetry, graph: TopologyGraph = DEFAULT_CONFIGURED_TOPOLOGY): ComparisonResult { const reasons = [...healthyQuality(control), ...evaluateChaosTrial(chaos).reasons]; const matchingKinds = control.kind === 'control' && chaos.kind === 'chaos' || control.kind === 'reproduction-control' && chaos.kind === 'reproduction-chaos'; if (!matchingKinds) reasons.push('Matched trials have incompatible kinds.'); if (control.executionMode !== chaos.executionMode) reasons.push('Matched trials have different execution modes.'); if (control.runId !== chaos.runId || control.sourceSha !== chaos.sourceSha || control.payloadHash !== chaos.payloadHash || control.workloadHash !== chaos.workloadHash || control.runtimeIdentity !== chaos.runtimeIdentity) reasons.push('Matched trials have different immutable identities.'); if (reasons.length) return { comparisonValidity: 'inconclusive', comparisonReasons: reasons, actualBlastRadiusIds: [], observedCascadeEdges: [] }; const witnesses = delayedBusinessWitnesses(chaos); const affected = SERVICE_REGISTRY.map((node) => node.id).filter((serviceId) => { const controlMetric = primaryMetric(control, serviceId); const chaosMetric = primaryMetric(chaos, serviceId); if (!controlMetric || !chaosMetric || rank[controlMetric.status] === undefined || rank[chaosMetric.status] === undefined) return false; if (rank[chaosMetric.status]! <= rank[controlMetric.status]!) return false; if (!hasPathToRedis(serviceId, graph)) return false; return witnesses.some((witness) => chaos.spans.some((span) => span.traceId === witness.traceId && span.channel === 'business' && span.serviceId === serviceId)); }); const observedCascadeEdges = graph.edges.filter((edge) => edge.evidenceKind === 'configured' && affected.includes(edge.source) && affected.includes(edge.target)).flatMap((edge) => { const witness = witnesses.find((candidate) => { const trace = chaos.spans.filter((span) => span.traceId === candidate.traceId && span.channel === 'business'); return traceExercisesConfiguredEdge(trace, edge.source, edge.target); }); if (!witness) return []; const ids = chaos.spans.filter((span) => span.traceId === witness.traceId && (span.serviceId === edge.source || span.serviceId === edge.target || span.id === witness.id)).map((span) => span.id); return [{ id: `observed:${chaos.id}:${edge.target}:${edge.source}`, source: edge.target, target: edge.source, relationship: 'CASCADED_TO' as const, evidenceKind: 'observed' as const, circuitBreaker: false, supportingSpanIds: ids }]; }); return { comparisonValidity: 'valid', comparisonReasons: [], actualBlastRadiusIds: affected, observedCascadeEdges }; }
export function classifyReproduction(original: RunSnapshot, control: TrialTelemetry, chaos: TrialTelemetry): ReproductionSummary { const originalControl = original.trials.find((trial) => trial.kind === 'control'); const originalChaos = original.trials.find((trial) => trial.kind === 'chaos'); if (!originalControl || !originalChaos) return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: ['Original run does not contain a matched control and chaos pair.'] }; if (original.comparisonValidity !== 'valid') return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: original.comparisonReasons }; if (control.kind !== 'reproduction-control' || chaos.kind !== 'reproduction-chaos') return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: ['Reproduction trials must use reproduction-control and reproduction-chaos kinds.'] }; if (control.id === originalControl.id || chaos.id === originalChaos.id) return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: ['Reproduction trials must have new trial IDs.'] }; const originalIdentityMatches = originalControl.sourceSha === control.sourceSha && originalControl.payloadHash === control.payloadHash && originalControl.workloadHash === control.workloadHash && originalControl.runtimeIdentity === control.runtimeIdentity && originalChaos.sourceSha === chaos.sourceSha && originalChaos.payloadHash === chaos.payloadHash && originalChaos.workloadHash === chaos.workloadHash && originalChaos.runtimeIdentity === chaos.runtimeIdentity; if (!originalIdentityMatches) return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: ['Reproduction pair identities do not match the original pair.'] }; if (control.executionMode !== originalControl.executionMode || chaos.executionMode !== originalChaos.executionMode) return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: ['Reproduction pair execution modes do not match the original pair.'] }; const result = evaluateMatchedPairAndBlastRadius(control, chaos, original.graph); if (result.comparisonValidity !== 'valid') return { controlTrialId: control.id, chaosTrialId: chaos.id, classification: 'inconclusive', reasons: result.comparisonReasons }; const delta = (trial: TrialTelemetry) => trial.clientSummary.checkoutErrorRate ?? 0; const originalIncrease = delta(originalChaos) - delta(originalControl); const reproductionIncrease = delta(chaos) - delta(control); const same = original.actualBlastRadiusIds.length === result.actualBlastRadiusIds.length && original.actualBlastRadiusIds.every((id) => result.actualBlastRadiusIds.includes(id)); const classification: ReproductionClassification = same && originalIncrease >= .2 && reproductionIncrease >= .2 ? 'reproduced' : result.actualBlastRadiusIds.length && !same ? 'partial' : 'not_reproduced'; return { controlTrialId: control.id, chaosTrialId: chaos.id, classification, reasons: [`Checkout error-rate increase: ${reproductionIncrease.toFixed(3)}.`] }; }

/** DEVELOPMENT FIXTURE ONLY - never represents provider-backed evidence. */
export const DEV_FIXTURE_BANNER = 'DEVELOPMENT FIXTURE ONLY: not live provider evidence.';
const devTime = '2026-01-01T00:00:00.000Z'; const devSha = 'a'.repeat(40); const devHash = 'b'.repeat(64);
export const DEV_FIXTURE_TOPOLOGY: TopologyGraph = DEFAULT_CONFIGURED_TOPOLOGY;
const devMetric = (serviceId: ServiceId, channel: 'business' | 'canary'): ServiceMetric => ({ id: `fixture:${serviceId}:${channel}`, serviceId, channel, status: 'HEALTHY', requestsStarted: 1, requestsCompleted: 1, errorsTotal: 0, timeoutsTotal: 0, errorRate: 0, latencyP50Ms: 5, latencyP95Ms: 5, latencyP99Ms: 5, sampleCount: 1, smallSample: true });
const devTrial: TrialTelemetry = { id: 'fixture-baseline', runId: 'fixture-run', kind: 'baseline', status: 'COMPLETED', executionMode: 'development-local', cleanupStatus: 'DELETED', startedAt: devTime, finishedAt: devTime, sourceSha: devSha, payloadHash: devHash, workloadHash: devHash, runtimeIdentity: 'development-fixture', faultWitnessed: false, metrics: SERVICE_REGISTRY.map((node) => devMetric(node.id, PRIMARY_CHANNEL_BY_SERVICE[node.id])), spans: [], artifacts: [], clientSummary: { scheduled: 0, started: 0, completed: 0, skipped: 0, errors: 0, checkoutStarted: 0, checkoutCompleted: 0, checkoutErrors: 0, checkoutErrorRate: null, checkoutP95Ms: null }, validity: 'inconclusive', warnings: [DEV_FIXTURE_BANNER] };
export const DEV_FIXTURE_RUN_SNAPSHOT: RunSnapshot = { id: 'fixture-run', status: 'INCONCLUSIVE', createdAt: devTime, sourceSha: devSha, payloadHash: devHash, topologyHash: devHash, trials: [devTrial], actualBlastRadiusIds: [], comparisonValidity: 'not_evaluated', comparisonReasons: [DEV_FIXTURE_BANNER], graph: DEV_FIXTURE_TOPOLOGY, lastEventSeq: 0, warnings: [DEV_FIXTURE_BANNER] };
export const DEV_FIXTURE_DIAGNOSTIC_SESSION: DiagnosticSession = { id: 'fixture-diagnostic', runId: 'fixture-run', status: 'COMPLETED', cleanupStatus: 'DELETED', createdAt: devTime, finishedAt: devTime, toolTrace: [], finalExplanation: DEV_FIXTURE_BANNER, error: { code: 'DEVELOPMENT_FIXTURE', message: DEV_FIXTURE_BANNER } };
