import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CATALOGUE_FALLBACK_HYPOTHESIS, DiagnosticPromptContextSchema, SERVICE_REGISTRY, type EvidenceAnalysis, type RequestSpan, type ServiceId, type ServiceMetric, type TrialTelemetry } from '../../../shared/types.js';
import { Neo4jGraphRepository } from '../graph/neo4jClient.js';
import type { LoadedPayload } from '../sandbox/payloadManifest.js';
import { ProviderTimeoutError, SandboxBudget, type ExecuteResult, type SandboxHandle, type SandboxLabels, type SandboxProvider, type TrustedCommand } from '../sandbox/provider.js';
import { DiagnosticAgent, type McpPort } from './diagnosticAgent.js';
import { EventHub } from './events.js';
import { Orchestrator, type NosanaPort } from './orchestrator.js';

const SHA = 'c'.repeat(40);
const PAYLOAD_HASH = 'd'.repeat(64);
const WORKLOAD_HASH = 'e'.repeat(64);
const PRIMARY: Record<ServiceId, 'business' | 'canary'> = { frontend: 'business', 'order-service': 'business', 'payment-service': 'business', 'auth-service': 'business', 'redis-cache': 'canary', 'postgres-db': 'canary' };

const payload: LoadedPayload = {
  manifest: { schemaVersion: 1, sourceSha: SHA, archiveSha256: 'f'.repeat(64), productLockSha256: 'f'.repeat(64), buildTool: { name: 'esbuild', version: '0.28.2' }, payloadHash: PAYLOAD_HASH, files: [], topologyHash: 'a'.repeat(64), workloadHash: WORKLOAD_HASH, targetRuntime: 'node22', sandboxImage: 'test-image', createdAt: '2026-01-01T00:00:00.000Z', development: false },
  files: [{ name: 'runTrial.cjs', bytes: Buffer.from('// bundle') }]
};

vi.mock('../sandbox/payloadManifest.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sandbox/payloadManifest.js')>()),
  loadPreparedPayload: () => payload
}));

function metric(trialId: string, serviceId: ServiceId, status: ServiceMetric['status'], errors = 0): ServiceMetric {
  const completed = 20;
  return { id: `${trialId}:${serviceId}:${PRIMARY[serviceId]}`, serviceId, channel: PRIMARY[serviceId], status, requestsStarted: completed, requestsCompleted: completed, errorsTotal: errors, timeoutsTotal: 0, errorRate: errors / completed, latencyP50Ms: 5, latencyP95Ms: status === 'HEALTHY' ? 10 : 3000, latencyP99Ms: 10, sampleCount: completed, smallSample: false };
}

/** A synthetic but schema-valid payload report derived from the uploaded input.json. */
function syntheticReport(input: { runId: string; trialId: string; kind: TrialTelemetry['kind']; fault: unknown }): TrialTelemetry {
  const chaos = input.fault !== null;
  const at = '2026-01-01T00:00:00.000Z';
  const trace = `${input.trialId}-co-0001`;
  const span = (id: string, serviceId: ServiceId, faultApplied = false): RequestSpan => ({ id: `${trace}:${id}`, kind: 'server', traceId: trace, serviceId, channel: 'business', startedAt: at, durationMs: faultApplied ? 3000 : 5, statusCode: 200, faultApplied });
  const affected: ServiceId[] = ['frontend', 'order-service', 'payment-service', 'auth-service', 'redis-cache'];
  return {
    id: input.trialId, runId: input.runId, kind: input.kind, status: 'COMPLETED', executionMode: 'development-local', cleanupStatus: 'NOT_CREATED', startedAt: at, finishedAt: at,
    sourceSha: SHA, payloadHash: PAYLOAD_HASH, workloadHash: WORKLOAD_HASH, runtimeIdentity: 'node', faultWitnessed: chaos,
    metrics: SERVICE_REGISTRY.map((node) => metric(input.trialId, node.id, chaos && affected.includes(node.id) ? (node.id === 'redis-cache' || node.id === 'auth-service' ? 'DEGRADED' : 'DOWN') : 'HEALTHY', chaos && ['frontend', 'order-service', 'payment-service'].includes(node.id) ? 20 : 0)),
    spans: chaos ? [span('1', 'frontend'), span('2', 'order-service'), span('3', 'payment-service'), span('4', 'auth-service'), span('5', 'redis-cache', true)] : [],
    artifacts: [],
    clientSummary: chaos
      ? { scheduled: 130, started: 130, completed: 130, skipped: 0, errors: 110, checkoutStarted: 100, checkoutCompleted: 100, checkoutErrors: 100, checkoutErrorRate: 1, checkoutP95Ms: 1200, businessSkipped: 0, sessionCompleted: 10, redisCanaryCompleted: 10, postgresCanaryCompleted: 10 }
      : { scheduled: 130, started: 130, completed: 130, skipped: 0, errors: 0, checkoutStarted: 100, checkoutCompleted: 100, checkoutErrors: 0, checkoutErrorRate: 0, checkoutP95Ms: 20, businessSkipped: 0, sessionCompleted: 10, redisCanaryCompleted: 10, postgresCanaryCompleted: 10 },
    validity: 'valid', warnings: []
  };
}

