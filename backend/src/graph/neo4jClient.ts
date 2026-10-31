import { createHash, randomUUID } from 'node:crypto';
import neo4j, { auth } from 'neo4j-driver';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';

import {
  DEFAULT_CONFIGURED_TOPOLOGY,
  DiagnosticSessionSchema,
  FIXED_RISK_CYPHER_QUERY,
  LIMITS,
  OperationClaimSchema,
  PRIMARY_CHANNEL_BY_SERVICE,
  RunSnapshotSchema,
  SERVICE_REGISTRY,
  TopologyGraphSchema,
  classifyReproduction,
  type AgentStreamEvent,
  type ChaosHypothesis,
  type CleanupStatus,
  type ComparisonResult,
  type DiagnosticSession,
  type EntityId,
  type EvidenceAnalysis,
  type GraphRepository,
  type OperationAction,
  type OperationClaim,
  type ReproductionSummary,
  type RiskContext,
  type RunSnapshot,
  type RunSummary,
  type ServiceId,
  type ServiceMetric,
  type TopologyGraph,
  type TrialTelemetry
} from '../../../shared/types.js';

const PROJECT_ID = 'entropy';
const TEMPLATE_SCOPE = 'template';
const TOPOLOGY_HASH = createHash('sha256').update(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY)).digest('hex');
const TERMINAL_TRIAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

type CreateRunInput = { sourceSha: string; payloadHash: string; id?: string; topologyHash?: string; operationKey?: string };
type ComparisonPair = { controlTrialId: string; chaosTrialId: string };
type RepositoryOptions = {
  driver?: Driver;
  uri?: string;
  username?: string;
  password?: string;
  database?: string;
  /** Test-only or explicitly requested local-development persistence. */
  inMemory?: boolean;
  developmentMode?: boolean;
  createId?: () => string;
  now?: () => string;
};
type StoredRun = RunSnapshot & { events: AgentStreamEvent[] };
type MemoryStore = { runs: Map<string, StoredRun>; diagnostics: Map<string, DiagnosticSession>; operations: Map<string, OperationClaim> };

function json(value: unknown): string { return JSON.stringify(value); }
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function asInt(value: number): ReturnType<typeof neo4j.int> { return neo4j.int(value); }
function optionalInt(value: number | undefined): ReturnType<typeof neo4j.int> | null { return value === undefined ? null : neo4j.int(value); }

