import { createHash, randomUUID } from 'node:crypto';
import neo4j, { auth } from 'neo4j-driver';
import type { Driver, ManagedTransaction, Session } from 'neo4j-driver';

import {
  DEFAULT_CONFIGURED_TOPOLOGY,
  DiagnosticSessionSchema,
  FIXED_RISK_CYPHER_QUERY,
  LIMITS,
  PRIMARY_CHANNEL_BY_SERVICE,
  RunSnapshotSchema,
  SERVICE_REGISTRY,
  TopologyGraphSchema,
  classifyReproduction,
  type AgentStreamEvent,
  type ChaosHypothesis,
  type ComparisonResult,
  type DiagnosticSession,
  type EntityId,
  type EvidenceAnalysis,
  type GraphRepository,
  type ReproductionSummary,
  type RiskContext,
  type RunSnapshot,
  type RunSummary,
  type ServiceId,
  type TopologyGraph,
  type TrialTelemetry
} from '../../../shared/types.js';

const PROJECT_ID = 'entropy';
const TEMPLATE_SCOPE = 'template';
const TOPOLOGY_HASH = createHash('sha256').update(JSON.stringify(DEFAULT_CONFIGURED_TOPOLOGY)).digest('hex');
const TERMINAL_TRIAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'INTERRUPTED']);

