import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';

import express, { type NextFunction, type Request, type Response } from 'express';

import { EmptyBodySchema, EntityIdSchema, OperationKeyHeaderSchema, type AgentStreamEvent } from '../../shared/types.js';
import { nosanaClient } from './agent/nosanaClient.js';
import { EventHub } from './agent/events.js';
import { Orchestrator, OrchestratorError, type Repository } from './agent/orchestrator.js';
import { DiagnosticAgent } from './agent/diagnosticAgent.js';
import { config } from './config.js';
import { findArtifact } from './evidence/collect.js';
import { Neo4jGraphRepository } from './graph/neo4jClient.js';
import { readIntegrations } from './integrations.js';
import { DaytonaProvider } from './sandbox/daytonaRunner.js';
import { LocalProcessProvider } from './sandbox/localProvider.js';
import { DEVELOPMENT_PAYLOAD } from './sandbox/payloadManifest.js';
import { SandboxBudget, type SandboxProvider } from './sandbox/provider.js';

const HEARTBEAT_MS = 15_000;
const development = config.entropy.mode === 'development';

function buildRepository(): Repository {
  const { uri, username, password, database } = config.neo4j;
  if (uri && password) return new Neo4jGraphRepository({ uri, username, password, database });
  if (development) return new Neo4jGraphRepository({ developmentMode: true });
  throw new Error('NEO4J_URI and NEO4J_PASSWORD are required in live mode (set ENTROPY_MODE=development for a labeled in-memory store).');
}

function buildProvider(): SandboxProvider {
  if (config.daytona.apiKey) return DaytonaProvider.fromConfig();
  if (development) return new LocalProcessProvider();
  throw new Error('DAYTONA_API_KEY is required in live mode (set ENTROPY_MODE=development for labeled local trials).');
}