/** Converts driver values at the adapter boundary, including integers and temporal values. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (neo4j.isInt(value)) return value.toNumber();
  if (value && typeof value === 'object') {
    const temporal = value as { toStandardDate?: () => Date; properties?: unknown };
    if (temporal.toStandardDate) return temporal.toStandardDate().toISOString();
    if (temporal.properties) return plain(temporal.properties);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
  }
  return value;
}
function parseJson<T>(value: unknown): T { return JSON.parse(String(value)) as T; }
function nodeKey(scope: string, topologyHash: string, serviceId: ServiceId): string {
  return scope === TEMPLATE_SCOPE ? `entropy:template:${topologyHash}:${serviceId}` : `entropy:${scope}:${serviceId}`;
}
function emptyTopology(runId?: string): TopologyGraph { return { ...copy(DEFAULT_CONFIGURED_TOPOLOGY), ...(runId ? { runId } : {}) }; }
function snapshotWithoutEvents(run: StoredRun): RunSnapshot { const { events: _events, ...snapshot } = run; return snapshot; }

function runScalars(snapshot: RunSnapshot, events: AgentStreamEvent[]) {
  return {
    id: snapshot.id,
    projectId: PROJECT_ID,
    status: snapshot.status,
    sourceSha: snapshot.sourceSha,
    payloadHash: snapshot.payloadHash,
    topologyHash: snapshot.topologyHash,
    comparisonValidity: snapshot.comparisonValidity,
    createdAt: snapshot.createdAt,
    finishedAt: snapshot.finishedAt ?? null,
    lastEventSeq: asInt(snapshot.lastEventSeq),
    snapshotJson: json(snapshot),
    eventsJson: json(events)
  };
}

function trialScalars(trial: TrialTelemetry) {
  return {
    runId: trial.runId,
    id: trial.id,
    projectId: PROJECT_ID,
    kind: trial.kind,
    status: trial.status,
    sandboxId: trial.sandboxId ?? null,
    cleanupStatus: trial.cleanupStatus,
    sourceSha: trial.sourceSha,
    payloadHash: trial.payloadHash,
    workloadHash: trial.workloadHash,
    runtimeIdentity: trial.runtimeIdentity,
    faultWitnessed: trial.faultWitnessed,
    validity: trial.validity,
    payloadJson: json(trial)
  };
}

function metricScalars(trialId: string, runId: string, metric: ServiceMetric) {
  return {
    trialId,
    projectId: PROJECT_ID,
    scope: runId,
    key: nodeKey(runId, '', metric.serviceId),
    id: metric.id,
    serviceId: metric.serviceId,
    channel: metric.channel,
    status: metric.status,
    requestsStarted: asInt(metric.requestsStarted),
    requestsCompleted: asInt(metric.requestsCompleted),
    errorsTotal: asInt(metric.errorsTotal),
    timeoutsTotal: asInt(metric.timeoutsTotal),
    errorRate: metric.errorRate,
    latencyP50Ms: metric.latencyP50Ms,
    latencyP95Ms: metric.latencyP95Ms,
    latencyP99Ms: metric.latencyP99Ms,
    sampleCount: asInt(metric.sampleCount),
    smallSample: metric.smallSample,
    activeSlotsPeak: optionalInt(metric.activeSlotsPeak),
    queueLengthPeak: optionalInt(metric.queueLengthPeak),
    requestsQueued: optionalInt(metric.requestsQueued),
    queueRejected: optionalInt(metric.queueRejected),
    payloadJson: json(metric)
  };
}

export class Neo4jGraphRepository implements GraphRepository {
  private readonly driver?: Driver;
  private readonly database: string;
  private readonly memory?: MemoryStore;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly createId: () => string;
  private readonly now: () => string;

  constructor(options: RepositoryOptions = {}) {
    this.database = options.database ?? 'neo4j';
    this.createId = options.createId ?? randomUUID;
    this.now = options.now ?? (() => new Date().toISOString());
    this.driver = options.driver ?? (options.uri && options.password ? neo4j.driver(options.uri, auth.basic(options.username ?? 'neo4j', options.password)) : undefined);
    if (!this.driver && (options.inMemory || options.developmentMode)) this.memory = { runs: new Map(), diagnostics: new Map(), operations: new Map() };
    if (!this.driver && !this.memory) throw new Error('Neo4j configuration is required outside explicit test/development mode.');
  }

  async verifyConnectivity(): Promise<void> {
    if (!this.driver) throw new Error('Neo4j is not configured; this is explicit development/test memory mode.');
    await this.driver.verifyConnectivity();
  }
  async close(): Promise<void> { await this.driver?.close(); }

  async ensureSchema(): Promise<void> {
    if (this.memory) return;
    await this.withWrite(async (session) => {
      for (const query of [
        'CREATE CONSTRAINT service_key IF NOT EXISTS FOR (n:Service) REQUIRE n.key IS UNIQUE',
        'CREATE CONSTRAINT datastore_key IF NOT EXISTS FOR (n:Datastore) REQUIRE n.key IS UNIQUE',
        'CREATE CONSTRAINT entropy_run_id IF NOT EXISTS FOR (n:EntropyRun) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entropy_trial_id IF NOT EXISTS FOR (n:EntropyTrial) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entropy_metric_id IF NOT EXISTS FOR (n:EntropyMetric) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entropy_hypothesis_id IF NOT EXISTS FOR (n:EntropyHypothesis) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entropy_analysis_id IF NOT EXISTS FOR (n:EntropyAnalysis) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entropy_diagnostic_id IF NOT EXISTS FOR (n:EntropyDiagnostic) REQUIRE n.id IS UNIQUE',
        'CREATE CONSTRAINT entropy_operation_id IF NOT EXISTS FOR (n:EntropyOperation) REQUIRE n.id IS UNIQUE'
      ]) await session.executeWrite((tx) => tx.run(query));
    });
  }

  async seedTopology(): Promise<TopologyGraph> {
    if (this.memory) return emptyTopology();
    await this.withWrite((session) => session.executeWrite((tx) => this.persistTopology(tx, TEMPLATE_SCOPE, TOPOLOGY_HASH)));
    return this.readTopology(TEMPLATE_SCOPE, TOPOLOGY_HASH);
  }

  async createRun(input: CreateRunInput): Promise<RunSnapshot> {
    const requestedId = input.id ?? this.createId();
    const topologyHash = input.topologyHash ?? TOPOLOGY_HASH;
    if (this.memory) {
      let id = requestedId;
      if (input.operationKey) {
        const prior = this.memory.operations.get(input.operationKey);
        if (prior && prior.action !== 'run') throw new Error(`Operation key ${input.operationKey} already claimed for action ${prior.action}.`);
        id = prior?.targetId ?? requestedId;
        if (prior && !prior.targetId) prior.targetId = id;
        if (!prior) this.memory.operations.set(input.operationKey, { id: input.operationKey, action: 'run', targetId: id, replayed: false });
        const existing = this.memory.runs.get(id);
        if (existing) return copy({ ...snapshotWithoutEvents(existing), graph: this.projectGraph(existing) });
      }
      const snapshot: RunSnapshot = {
        id, status: 'QUEUED', createdAt: this.now(), sourceSha: input.sourceSha, payloadHash: input.payloadHash, topologyHash,
        trials: [], actualBlastRadiusIds: [], comparisonValidity: 'not_evaluated', comparisonReasons: [], graph: emptyTopology(id), lastEventSeq: 0, warnings: []
      };
      RunSnapshotSchema.parse(snapshot);
      this.memory.runs.set(id, { ...snapshot, events: [] });
      return copy(snapshot);
    }
    return this.withWrite((session) => session.executeWrite(async (tx) => {
      let id = requestedId;
      if (input.operationKey) {
        const operation = await tx.run('MERGE (o:EntropyOperation {id:$id, projectId:$projectId}) ON CREATE SET o.action=$action, o.targetId=$targetId SET o.targetId=coalesce(o.targetId, $targetId) RETURN o.action AS action, o.targetId AS targetId', { id: input.operationKey, projectId: PROJECT_ID, action: 'run', targetId: requestedId });
        const record = operation.records[0];
        const claimedAction = String(plain(record?.get('action')) ?? 'run');
        if (claimedAction !== 'run') throw new Error(`Operation key ${input.operationKey} already claimed for action ${claimedAction}.`);
        id = String(plain(record?.get('targetId')) ?? requestedId);
        const existing = await this.readStoredRunInTransaction(tx, id);
        if (existing) return copy({ ...snapshotWithoutEvents(existing), graph: this.projectGraph(existing) });
      }
      const snapshot: RunSnapshot = {
        id, status: 'QUEUED', createdAt: this.now(), sourceSha: input.sourceSha, payloadHash: input.payloadHash, topologyHash,
        trials: [], actualBlastRadiusIds: [], comparisonValidity: 'not_evaluated', comparisonReasons: [], graph: emptyTopology(id), lastEventSeq: 0, warnings: []
      };
      RunSnapshotSchema.parse(snapshot);
      await tx.run('MERGE (r:EntropyRun {id:$id, projectId:$projectId}) ON CREATE SET r.status=$status, r.sourceSha=$sourceSha, r.payloadHash=$payloadHash, r.topologyHash=$topologyHash, r.comparisonValidity=$comparisonValidity, r.createdAt=$createdAt, r.finishedAt=$finishedAt, r.lastEventSeq=$lastEventSeq, r.snapshotJson=$snapshotJson, r.eventsJson=$eventsJson', runScalars(snapshot, []));
      await this.persistTopology(tx, id, topologyHash);
      return snapshot;
    }));
  }

  async retrieveRiskContext(runId: EntityId): Promise<RiskContext> {
    await this.requireRun(runId);
    const scope = String(runId);
    const parameters = { redisKey: nodeKey(scope, '', 'redis-cache'), projectId: PROJECT_ID, scope };
    const pathsToRedis = this.memory
      ? [['frontend', 'auth-service', 'redis-cache'], ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache']] as ServiceId[][]
      : (await this.withRead((session) => session.executeRead((tx) => tx.run(FIXED_RISK_CYPHER_QUERY, parameters)))).records.map((record) => plain(record.get('path')) as ServiceId[]);
    return { runId, graph: await this.getGraph({ runId }), pathsToRedis, fixedCypherQuery: FIXED_RISK_CYPHER_QUERY, fixedCypherParameters: parameters };
  }

  async saveHypothesis(runId: EntityId, hypothesis: ChaosHypothesis): Promise<void> {
    await this.mutateRun(runId, async (run, tx) => {
      if (tx) await tx.run('MATCH (r:EntropyRun {id:$runId, projectId:$projectId}) MERGE (h:EntropyHypothesis {id:$id, projectId:$projectId}) SET h.payloadJson=$payloadJson MERGE (r)-[:HAS_HYPOTHESIS]->(h)', { runId, id: hypothesis.id, projectId: PROJECT_ID, payloadJson: json(hypothesis) });
      return { ...run, hypothesis };
    });
  }

  async updateRun(runId: EntityId, patch: Partial<RunSnapshot>): Promise<RunSnapshot> {
    return this.mutateRun(runId, (run) => ({ ...run, ...copy(patch), id: run.id, graph: run.graph, events: run.events }));
  }

  async saveTrial(trial: TrialTelemetry): Promise<void> {
    const persisted = copy({ ...trial, metrics: trial.metrics.map((metric) => ({ ...metric, id: `${trial.id}:${metric.serviceId}:${metric.channel}` })) });
    await this.mutateRun(trial.runId, async (run, tx) => {
      if (tx) {
        await tx.run('MATCH (r:EntropyRun {id:$runId, projectId:$projectId}) MERGE (t:EntropyTrial {id:$id, projectId:$projectId}) SET t.kind=$kind, t.status=$status, t.sandboxId=$sandboxId, t.cleanupStatus=$cleanupStatus, t.sourceSha=$sourceSha, t.payloadHash=$payloadHash, t.workloadHash=$workloadHash, t.runtimeIdentity=$runtimeIdentity, t.faultWitnessed=$faultWitnessed, t.validity=$validity, t.payloadJson=$payloadJson MERGE (r)-[:HAS_TRIAL]->(t)', trialScalars(persisted));
        for (const metric of persisted.metrics) {
          const updateNodeStatus = persisted.kind === 'chaos' && metric.channel === PRIMARY_CHANNEL_BY_SERVICE[metric.serviceId];
          const setNodeClause = updateNodeStatus ? ' SET n.status=$status, n.metricId=$id' : '';
          await tx.run(`MATCH (t:EntropyTrial {id:$trialId, projectId:$projectId}) MATCH (n {key:$key, projectId:$projectId, scope:$scope}) MERGE (m:EntropyMetric {id:$id, projectId:$projectId}) SET m.serviceId=$serviceId, m.channel=$channel, m.status=$status, m.requestsStarted=$requestsStarted, m.requestsCompleted=$requestsCompleted, m.errorsTotal=$errorsTotal, m.timeoutsTotal=$timeoutsTotal, m.errorRate=$errorRate, m.latencyP50Ms=$latencyP50Ms, m.latencyP95Ms=$latencyP95Ms, m.latencyP99Ms=$latencyP99Ms, m.sampleCount=$sampleCount, m.smallSample=$smallSample, m.activeSlotsPeak=$activeSlotsPeak, m.queueLengthPeak=$queueLengthPeak, m.requestsQueued=$requestsQueued, m.queueRejected=$queueRejected, m.payloadJson=$payloadJson MERGE (t)-[:HAS_METRIC]->(m) MERGE (m)-[:OF_SERVICE]->(n)${setNodeClause}`, metricScalars(persisted.id, trial.runId, metric));
        }
      }
      return { ...run, trials: [...run.trials.filter((item) => item.id !== persisted.id), persisted] };
    });
  }

  async saveComparison(runId: EntityId, result: ComparisonResult, pair?: ComparisonPair): Promise<void> {
    await this.mutateRun(runId, async (run, tx) => {
      const { control, chaos, reproduction } = this.resolveComparisonPair(run, pair);
      const graph = { ...run.graph, edges: [...new Map([...run.graph.edges, ...result.observedCascadeEdges].map((edge) => [edge.id, edge])).values()] };
      if (tx) {
        if (!reproduction) {
          for (const metric of chaos.metrics) if (metric.channel === PRIMARY_CHANNEL_BY_SERVICE[metric.serviceId]) await tx.run('MATCH (n {key:$key, projectId:$projectId, scope:$scope}) SET n.status=$status, n.metricId=$metricId', { key: nodeKey(runId, '', metric.serviceId), projectId: PROJECT_ID, scope: runId, status: metric.status, metricId: metric.id });
        }
        for (const edge of result.observedCascadeEdges) await tx.run('MATCH (source {key:$sourceKey, projectId:$projectId, scope:$scope}) MATCH (target {key:$targetKey, projectId:$projectId, scope:$scope}) MERGE (source)-[r:CASCADED_TO {trialId:$trialId, source:$source, target:$target}]->(target) SET r.supportingSpanIds=$supportingSpanIds', { sourceKey: nodeKey(runId, '', edge.source), targetKey: nodeKey(runId, '', edge.target), projectId: PROJECT_ID, scope: runId, trialId: chaos.id, source: edge.source, target: edge.target, supportingSpanIds: edge.supportingSpanIds });
      }
      if (reproduction) {
        const summary: ReproductionSummary = classifyReproduction(snapshotWithoutEvents(run), control, chaos);
        return { ...run, graph, reproduction: summary };
      }
      return { ...run, graph, comparisonValidity: result.comparisonValidity, comparisonReasons: result.comparisonReasons, actualBlastRadiusIds: result.actualBlastRadiusIds };
    });
  }

  async saveAnalysis(runId: EntityId, analysis: EvidenceAnalysis): Promise<void> {
    await this.mutateRun(runId, async (run, tx) => {
      if (tx) await tx.run('MATCH (r:EntropyRun {id:$runId, projectId:$projectId}) MERGE (a:EntropyAnalysis {id:$id, projectId:$projectId}) SET a.payloadJson=$payloadJson MERGE (r)-[:HAS_ANALYSIS]->(a)', { runId, id: analysis.id, projectId: PROJECT_ID, payloadJson: json(analysis) });
      return { ...run, analysis };
    });
  }

  async appendEvent(event: AgentStreamEvent): Promise<void> {
    await this.mutateRun(event.runId, (run) => {
      if (run.events.some((current) => current.id === event.id || current.seq === event.seq)) return run;
      return { ...run, lastEventSeq: Math.max(run.lastEventSeq, event.seq), events: [...run.events, copy(event)].sort((left, right) => left.seq - right.seq).slice(-LIMITS.maxEvents) };
    });
  }

  async getRun(runId: EntityId): Promise<RunSnapshot | null> {
    const run = await this.readStoredRun(runId);
    return run ? copy({ ...snapshotWithoutEvents(run), graph: this.projectGraph(run) }) : null;
  }

  async listRuns(limit: number): Promise<RunSummary[]> {
    const bounded = Math.min(20, Math.max(1, limit));
    const runs = this.memory ? [...this.memory.runs.values()] : await this.loadAllRuns(bounded);
    return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, bounded).map((run) => ({ id: run.id, status: run.status, createdAt: run.createdAt, ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}), actualBlastRadiusIds: run.actualBlastRadiusIds, comparisonValidity: run.comparisonValidity, warnings: run.warnings }));
  }

  async getEventsAfter(runId: EntityId, seq: number): Promise<{ events: AgentStreamEvent[]; truncated: boolean }> {
    const run = await this.readStoredRun(runId);
    if (!run) return { events: [], truncated: false };
    const first = run.events[0]?.seq;
    return { events: run.events.filter((event) => event.seq > seq), truncated: first !== undefined && seq < first - 1 };
  }

  async getGraph(query: { runId?: EntityId; trialId?: EntityId }): Promise<TopologyGraph> {
    if (!query.runId) return this.memory ? emptyTopology() : this.readTopology(TEMPLATE_SCOPE, TOPOLOGY_HASH);
    const run = await this.readStoredRun(query.runId);
    if (!run) throw new Error(`Unknown run: ${query.runId}`);
    const trial = query.trialId ? run.trials.find((item) => item.id === query.trialId) : this.defaultTrial(run);
    if (query.trialId && !trial) throw new Error(`Unknown trial: ${query.trialId}`);
    return this.projectGraph(run, trial, Boolean(query.trialId));
  }

  async saveDiagnostic(session: DiagnosticSession): Promise<void> {
    await this.enqueue(session.runId, async () => {
      if (this.memory) {
        if (!this.memory.runs.has(session.runId)) throw new Error(`Unknown run: ${session.runId}`);
        this.memory.diagnostics.set(session.id, copy(session));
        return;
      }
      await this.withWrite((databaseSession) => databaseSession.executeWrite(async (tx) => {
        const current = await this.readStoredRunInTransaction(tx, session.runId);
        if (!current) throw new Error(`Unknown run: ${session.runId}`);
        await tx.run('MATCH (r:EntropyRun {id:$runId, projectId:$projectId}) MERGE (d:EntropyDiagnostic {id:$id, projectId:$projectId}) SET d.payloadJson=$payloadJson, d.status=$status, d.cleanupStatus=$cleanupStatus, d.sandboxId=$sandboxId MERGE (r)-[:HAS_DIAGNOSTIC]->(d)', { runId: session.runId, id: session.id, projectId: PROJECT_ID, payloadJson: json(session), status: session.status, cleanupStatus: session.cleanupStatus, sandboxId: session.sandboxId ?? null });
        if (session.analysis) await tx.run('MATCH (d:EntropyDiagnostic {id:$diagnosticId, projectId:$projectId}) MERGE (a:EntropyAnalysis {id:$id, projectId:$projectId}) SET a.payloadJson=$payloadJson MERGE (d)-[:HAS_ANALYSIS]->(a)', { diagnosticId: session.id, id: session.analysis.id, projectId: PROJECT_ID, payloadJson: json(session.analysis) });
      }));
    });
  }

  async getDiagnostic(id: string): Promise<DiagnosticSession | null> {
    if (this.memory) return copy(this.memory.diagnostics.get(id) ?? null);
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run('MATCH (d:EntropyDiagnostic {id:$id, projectId:$projectId}) RETURN d.payloadJson AS payloadJson', { id, projectId: PROJECT_ID })));
    const record = result.records[0];
    return record ? DiagnosticSessionSchema.parse(parseJson(plain(record.get('payloadJson')))) : null;
  }

  async findUnfinishedResources(): Promise<Array<{ runId: EntityId; trialId?: EntityId; diagnosticId?: EntityId; sandboxId: string; cleanupStatus?: CleanupStatus }>> {
    const runs = this.memory ? [...this.memory.runs.values()] : await this.loadAllRuns();
    const trialResources = runs.flatMap((run) => run.trials.filter((trial) => trial.sandboxId && (!TERMINAL_TRIAL_STATUSES.has(trial.status) || trial.cleanupStatus === 'PENDING' || trial.cleanupStatus === 'FAILED')).map((trial) => ({ runId: run.id, trialId: trial.id, sandboxId: trial.sandboxId!, cleanupStatus: trial.cleanupStatus })));
    const diagnostics = this.memory ? [...this.memory.diagnostics.values()] : await this.loadDiagnostics();
    return [...trialResources, ...diagnostics.filter((session) => session.sandboxId && (session.cleanupStatus === 'PENDING' || session.cleanupStatus === 'FAILED')).map((session) => ({ runId: session.runId, diagnosticId: session.id, sandboxId: session.sandboxId!, cleanupStatus: session.cleanupStatus }))];
  }

  async claimOperationKey(operationKey: string, action: OperationAction, targetId?: string, trialIds?: string[]): Promise<OperationClaim> {
    if (this.memory) {
      const existing = this.memory.operations.get(operationKey);
      if (existing) {
        if (existing.action !== action) throw new Error(`Operation key ${operationKey} already claimed for action ${existing.action}.`);
        const updated = OperationClaimSchema.parse({
          ...existing,
          ...(existing.targetId === undefined && targetId ? { targetId } : {}),
          ...(existing.trialIds === undefined && trialIds ? { trialIds } : {}),
          replayed: true
        });
        this.memory.operations.set(operationKey, { ...updated, replayed: false });
        return copy(updated);
      }
      const claim = OperationClaimSchema.parse({ id: operationKey, action, ...(targetId ? { targetId } : {}), ...(trialIds ? { trialIds } : {}), replayed: false });
      this.memory.operations.set(operationKey, claim);
      return copy(claim);
    }
    const callToken = this.createId();
    const result = await this.withWrite((session) => session.executeWrite((tx) => tx.run('MERGE (o:EntropyOperation {id:$id, projectId:$projectId}) ON CREATE SET o.action=$action, o.targetId=$targetId, o.trialIds=$trialIds, o.firstCallToken=$callToken SET o.targetId = CASE WHEN o.action = $action THEN coalesce(o.targetId, $targetId) ELSE o.targetId END, o.trialIds = CASE WHEN o.action = $action THEN coalesce(o.trialIds, $trialIds) ELSE o.trialIds END RETURN o.id AS id, o.action AS action, o.targetId AS targetId, o.trialIds AS trialIds, coalesce(o.firstCallToken, "") <> $callToken AS replayed', { id: operationKey, projectId: PROJECT_ID, action, targetId: targetId ?? null, trialIds: trialIds ?? null, callToken })));
    const record = result.records[0];
    if (!record) throw new Error('Unable to claim operation key.');
    const claimedAction = String(plain(record.get('action')));
    if (claimedAction !== action) throw new Error(`Operation key ${operationKey} already claimed for action ${claimedAction}.`);
    const rawTarget = plain(record.get('targetId'));
    const rawTrialIds = plain(record.get('trialIds'));
    return OperationClaimSchema.parse({ id: String(plain(record.get('id'))), action: claimedAction, ...(typeof rawTarget === 'string' && rawTarget ? { targetId: rawTarget } : {}), ...(Array.isArray(rawTrialIds) ? { trialIds: rawTrialIds.map(String) } : {}), replayed: Boolean(plain(record.get('replayed'))) });
  }

  private resolveComparisonPair(run: StoredRun, pair?: ComparisonPair): { control: TrialTelemetry; chaos: TrialTelemetry; reproduction: boolean } {
    const control = pair ? run.trials.find((trial) => trial.id === pair.controlTrialId) : run.trials.find((trial) => trial.kind === 'control');
    const chaos = pair ? run.trials.find((trial) => trial.id === pair.chaosTrialId) : run.trials.find((trial) => trial.kind === 'chaos');
    if (!control || !chaos) throw new Error('Unknown comparison trial ID.');
    const originalPair = control.kind === 'control' && chaos.kind === 'chaos';
    const reproductionPair = control.kind === 'reproduction-control' && chaos.kind === 'reproduction-chaos';
    if (!originalPair && !reproductionPair) throw new Error('Mismatched comparison trial kinds.');
    return { control, chaos, reproduction: reproductionPair };
  }

  private async mutateRun(runId: EntityId, mutation: (run: StoredRun, tx?: ManagedTransaction) => StoredRun | Promise<StoredRun>): Promise<RunSnapshot> {
    return this.enqueue(String(runId), async () => {
      if (this.memory) {
        const current = this.memory.runs.get(String(runId));
        if (!current) throw new Error(`Unknown run: ${runId}`);
        const updated = await mutation(copy(current));
        const storedSnapshot = snapshotWithoutEvents(updated);
        const projectedSnapshot = { ...storedSnapshot, graph: this.projectGraph(updated) };
        RunSnapshotSchema.parse(storedSnapshot);
        RunSnapshotSchema.parse(projectedSnapshot);
        this.memory.runs.set(String(runId), updated);
        return copy(projectedSnapshot);
      }
      return this.withWrite((session) => session.executeWrite(async (tx) => {
        const current = await this.readStoredRunInTransaction(tx, runId);
        if (!current) throw new Error(`Unknown run: ${runId}`);
        const updated = await mutation(copy(current), tx);
        const storedSnapshot = snapshotWithoutEvents(updated);
        const projectedSnapshot = { ...storedSnapshot, graph: this.projectGraph(updated) };
        RunSnapshotSchema.parse(storedSnapshot);
        RunSnapshotSchema.parse(projectedSnapshot);
        await tx.run('MATCH (r:EntropyRun {id:$id, projectId:$projectId}) SET r.status=$status, r.sourceSha=$sourceSha, r.payloadHash=$payloadHash, r.topologyHash=$topologyHash, r.comparisonValidity=$comparisonValidity, r.createdAt=$createdAt, r.finishedAt=$finishedAt, r.lastEventSeq=$lastEventSeq, r.snapshotJson=$snapshotJson, r.eventsJson=$eventsJson', runScalars(storedSnapshot, updated.events));
        return copy(projectedSnapshot);
      }));
    });
  }

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.queues.get(runId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(operation);
    const link = next.then(() => undefined, () => undefined);
    this.queues.set(runId, link);
    return next.finally(() => { if (this.queues.get(runId) === link) this.queues.delete(runId); });
  }

  private defaultTrial(run: StoredRun): TrialTelemetry | undefined {
    return run.trials.find((trial) => trial.kind === 'chaos') ?? run.trials.find((trial) => trial.kind === 'control') ?? run.trials.find((trial) => trial.kind === 'baseline') ?? run.trials.find((trial) => trial.kind === 'reproduction-chaos');
  }

  private projectGraph(run: StoredRun, selectedTrial = this.defaultTrial(run), explicitTrial = false): TopologyGraph {
    const statuses = new Map<ServiceId, { id: string; status: TopologyGraph['nodes'][number]['status'] }>();
    for (const metric of selectedTrial?.metrics ?? []) if (metric.channel === PRIMARY_CHANNEL_BY_SERVICE[metric.serviceId]) statuses.set(metric.serviceId, { id: metric.id, status: metric.status });
    const nodes = run.graph.nodes.map((node) => ({ id: node.id, name: node.name, type: node.type, port: node.port, mock: node.mock, status: statuses.get(node.id)?.status ?? 'UNKNOWN', ...(statuses.has(node.id) ? { metricId: statuses.get(node.id)!.id } : {}) }));
    const includeOverlays = Boolean(selectedTrial && (selectedTrial.kind === 'chaos' || selectedTrial.kind === 'reproduction-chaos')) || (!explicitTrial && run.comparisonValidity === 'valid');
    const edges = run.graph.edges.filter((edge) => edge.relationship !== 'CASCADED_TO' || (includeOverlays && (!selectedTrial || edge.id.includes(`:${selectedTrial.id}:`))));
    const { trialId: _previousTrialId, ...baseGraph } = run.graph;
    return TopologyGraphSchema.parse({ ...baseGraph, runId: run.id, ...(selectedTrial ? { trialId: selectedTrial.id } : {}), nodes, edges });
  }

  private async persistTopology(tx: ManagedTransaction, scope: string, topologyHash: string): Promise<void> {
    for (const node of SERVICE_REGISTRY) await tx.run(`MERGE (n:${node.type} {key:$key}) SET n.id=$id, n.name=$name, n.type=$type, n.port=$port, n.mock=$mock, n.status='UNKNOWN', n.projectId=$projectId, n.scope=$scope, n.topologyHash=$topologyHash`, { key: nodeKey(scope, topologyHash, node.id), id: node.id, name: node.name, type: node.type, port: asInt(node.port), mock: node.mock, projectId: PROJECT_ID, scope, topologyHash });
    for (const edge of DEFAULT_CONFIGURED_TOPOLOGY.edges) await tx.run(`MATCH (source {key:$sourceKey, projectId:$projectId, scope:$scope}) MATCH (target {key:$targetKey, projectId:$projectId, scope:$scope}) MERGE (source)-[r:${edge.relationship}]->(target) SET r.timeoutMs=$timeoutMs, r.circuitBreaker=$circuitBreaker`, { sourceKey: nodeKey(scope, topologyHash, edge.source), targetKey: nodeKey(scope, topologyHash, edge.target), projectId: PROJECT_ID, scope, timeoutMs: optionalInt(edge.timeoutMs), circuitBreaker: edge.circuitBreaker });
  }

  private async readTopology(scope: string, topologyHash: string): Promise<TopologyGraph> {
    const keyPrefix = scope === TEMPLATE_SCOPE ? `entropy:template:${topologyHash}:` : `entropy:${scope}:`;
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run('MATCH (n {projectId:$projectId, scope:$scope}) WHERE (n:Service OR n:Datastore) AND n.key STARTS WITH $keyPrefix OPTIONAL MATCH (n)-[r:CALLS|READS|WRITES|VERIFY_TOKEN]->(target {projectId:$projectId, scope:$scope}) WHERE target.key STARTS WITH $keyPrefix RETURN n, collect(CASE WHEN r IS NULL THEN null ELSE {source:n.id, target:target.id, relationship:type(r), timeoutMs:r.timeoutMs, circuitBreaker:r.circuitBreaker} END) AS relationships ORDER BY n.id', { projectId: PROJECT_ID, scope, keyPrefix })));
    const nodes: TopologyGraph['nodes'] = [];
    const edges: TopologyGraph['edges'] = [];
    for (const record of result.records) {
      const node = plain(record.get('n')) as Record<string, unknown>;
      nodes.push({ id: node.id as ServiceId, name: String(node.name), type: node.type as 'Service' | 'Datastore', port: Number(node.port), mock: Boolean(node.mock), status: node.status as TopologyGraph['nodes'][number]['status'], ...(node.metricId ? { metricId: String(node.metricId) } : {}) });
      for (const relation of plain(record.get('relationships')) as Array<Record<string, unknown> | null>) if (relation) edges.push({ id: `configured:${relation.source}:${relation.target}`, source: relation.source as ServiceId, target: relation.target as ServiceId, relationship: relation.relationship as TopologyGraph['edges'][number]['relationship'], evidenceKind: 'configured', ...(relation.timeoutMs == null ? {} : { timeoutMs: Number(relation.timeoutMs) }), circuitBreaker: Boolean(relation.circuitBreaker), supportingSpanIds: [] });
    }
    return TopologyGraphSchema.parse({ ...(scope === TEMPLATE_SCOPE ? {} : { runId: scope }), nodes, edges });
  }

  private async readStoredRun(runId: EntityId): Promise<StoredRun | null> {
    if (this.memory) return copy(this.memory.runs.get(String(runId)) ?? null);
    return this.withRead((session) => session.executeRead((tx) => this.readStoredRunInTransaction(tx, runId)));
  }
  private async readStoredRunInTransaction(tx: ManagedTransaction, runId: EntityId): Promise<StoredRun | null> {
    const result = await tx.run('MATCH (r:EntropyRun {id:$id, projectId:$projectId}) RETURN r.snapshotJson AS snapshotJson, r.eventsJson AS eventsJson', { id: runId, projectId: PROJECT_ID });
    const record = result.records[0];
    if (!record) return null;
    const snapshot = RunSnapshotSchema.parse(parseJson(plain(record.get('snapshotJson'))));
    return { ...snapshot, events: parseJson<AgentStreamEvent[]>(plain(record.get('eventsJson')) ?? '[]') };
  }
  private async loadAllRuns(limit?: number): Promise<StoredRun[]> {
    const query = limit === undefined
      ? 'MATCH (r:EntropyRun {projectId:$projectId}) RETURN r.snapshotJson AS snapshotJson, r.eventsJson AS eventsJson ORDER BY r.createdAt DESC'
      : 'MATCH (r:EntropyRun {projectId:$projectId}) RETURN r.snapshotJson AS snapshotJson, r.eventsJson AS eventsJson ORDER BY r.createdAt DESC LIMIT $limit';
    const params = limit === undefined ? { projectId: PROJECT_ID } : { projectId: PROJECT_ID, limit: asInt(limit) };
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run(query, params)));
    return result.records.map((record) => ({ ...RunSnapshotSchema.parse(parseJson(plain(record.get('snapshotJson')))), events: parseJson<AgentStreamEvent[]>(plain(record.get('eventsJson')) ?? '[]') }));
  }
  private async loadDiagnostics(): Promise<DiagnosticSession[]> {
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run('MATCH (d:EntropyDiagnostic {projectId:$projectId}) RETURN d.payloadJson AS payloadJson', { projectId: PROJECT_ID })));
    return result.records.map((record) => DiagnosticSessionSchema.parse(parseJson(plain(record.get('payloadJson')))));
  }
  private async requireRun(runId: EntityId): Promise<void> { if (!await this.readStoredRun(runId)) throw new Error(`Unknown run: ${runId}`); }
  private async withRead<T>(operation: (session: Session) => Promise<T>): Promise<T> { const session = this.driver!.session({ database: this.database, defaultAccessMode: neo4j.session.READ }); try { return await operation(session); } finally { await session.close(); } }
  private async withWrite<T>(operation: (session: Session) => Promise<T>): Promise<T> { const session = this.driver!.session({ database: this.database, defaultAccessMode: neo4j.session.WRITE }); try { return await operation(session); } finally { await session.close(); } }
}