type OperationClaim = { id: string; action: string; targetId: string };
type CreateRunInput = { sourceSha: string; id?: string; payloadHash?: string; topologyHash?: string; operationKey?: string };
type ComparisonPair = { controlTrialId?: string; chaosTrialId?: string };
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
    const id = input.id ?? this.createId();
    const topologyHash = input.topologyHash ?? TOPOLOGY_HASH;
    const snapshot: RunSnapshot = {
      id, status: 'QUEUED', createdAt: this.now(), sourceSha: input.sourceSha, payloadHash: input.payloadHash ?? topologyHash, topologyHash,
      trials: [], actualBlastRadiusIds: [], comparisonValidity: 'not_evaluated', comparisonReasons: [], graph: emptyTopology(id), lastEventSeq: 0, warnings: []
    };
    RunSnapshotSchema.parse(snapshot);
    if (this.memory) {
      if (input.operationKey) {
        const prior = this.memory.operations.get(input.operationKey);
        if (prior) { const existing = this.memory.runs.get(prior.targetId); if (existing) return copy(snapshotWithoutEvents(existing)); }
        this.memory.operations.set(input.operationKey, { id: input.operationKey, action: 'start', targetId: id });
      }
      this.memory.runs.set(id, { ...snapshot, events: [] });
      return copy(snapshot);
    }
    await this.withWrite((session) => session.executeWrite(async (tx) => {
      if (input.operationKey) await tx.run('MERGE (o:EntropyOperation {id:$id, projectId:$projectId}) ON CREATE SET o.action=$action, o.targetId=$targetId', { id: input.operationKey, projectId: PROJECT_ID, action: 'start', targetId: id });
      await tx.run('MERGE (r:EntropyRun {id:$id, projectId:$projectId}) ON CREATE SET r.snapshotJson=$snapshotJson, r.eventsJson=$eventsJson, r.createdAt=$createdAt', { id, projectId: PROJECT_ID, snapshotJson: json(snapshot), eventsJson: '[]', createdAt: snapshot.createdAt });
      await this.persistTopology(tx, id, topologyHash);
    }));
    return snapshot;
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
        await tx.run('MATCH (r:EntropyRun {id:$runId, projectId:$projectId}) MERGE (t:EntropyTrial {id:$id, projectId:$projectId}) SET t.payloadJson=$payloadJson MERGE (r)-[:HAS_TRIAL]->(t)', { runId: trial.runId, id: persisted.id, projectId: PROJECT_ID, payloadJson: json(persisted) });
        for (const metric of persisted.metrics) {
          await tx.run('MATCH (t:EntropyTrial {id:$trialId, projectId:$projectId}) MATCH (n {key:$key, projectId:$projectId, scope:$scope}) MERGE (m:EntropyMetric {id:$id, projectId:$projectId}) SET m.payloadJson=$payloadJson MERGE (t)-[:HAS_METRIC]->(m) MERGE (m)-[:OF_SERVICE]->(n) SET n.status=$status, n.metricId=$id', { trialId: persisted.id, projectId: PROJECT_ID, scope: trial.runId, key: nodeKey(trial.runId, '', metric.serviceId), id: metric.id, payloadJson: json(metric), status: metric.status });
        }
      }
      return { ...run, trials: [...run.trials.filter((item) => item.id !== persisted.id), persisted] };
    });
  }

  async saveComparison(runId: EntityId, result: ComparisonResult, pair: ComparisonPair = {}): Promise<void> {
    await this.mutateRun(runId, async (run, tx) => {
      const chaos = this.selectComparisonTrial(run, pair.chaosTrialId, 'chaos');
      const reproduction = chaos?.kind === 'reproduction-chaos';
      const control = pair.controlTrialId ? run.trials.find((trial) => trial.id === pair.controlTrialId) : run.trials.find((trial) => trial.kind === (reproduction ? 'reproduction-control' : 'control')); 
      const graph = { ...run.graph, edges: [...new Map([...run.graph.edges, ...result.observedCascadeEdges].map((edge) => [edge.id, edge])).values()] };
      if (tx) for (const edge of result.observedCascadeEdges) await tx.run('MATCH (source {key:$sourceKey, projectId:$projectId, scope:$scope}) MATCH (target {key:$targetKey, projectId:$projectId, scope:$scope}) MERGE (source)-[r:CASCADED_TO {trialId:$trialId, source:$source, target:$target}]->(target) SET r.supportingSpanIds=$supportingSpanIds', { sourceKey: nodeKey(runId, '', edge.source), targetKey: nodeKey(runId, '', edge.target), projectId: PROJECT_ID, scope: runId, trialId: chaos?.id ?? '', source: edge.source, target: edge.target, supportingSpanIds: edge.supportingSpanIds });
      if (reproduction && chaos && control) {
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
    return run ? copy(snapshotWithoutEvents(run)) : null;
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
    const statuses = new Map<ServiceId, { id: string; status: TopologyGraph['nodes'][number]['status'] }>();
    for (const metric of trial?.metrics ?? []) if (metric.channel === PRIMARY_CHANNEL_BY_SERVICE[metric.serviceId]) statuses.set(metric.serviceId, { id: metric.id, status: metric.status });
    const nodes = run.graph.nodes.map((node) => ({ ...node, status: statuses.get(node.id)?.status ?? 'UNKNOWN', ...(statuses.has(node.id) ? { metricId: statuses.get(node.id)!.id } : {}) }));
    const includeOverlays = Boolean(trial && (trial.kind === 'chaos' || trial.kind === 'reproduction-chaos')) || (!query.trialId && run.comparisonValidity === 'valid');
    const edges = run.graph.edges.filter((edge) => edge.relationship !== 'CASCADED_TO' || (includeOverlays && (!trial || edge.id.includes(`:${trial.id}:`) || edge.id.includes(`:${trial.id}:`))));
    return TopologyGraphSchema.parse({ ...run.graph, runId: run.id, ...(trial ? { trialId: trial.id } : {}), nodes, edges });
  }

  async saveDiagnostic(session: DiagnosticSession): Promise<void> {
    await this.enqueue(session.runId, async () => {
      if (this.memory) { this.memory.diagnostics.set(session.id, copy(session)); return; }
      await this.withWrite((databaseSession) => databaseSession.executeWrite((tx) => tx.run('MATCH (r:EntropyRun {id:$runId, projectId:$projectId}) MERGE (d:EntropyDiagnostic {id:$id, projectId:$projectId}) SET d.payloadJson=$payloadJson MERGE (r)-[:HAS_DIAGNOSTIC]->(d)', { runId: session.runId, id: session.id, projectId: PROJECT_ID, payloadJson: json(session) })));
    });
  }

  async getDiagnostic(id: EntityId): Promise<DiagnosticSession | null> {
    if (this.memory) return copy(this.memory.diagnostics.get(String(id)) ?? null);
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run('MATCH (d:EntropyDiagnostic {id:$id, projectId:$projectId}) RETURN d.payloadJson AS payloadJson', { id, projectId: PROJECT_ID })));
    const record = result.records[0];
    return record ? DiagnosticSessionSchema.parse(parseJson(plain(record.get('payloadJson')))) : null;
  }

  async findUnfinishedResources(): Promise<Array<{ runId: EntityId; trialId: EntityId; sandboxId: string }>> {
    const runs = this.memory ? [...this.memory.runs.values()] : await this.loadAllRuns(20);
    const trialResources = runs.flatMap((run) => run.trials.filter((trial) => trial.sandboxId && (!TERMINAL_TRIAL_STATUSES.has(trial.status) || trial.cleanupStatus === 'PENDING' || trial.cleanupStatus === 'FAILED')).map((trial) => ({ runId: run.id, trialId: trial.id, sandboxId: trial.sandboxId! })));
    const diagnostics = this.memory ? [...this.memory.diagnostics.values()] : await this.loadDiagnostics();
    return [...trialResources, ...diagnostics.filter((session) => session.sandboxId && (session.cleanupStatus === 'PENDING' || session.cleanupStatus === 'FAILED')).map((session) => ({ runId: session.runId, trialId: session.id, sandboxId: session.sandboxId! }))];
  }

  async claimOperationKey(opKey: string, action: string, targetId: string): Promise<OperationClaim> {
    if (this.memory) { const existing = this.memory.operations.get(opKey); if (existing) return copy(existing); const claim = { id: opKey, action, targetId }; this.memory.operations.set(opKey, claim); return claim; }
    const result = await this.withWrite((session) => session.executeWrite((tx) => tx.run('MERGE (o:EntropyOperation {id:$id, projectId:$projectId}) ON CREATE SET o.action=$action, o.targetId=$targetId RETURN o.id AS id, o.action AS action, o.targetId AS targetId', { id: opKey, projectId: PROJECT_ID, action, targetId })));
    const record = result.records[0];
    if (!record) throw new Error('Unable to claim operation key.');
    return plain({ id: record.get('id'), action: record.get('action'), targetId: record.get('targetId') }) as OperationClaim;
  }

  private async mutateRun(runId: EntityId, mutation: (run: StoredRun, tx?: ManagedTransaction) => StoredRun | Promise<StoredRun>): Promise<RunSnapshot> {
    return this.enqueue(String(runId), async () => {
      if (this.memory) {
        const current = this.memory.runs.get(String(runId));
        if (!current) throw new Error(`Unknown run: ${runId}`);
        const updated = await mutation(copy(current));
        this.memory.runs.set(String(runId), updated);
        return copy(snapshotWithoutEvents(updated));
      }
      return this.withWrite((session) => session.executeWrite(async (tx) => {
        const current = await this.readStoredRunInTransaction(tx, runId);
        if (!current) throw new Error(`Unknown run: ${runId}`);
        const updated = await mutation(copy(current), tx);
        const snapshot = snapshotWithoutEvents(updated);
        RunSnapshotSchema.parse(snapshot);
        await tx.run('MATCH (r:EntropyRun {id:$id, projectId:$projectId}) SET r.snapshotJson=$snapshotJson, r.eventsJson=$eventsJson', { id: runId, projectId: PROJECT_ID, snapshotJson: json(snapshot), eventsJson: json(updated.events) });
        return copy(snapshot);
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

  private selectComparisonTrial(run: StoredRun, explicitId: string | undefined, role: 'control' | 'chaos'): TrialTelemetry | undefined {
    if (explicitId) return run.trials.find((trial) => trial.id === explicitId);
    return run.trials.find((trial) => trial.kind === role) ?? run.trials.find((trial) => trial.kind === `reproduction-${role}`);
  }
  private defaultTrial(run: StoredRun): TrialTelemetry | undefined {
    return run.trials.find((trial) => trial.kind === 'chaos') ?? run.trials.find((trial) => trial.kind === 'reproduction-chaos') ?? run.trials.find((trial) => trial.kind === 'control') ?? run.trials.find((trial) => trial.kind === 'baseline');
  }

  private async persistTopology(tx: ManagedTransaction, scope: string, topologyHash: string): Promise<void> {
    for (const node of SERVICE_REGISTRY) await tx.run(`MERGE (n:${node.type} {key:$key}) SET n.id=$id, n.name=$name, n.type=$type, n.port=$port, n.mock=$mock, n.status='UNKNOWN', n.projectId=$projectId, n.scope=$scope`, { key: nodeKey(scope, topologyHash, node.id), id: node.id, name: node.name, type: node.type, port: asInt(node.port), mock: node.mock, projectId: PROJECT_ID, scope });
    for (const edge of DEFAULT_CONFIGURED_TOPOLOGY.edges) await tx.run(`MATCH (source {key:$sourceKey, projectId:$projectId, scope:$scope}) MATCH (target {key:$targetKey, projectId:$projectId, scope:$scope}) MERGE (source)-[r:${edge.relationship}]->(target) SET r.timeoutMs=$timeoutMs, r.circuitBreaker=$circuitBreaker`, { sourceKey: nodeKey(scope, topologyHash, edge.source), targetKey: nodeKey(scope, topologyHash, edge.target), projectId: PROJECT_ID, scope, timeoutMs: edge.timeoutMs === undefined ? null : asInt(edge.timeoutMs), circuitBreaker: edge.circuitBreaker });
  }

  private async readTopology(scope: string, topologyHash: string): Promise<TopologyGraph> {
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run('MATCH (n {projectId:$projectId, scope:$scope}) WHERE n:Service OR n:Datastore OPTIONAL MATCH (n)-[r:CALLS|READS|WRITES|VERIFY_TOKEN]->(target {projectId:$projectId, scope:$scope}) RETURN n, collect(CASE WHEN r IS NULL THEN null ELSE {source:n.id, target:target.id, relationship:type(r), timeoutMs:r.timeoutMs, circuitBreaker:r.circuitBreaker} END) AS relationships ORDER BY n.id', { projectId: PROJECT_ID, scope })));
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
  private async loadAllRuns(limit: number): Promise<StoredRun[]> {
    const result = await this.withRead((session) => session.executeRead((tx) => tx.run('MATCH (r:EntropyRun {projectId:$projectId}) RETURN r.snapshotJson AS snapshotJson, r.eventsJson AS eventsJson ORDER BY r.createdAt DESC LIMIT $limit', { projectId: PROJECT_ID, limit: asInt(limit) })));
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