class FakeProvider implements SandboxProvider {
  readonly executionMode = 'daytona' as const;
  maxConcurrent = 2;
  private sequence = 0;
  readonly files = new Map<string, Map<string, Buffer>>();
  readonly labels = new Map<string, Record<string, string>>();
  readonly live = new Set<string>();
  peakLive = 0;
  readonly deleted: string[] = [];
  readonly executeLog: Array<{ sandboxId: string; command: TrustedCommand; startedAt: number; endedAt?: number }> = [];
  createTimeouts: Array<'created' | 'none'> = [];
  createDelayMs = 0;
  failDeleteFor = new Set<string>();
  failExecuteFor = new Set<string>();
  executeDelayMs = 20;
  hangExecute = false;

  async create(labels: SandboxLabels): Promise<SandboxHandle> {
    const id = `sbx-${++this.sequence}`;
    if (this.createDelayMs) await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    const behavior = this.createTimeouts.shift();
    if (behavior !== 'none') {
      this.files.set(id, new Map());
      this.labels.set(id, { ...labels });
      this.live.add(id);
      this.peakLive = Math.max(this.peakLive, this.live.size);
    }
    if (behavior) throw new ProviderTimeoutError('sandbox create');
    return { id, labels: { ...labels } };
  }

  async upload(sandboxId: string, files: ReadonlyArray<{ remotePath: string; bytes: Buffer }>): Promise<void> {
    for (const file of files) this.files.get(sandboxId)!.set(file.remotePath, file.bytes);
  }

  async execute(sandboxId: string, command: TrustedCommand): Promise<ExecuteResult> {
    if (command === 'node-version') return { exitCode: 0, output: 'v22.12.0\n' };
    const entry = { sandboxId, command, startedAt: performance.now() } as FakeProvider['executeLog'][number];
    this.executeLog.push(entry);
    if (this.hangExecute) await new Promise(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, this.executeDelayMs));
    entry.endedAt = performance.now();
    const fs = this.files.get(sandboxId);
    if (!fs) throw new Error('sandbox deleted');
    const input = JSON.parse(fs.get('input.json')!.toString('utf8')) as Parameters<typeof syntheticReport>[0];
    if (this.failExecuteFor.has(input.kind)) return { exitCode: 2, output: 'runTrial failed: synthetic' };
    fs.set('out/trial.json', Buffer.from(JSON.stringify({ schemaVersion: 1, ...syntheticReport(input) })));
    fs.set('out/runtime.json', Buffer.from(JSON.stringify({ payloadHash: PAYLOAD_HASH, observed: { node: 'v22.12.0', platform: 'linux', arch: 'x64' } })));
    fs.set('out/spans.jsonl', Buffer.from('\n'));
    fs.set('out/fault-witness.json', Buffer.from('{}'));
    fs.set('out/terminal.log', Buffer.from('ok\n'));
    return { exitCode: 0, output: '{}' };
  }

  async fileSize(sandboxId: string, remotePath: string): Promise<number | null> {
    return this.files.get(sandboxId)?.get(remotePath)?.length ?? null;
  }

  async download(sandboxId: string, remotePath: string): Promise<Buffer> {
    return this.files.get(sandboxId)!.get(remotePath)!;
  }

  async destroy(sandboxId: string): Promise<void> {
    if (this.failDeleteFor.has(sandboxId)) throw new Error('delete failed');
    this.files.delete(sandboxId);
    this.live.delete(sandboxId);
    this.deleted.push(sandboxId);
  }

  async listOwned(filter: Partial<SandboxLabels>): Promise<SandboxHandle[]> {
    return [...this.live].filter((id) => Object.entries(filter).every(([key, value]) => this.labels.get(id)?.[key] === value)).map((id) => ({ id, labels: this.labels.get(id)! }));
  }
}