function startupConfig<T>(build: () => T): T {
  try {
    return build();
  } catch (error) {
    console.error(`Entropy cannot start: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const repository = startupConfig(buildRepository);
const provider = startupConfig(buildProvider);
const budget = new SandboxBudget(Math.min(config.entropy.maxSandboxes, provider.maxConcurrent));
const events = new EventHub(repository);
const payloadSelector = config.entropy.sourceSha ?? (development ? DEVELOPMENT_PAYLOAD : undefined);
const diagnostics = new DiagnosticAgent({ repository, nosana: nosanaClient, provider, budget, events, payloadSelector });
const graphSourceLabel = config.neo4j.uri && config.neo4j.password ? 'Neo4j' : 'the in-memory DEVELOPMENT graph store (not Neo4j)';
const orchestrator = new Orchestrator({ repository, nosana: nosanaClient, provider, budget, events, payloadSelector, diagnostics, graphSourceLabel });

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '16kb', strict: true }));
app.use((request, response, next) => {
  response.locals.requestId = randomUUID();
  next();
});

const asyncRoute = (handler: (request: Request, response: Response) => Promise<void>) => (request: Request, response: Response, next: NextFunction) => { handler(request, response).catch(next); };

function entityId(value: unknown): string {
  const parsed = EntityIdSchema.safeParse(value);
  if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', 'Invalid identifier.');
  return parsed.data;
}

function requireEmptyBody(request: Request): void {
  if (request.body === undefined) return;
  if (!EmptyBodySchema.safeParse(request.body).success) throw new ApiError(400, 'INVALID_INPUT', 'This action accepts only an empty JSON object.');
}

function operationKey(request: Request): string {
  const parsed = OperationKeyHeaderSchema.safeParse({ 'idempotency-key': request.header('idempotency-key') });
  if (!parsed.success) throw new ApiError(400, 'INVALID_INPUT', 'An Idempotency-Key UUID header is required.');
  return parsed.data['idempotency-key'];
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, mode: config.entropy.mode, executionMode: provider.executionMode, payload: payloadSelector ?? null, activeWorkflow: orchestrator.activeWorkflow ?? null, sandboxesReserved: budget.inUse, sandboxCapacity: budget.capacity });
});

app.get('/api/integrations', (_request, response) => {
  response.json(readIntegrations());
});

app.get('/api/topology', asyncRoute(async (request, response) => {
  const runId = request.query.runId === undefined ? undefined : entityId(request.query.runId);
  const trialId = request.query.trialId === undefined ? undefined : entityId(request.query.trialId);
  if (runId && !(await repository.getRun(runId))) throw new ApiError(404, 'NOT_FOUND', 'Unknown run.');
  try {
    response.json(await repository.getGraph({ ...(runId ? { runId } : {}), ...(trialId ? { trialId } : {}) }));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Unknown')) throw new ApiError(404, 'NOT_FOUND', error.message);
    throw error;
  }
}));

app.post('/api/chaos/run', asyncRoute(async (request, response) => {
  requireEmptyBody(request);
  response.status(202).json(await orchestrator.startRun(operationKey(request)));
}));

app.get('/api/runs', asyncRoute(async (_request, response) => {
  response.json(await repository.listRuns(20));
}));

app.get('/api/runs/:id', asyncRoute(async (request, response) => {
  const run = await repository.getRun(entityId(request.params.id));
  if (!run) throw new ApiError(404, 'NOT_FOUND', 'Unknown run.');
  response.json(run);
}));

app.post('/api/runs/:id/cancel', asyncRoute(async (request, response) => {
  requireEmptyBody(request);
  response.status(202).json(await orchestrator.cancel(entityId(request.params.id)));
}));

app.post('/api/runs/:id/reproduce', asyncRoute(async (request, response) => {
  requireEmptyBody(request);
  response.status(202).json(await orchestrator.reproduce(entityId(request.params.id), operationKey(request)));
}));

app.post('/api/runs/:id/investigate', asyncRoute(async (request, response) => {
  requireEmptyBody(request);
  response.status(202).json(await orchestrator.investigate(entityId(request.params.id), operationKey(request)));
}));

app.get('/api/diagnostics/:id', asyncRoute(async (request, response) => {
  const session = await repository.getDiagnostic(entityId(request.params.id));
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Unknown diagnostic session.');
  response.json(session);
}));

app.post('/api/diagnostics/:id/cancel', asyncRoute(async (request, response) => {
  requireEmptyBody(request);
  const id = entityId(request.params.id);
  const session = await repository.getDiagnostic(id);
  if (!session) throw new ApiError(404, 'NOT_FOUND', 'Unknown diagnostic session.');
  orchestrator.cancelDiagnostic(id);
  response.status(202).json(session);
}));

app.get('/api/artifacts/:id', (request, response) => {
  const found = findArtifact(entityId(request.params.id));
  if (!found) throw new ApiError(404, 'NOT_FOUND', 'Unknown artifact.');
  if (!found.artifact.available) throw new ApiError(404, 'ARTIFACT_UNAVAILABLE', found.artifact.truncated ? 'Artifact exceeded its size bound and was not retained.' : 'Artifact was not collected.');
  response.setHeader('content-type', `${found.artifact.contentType}; charset=utf-8`);
  response.setHeader('x-content-type-options', 'nosniff');
  createReadStream(found.filePath).on('error', () => response.destroy()).pipe(response);
});

app.get('/api/stream', asyncRoute(async (request, response) => {
  const runId = entityId(request.query.runId);
  if (!(await repository.getRun(runId))) throw new ApiError(404, 'NOT_FOUND', 'Unknown run.');
  const lastHeader = request.header('last-event-id') ?? (typeof request.query.lastEventId === 'string' ? request.query.lastEventId : undefined);
  const lastSeq = lastHeader ? Number(lastHeader.split(':').pop()) : 0;
  let sentSeq = Number.isInteger(lastSeq) && lastSeq >= 0 ? lastSeq : 0;

  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = (event: AgentStreamEvent) => {
    if (event.type !== 'RESYNC' && event.seq <= sentSeq) return;
    if (event.type !== 'RESYNC') sentSeq = event.seq;
    response.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  // Subscribe before replay so nothing published in between is lost; send() de-duplicates by seq.
  const buffered: AgentStreamEvent[] = [];
  let replaying = true;
  const unsubscribe = events.subscribe(runId, (event) => { if (replaying) buffered.push(event); else send(event); });
  const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), HEARTBEAT_MS);
  request.on('close', () => { clearInterval(heartbeat); unsubscribe(); });

  const replay = await repository.getEventsAfter(runId, sentSeq);
  if (replay.truncated) send({ id: `${runId}:resync`, runId, seq: sentSeq, type: 'RESYNC', timestamp: new Date().toISOString(), message: 'Event history was truncated; fetch the latest snapshot.' });
  replay.events.forEach(send);
  replaying = false;
  buffered.forEach(send);
}));

app.use('/api', (_request, _response, next) => next(new ApiError(404, 'NOT_FOUND', 'Unknown route.')));

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  const requestId = String(response.locals.requestId ?? randomUUID());
  if (response.headersSent) { response.end(); return; }
  if (error instanceof ApiError || error instanceof OrchestratorError) {
    const status = error instanceof ApiError ? error.status : error.httpStatus;
    response.status(status).json({ error: { code: error.code, message: error.message.slice(0, 512), requestId } });
    return;
  }
  const bodyError = error as { type?: string; status?: number };
  if (bodyError.type === 'entity.too.large' || bodyError.type === 'entity.parse.failed') {
    response.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Request body is invalid or too large.', requestId } });
    return;
  }
  console.error(`[${requestId}] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  response.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal error.', requestId } });
});

async function main(): Promise<void> {
  if (repository instanceof Neo4jGraphRepository && !development) {
    await repository.ensureSchema();
    await repository.seedTopology();
  }
  const server = app.listen(config.api.port, config.api.host, () => {
    console.log(`Entropy API on http://${config.api.host}:${config.api.port} (mode=${config.entropy.mode}, execution=${provider.executionMode}, payload=${payloadSelector ?? 'not configured'})`);
    if (development) console.log('DEVELOPMENT MODE: results are labeled and excluded from live acceptance.');
  });
  orchestrator.recover().then((result) => {
    if (result.interrupted.length || result.deleted.length || result.failedCleanup.length) console.log(`Recovery: interrupted=${result.interrupted.length} deleted=${result.deleted.length} failedCleanup=${result.failedCleanup.join(', ') || 'none'}`);
  }, (error: unknown) => console.error(`Recovery failed: ${error instanceof Error ? error.message : String(error)}`));

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    console.log('Shutting down: cancelling active work and cleaning up sandboxes…');
    server.close();
    const active = orchestrator.activeWorkflow;
    if (active) {
      if (active.kind === 'diagnostic') orchestrator.cancelDiagnostic(active.id);
      else await orchestrator.cancel(active.runId).catch(() => undefined);
      await Promise.race([orchestrator.idle(), new Promise((resolve) => setTimeout(resolve, 90_000))]);
    }
    await diagnostics.close();
    if (repository instanceof Neo4jGraphRepository) await repository.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