const analysis: EvidenceAnalysis = { id: 'analysis-1', source: 'nosana', model: 'test-model', status: 'available', summary: 'Measured.', hypotheses: [], remediation: [], promptVersion: 'v1', createdAt: '2026-01-01T00:00:00.000Z' };
const nosana: NosanaPort = {
  hypothesize: async () => ({ ...CATALOGUE_FALLBACK_HYPOTHESIS, id: 'hypothesis-1', source: 'nosana', model: 'test-model' }),
  analyze: async () => analysis,
  nextDiagnosticAction: async () => ({ action: 'read_evidence' })
};

let tempDir: string;
let ids: number;

function setup(options: { provider?: FakeProvider; capacity?: number; repository?: Neo4jGraphRepository } = {}) {
  const provider = options.provider ?? new FakeProvider();
  const repository = options.repository ?? new Neo4jGraphRepository({ inMemory: true });
  const budget = new SandboxBudget(options.capacity ?? 2);
  const events = new EventHub(repository);
  const orchestrator = new Orchestrator({ repository, nosana, provider, budget, events, payloadSelector: SHA, createId: () => `run-${++ids}`, recoveryDir: path.join(tempDir, 'recovery') });
  return { provider, repository, budget, events, orchestrator };
}

beforeEach(() => { tempDir = mkdtempSync(path.join(os.tmpdir(), 'entropy-orchestrator-')); ids = 0; });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('Orchestrator', () => {
  it('runs baseline then an overlapping matched pair, never exceeding two live sandboxes, and deletes everything', async () => {
    const { orchestrator, provider, repository, budget } = setup();
    const { runId } = await orchestrator.startRun('11111111-1111-4111-8111-111111111111');
    await orchestrator.idle();
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(run.trials.map((trial) => trial.kind).sort()).toEqual(['baseline', 'chaos', 'control']);
    expect(run.trials.every((trial) => trial.cleanupStatus === 'DELETED' && trial.executionMode === 'daytona' && trial.sandboxId)).toBe(true);
    expect(run.actualBlastRadiusIds.sort()).toEqual(['auth-service', 'frontend', 'order-service', 'payment-service', 'redis-cache']);
    expect(provider.peakLive).toBe(2);
    expect(provider.live.size).toBe(0);
    expect(budget.inUse).toBe(0);
    const [control, chaos] = provider.executeLog.slice(1);
    expect(control!.startedAt).toBeLessThan(chaos!.endedAt!);
    expect(chaos!.startedAt).toBeLessThan(control!.endedAt!);
    expect(run.analysis?.source).toBe('nosana');
  });

  it('returns the same run for a duplicate operation key and rejects overlapping workflows', async () => {
    const { orchestrator } = setup();
    const key = '22222222-2222-4222-8222-222222222222';
    const first = await orchestrator.startRun(key);
    expect(await orchestrator.startRun(key)).toEqual(first);
    await expect(orchestrator.startRun('33333333-3333-4333-8333-333333333333')).rejects.toMatchObject({ code: 'BUSY', httpStatus: 409 });
    await orchestrator.idle();
    expect(await orchestrator.startRun(key)).toEqual(first);
  });

  it('rejects an operation key reused for a different action with a 409, not an internal error', async () => {
    const { orchestrator } = setup();
    const key = '12121212-1212-4121-8121-121212121212';
    const { runId } = await orchestrator.startRun(key);
    await orchestrator.idle();
    await expect(orchestrator.reproduce(runId, key)).rejects.toMatchObject({ code: 'OPERATION_KEY_REUSED', httpStatus: 409 });
    await expect(orchestrator.investigate(runId, key)).rejects.toMatchObject({ code: 'OPERATION_KEY_REUSED', httpStatus: 409 });
  });

  it('stops after an invalid baseline without scheduling matched trials', async () => {
    const provider = new FakeProvider();
    provider.failExecuteFor.add('baseline');
    const { orchestrator, repository } = setup({ provider });
    const { runId } = await orchestrator.startRun('44444444-4444-4444-8444-444444444444');
    await orchestrator.idle();
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('FAILED');
    expect(run.trials.map((trial) => trial.kind)).toEqual(['baseline']);
    expect(run.trials[0]).toMatchObject({ status: 'FAILED', cleanupStatus: 'DELETED', error: { code: 'HARNESS_FAILED' } });
    expect(provider.live.size).toBe(0);
  });

  it('cancels mid-trial, preserves the partial record, and still deletes sandboxes', async () => {
    const provider = new FakeProvider();
    provider.hangExecute = true;
    const { orchestrator, repository, budget } = setup({ provider });
    const { runId } = await orchestrator.startRun('55555555-5555-4555-8555-555555555555');
    await vi.waitFor(() => expect(provider.executeLog.length).toBe(1));
    await orchestrator.cancel(runId);
    await orchestrator.idle();
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('CANCELLED');
    expect(run.trials[0]).toMatchObject({ status: 'CANCELLED', cleanupStatus: 'DELETED' });
    expect(provider.live.size).toBe(0);
    expect(budget.inUse).toBe(0);
  });

  it('does not leak a sandbox whose create completes after cancellation', async () => {
    const provider = new FakeProvider();
    provider.createDelayMs = 150;
    const { orchestrator, repository, budget } = setup({ provider });
    const { runId } = await orchestrator.startRun('ffffffff-ffff-4fff-8fff-ffffffffffff');
    await new Promise((resolve) => setTimeout(resolve, 40));
    await orchestrator.cancel(runId);
    await orchestrator.idle();
    expect(provider.live.size).toBe(0);
    expect(budget.inUse).toBe(0);
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('CANCELLED');
    expect(run.trials[0]).toMatchObject({ status: 'CANCELLED', cleanupStatus: 'DELETED' });
  });

  it('adopts a sandbox created by an ambiguous timed-out create instead of leaking it', async () => {
    const provider = new FakeProvider();
    provider.createTimeouts = ['created'];
    const { orchestrator, repository } = setup({ provider });
    const { runId } = await orchestrator.startRun('66666666-6666-4666-8666-666666666666');
    await orchestrator.idle();
    expect((await repository.getRun(runId))!.status).toBe('COMPLETED');
    expect(provider.live.size).toBe(0);
    expect(provider.deleted).toContain('sbx-1');
  });

  it('keeps capacity reserved when cleanup fails, blocking a pair that would exceed the cap', async () => {
    const provider = new FakeProvider();
    provider.failDeleteFor.add('sbx-1');
    const { orchestrator, repository, budget } = setup({ provider });
    const { runId } = await orchestrator.startRun('77777777-7777-4777-8777-777777777777');
    await orchestrator.idle();
    const run = (await repository.getRun(runId))!;
    expect(run.trials.find((trial) => trial.kind === 'baseline')!.cleanupStatus).toBe('FAILED');
    expect(run.status).toBe('FAILED');
    expect(run.trials.filter((trial) => trial.kind !== 'baseline')).toEqual([]);
    expect(budget.inUse).toBe(1);
    expect(provider.peakLive).toBe(1);
  });

  it('serializes in single-slot mode and labels the run', async () => {
    const provider = new FakeProvider();
    provider.maxConcurrent = 1;
    const { orchestrator, repository } = setup({ provider, capacity: 1 });
    const { runId } = await orchestrator.startRun('88888888-8888-4888-8888-888888888888');
    await orchestrator.idle();
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(provider.peakLive).toBe(1);
    expect(run.warnings.some((warning) => warning.includes('serially'))).toBe(true);
  });

  it('reproduces with a new matched pair without replacing original evidence', async () => {
    const { orchestrator, repository } = setup();
    const { runId } = await orchestrator.startRun('99999999-9999-4999-8999-999999999999');
    await orchestrator.idle();
    const before = (await repository.getRun(runId))!;
    const key = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const accepted = await orchestrator.reproduce(runId, key);
    expect(await orchestrator.reproduce(runId, key)).toEqual(accepted);
    await orchestrator.idle();
    const after = (await repository.getRun(runId))!;
    expect(after.trials).toHaveLength(5);
    expect(after.trials.find((trial) => trial.kind === 'chaos')).toEqual(before.trials.find((trial) => trial.kind === 'chaos'));
    expect(after.actualBlastRadiusIds).toEqual(before.actualBlastRadiusIds);
    expect(after.reproduction?.classification).toBe('reproduced');
    await expect(orchestrator.reproduce(runId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).resolves.toEqual(accepted);
  });

  it('keeps a valid measurement COMPLETED when analysis throws, recording an explicit unavailable analysis', async () => {
    const failing: NosanaPort = { ...nosana, analyze: async () => { throw new Error('Evidence prompt exceeds the 12 KiB limit.'); } };
    const repository = new Neo4jGraphRepository({ inMemory: true });
    const orchestrator = new Orchestrator({ repository, nosana: failing, provider: new FakeProvider(), budget: new SandboxBudget(2), events: new EventHub(repository), payloadSelector: SHA, createId: () => `run-${++ids}`, recoveryDir: path.join(tempDir, 'recovery') });
    const { runId } = await orchestrator.startRun('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    await orchestrator.idle();
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('COMPLETED');
    expect(run.analysis).toMatchObject({ status: 'unavailable', source: 'deterministic' });
    expect(run.warnings.some((warning) => warning.includes('12 KiB'))).toBe(true);
  });

  it('marks unfinished runs interrupted on restart and deletes their sandboxes', async () => {
    const repository = new Neo4jGraphRepository({ inMemory: true });
    const first = setup({ repository, provider: Object.assign(new FakeProvider(), { hangExecute: true }) });
    const { runId } = await first.orchestrator.startRun('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await vi.waitFor(() => expect(first.provider.executeLog.length).toBe(1));
    // Simulate process loss: a new orchestrator over the same store and provider account.
    const restarted = setup({ repository, provider: first.provider });
    const result = await restarted.orchestrator.recover();
    expect(result.interrupted).toEqual([runId]);
    expect(result.deleted).toEqual(['sbx-1']);
    const run = (await repository.getRun(runId))!;
    expect(run.status).toBe('INTERRUPTED');
    expect(run.trials[0]).toMatchObject({ status: 'INTERRUPTED', cleanupStatus: 'DELETED' });
  });
});

describe('DiagnosticAgent', () => {
  const mapping = { discoveredAt: '2026-01-01T00:00:00.000Z', toolNames: ['download_file'], readFile: { tool: 'download_file', sandboxArg: 'id', valueArg: 'file_path' }, schemas: {} };

  async function completedRun() {
    const env = setup();
    const { runId } = await env.orchestrator.startRun('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    await env.orchestrator.idle();
    return { ...env, run: (await env.repository.getRun(runId))! };
  }

  it('reads evidence through the discovered MCP tool in a separate sandbox and deletes it', async () => {
    const { run, repository, provider, budget, events } = await completedRun();
    const calls: Array<{ tool: string; args: [string, string] }> = [];
    const mcp: McpPort = { call: async (binding, sandboxId, value) => { calls.push({ tool: binding.tool, args: [sandboxId, value] }); return { toolName: binding.tool, ok: true, text: '{"runId":"evidence"}' }; }, close: async () => undefined };
    const actions = [{ action: 'read_evidence' as const }, { action: 'finish' as const, summary: 'Redis delay held Payment slots.', metricIds: [], spanIds: [] }];
    const agent = new DiagnosticAgent({ repository, nosana: { ...nosana, nextDiagnosticAction: async () => actions.shift()! }, provider, budget, events, payloadSelector: SHA, connectMcp: async () => mcp, mapping: () => mapping });
    await agent.launch(run, `${run.id}-diagnostic`, new AbortController().signal);
    const session = (await repository.getDiagnostic(`${run.id}-diagnostic`))!;
    expect(session).toMatchObject({ status: 'COMPLETED', cleanupStatus: 'DELETED', finalExplanation: 'Redis delay held Payment slots.' });
    expect(session.error).toBeUndefined();
    expect(session.toolTrace).toHaveLength(1);
    expect(session.toolTrace[0]).toMatchObject({ toolName: 'download_file', action: 'read_evidence', success: true });
    expect(calls[0]!.args[0]).toBe(session.sandboxId);
    expect(calls[0]!.args[1]).toBe('/tmp/entropy/.entropy-diagnostic/evidence.json');
    expect(provider.live.size).toBe(0);
    expect(budget.inUse).toBe(0);
  });

  it('sends Nosana a context that satisfies the strict DiagnosticPromptContext schema, including the tool trace', async () => {
    const { run, repository, provider, budget, events } = await completedRun();
    const contexts: unknown[] = [];
    const actions = [{ action: 'read_evidence' as const }, { action: 'finish' as const, summary: 'Done.', metricIds: [], spanIds: [] }];
    const agent = new DiagnosticAgent({ repository, nosana: { ...nosana, nextDiagnosticAction: async (context) => { contexts.push(context); return actions.shift()!; } }, provider, budget, events, payloadSelector: SHA, connectMcp: async () => ({ call: async (binding) => ({ toolName: binding.tool, ok: true, text: '{}' }), close: async () => undefined }), mapping: () => mapping });
    await agent.launch(run, `${run.id}-diagnostic`, new AbortController().signal);
    expect(contexts).toHaveLength(2);
    for (const context of contexts) expect(DiagnosticPromptContextSchema.safeParse(context).error?.issues ?? []).toEqual([]);
    expect((contexts[1] as { toolTrace?: unknown[] }).toolTrace).toHaveLength(1);
  });

  it('labels a session that finishes without any MCP call as no-tool evidence', async () => {
    const { run, repository, provider, budget, events } = await completedRun();
    const agent = new DiagnosticAgent({ repository, nosana: { ...nosana, nextDiagnosticAction: async () => ({ action: 'finish', summary: 'Guess.', metricIds: [], spanIds: [] }) }, provider, budget, events, payloadSelector: SHA, connectMcp: async () => ({ call: async () => { throw new Error('unused'); }, close: async () => undefined }), mapping: () => mapping });
    await agent.launch(run, `${run.id}-diagnostic`, new AbortController().signal);
    const session = (await repository.getDiagnostic(`${run.id}-diagnostic`))!;
    expect(session).toMatchObject({ status: 'COMPLETED', cleanupStatus: 'DELETED', error: { code: 'NO_TOOL_EVIDENCE' } });
    expect(session.toolTrace).toEqual([]);
  });

  it('never exceeds two MCP calls even if the model keeps asking', async () => {
    const { run, repository, provider, budget, events } = await completedRun();
    let calls = 0;
    const agent = new DiagnosticAgent({ repository, nosana: { ...nosana, nextDiagnosticAction: async () => ({ action: 'read_evidence' }) }, provider, budget, events, payloadSelector: SHA, connectMcp: async () => ({ call: async (binding) => { calls += 1; return { toolName: binding.tool, ok: true, text: '{}' }; }, close: async () => undefined }), mapping: () => mapping });
    await agent.launch(run, `${run.id}-diagnostic`, new AbortController().signal);
    const session = (await repository.getDiagnostic(`${run.id}-diagnostic`))!;
    expect(calls).toBe(2);
    expect(session).toMatchObject({ status: 'FAILED', cleanupStatus: 'DELETED', error: { code: 'NO_FINISH' } });
  });
});
