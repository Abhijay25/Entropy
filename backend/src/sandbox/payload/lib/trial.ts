import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ServiceMetric, TrialTelemetry } from '../../../../../shared/types.js';
import { CONTROL_PORT, HARNESS, PRIMARY_CHANNEL, SERVICE_IDS, SERVICE_PORTS, WORKLOAD } from './constants.js';
import { callJson } from './http.js';
import { computePayloadHashFromDir, computeWorkloadHash, type TrialInput } from './input.js';
import { aggregateServiceMetric } from './metrics.js';
import { startMesh, type FaultAck, type MeshHandle, type MeshSnapshot } from './mesh.js';
import type { Channel } from './spans.js';
import { runMeasuredWorkload, runWarmup, summarizeClient, type WorkloadResult } from './traffic.js';

export class HarnessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HarnessError';
  }
}

export interface TrialHarnessOptions {
  input: TrialInput;
  outputDir: string;
  /** 'child' spawns cluster.cjs from payloadDir (the real path); 'in-process' is for tests. */
  cluster: { mode: 'child'; payloadDir: string } | { mode: 'in-process' };
  /** Verify input hashes against the bundle on disk. Required for recorded trials. */
  verifyPayloadHash: boolean;
}

export interface TrialOutcome {
  report: TrialTelemetry;
  witnessFile: { fault: FaultAck; witnesses: MeshSnapshot['witnesses']; businessWitnessSpanIds: string[]; canaryWitnessSpanIds: string[] };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class TerminalLog {
  private lines: string[] = [];
  private bytes = 0;
  truncated = false;

  write(line: string): void {
    // Strip terminal escape codes and keep the log bounded.
    const clean = `${new Date().toISOString()} ${line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')}`;
    const size = Buffer.byteLength(clean) + 1;
    if (this.bytes + size > HARNESS.maxLogBytes) { this.truncated = true; return; }
    this.bytes += size;
    this.lines.push(clean);
  }

  text(): string {
    return `${this.lines.join('\n')}\n${this.truncated ? '[terminal log truncated at 256 KiB]\n' : ''}`;
  }
}

async function control<T>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{ statusCode: number; body: T }> {
  const outcome = await callJson({ port: CONTROL_PORT, method, path: route, body, deadlineMs: 5000 });
  if (outcome.kind !== 'response') throw new HarnessError('CONTROLLER_UNREACHABLE', `Controller ${route} failed: ${outcome.kind}`);
  return { statusCode: outcome.statusCode, body: outcome.body as T };
}

async function waitForReadiness(log: TerminalLog): Promise<void> {
  const deadline = performance.now() + HARNESS.readinessDeadlineMs;
  const ports = [...SERVICE_IDS.map((serviceId) => SERVICE_PORTS[serviceId]), CONTROL_PORT];
  while (performance.now() < deadline) {
    const results = await Promise.all(ports.map((port) => callJson({ port, method: 'GET', path: '/health', deadlineMs: 500 })));
    if (results.every((result) => result.kind === 'response' && result.statusCode === 200)) { log.write('readiness: all six services and controller answered /health'); return; }
    await sleep(HARNESS.readinessPollMs);
  }
  throw new HarnessError('READINESS_TIMEOUT', 'Services were not ready within 10 seconds.');
}

async function resetWhenSettled(log: TerminalLog): Promise<void> {
  const deadline = performance.now() + HARNESS.settleDeadlineMs;
  while (performance.now() < deadline) {
    const result = await control<unknown>('POST', '/control/reset', {});
    if (result.statusCode === 200) { log.write('reset: measurement counters cleared after warmup settled'); return; }
    if (result.statusCode !== 409) throw new HarnessError('RESET_FAILED', `Reset returned ${result.statusCode}.`);
    await sleep(50);
  }
  throw new HarnessError('SETTLE_TIMEOUT', 'Warmup work did not settle within 3 seconds.');
}

async function waitForServerSettle(log: TerminalLog): Promise<void> {
  const deadline = performance.now() + HARNESS.serverSettleAfterDrainMs;
  while (performance.now() < deadline) {
    const snapshot = await control<MeshSnapshot>('GET', '/control/snapshot');
    if (snapshot.body.inFlight === 0) return;
    await sleep(100);
  }
  log.write('settle: some service handlers were still running at collection; they count as started, not completed');
}

function startChildCluster(payloadDir: string, outputDir: string, log: TerminalLog): ChildProcess {
  const child = spawn(process.execPath, [path.join(payloadDir, 'cluster.cjs'), '--output-dir', outputDir], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => chunk.split('\n').filter(Boolean).forEach((line) => log.write(`cluster: ${line}`)));
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => chunk.split('\n').filter(Boolean).forEach((line) => log.write(`cluster[stderr]: ${line}`)));
  return child;
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(1000)]);
  }
}

export function buildMetrics(trialId: string, snapshot: MeshSnapshot): ServiceMetric[] {
  const startedFor = (serviceId: string, channel: Channel) => snapshot.started.find((entry) => entry.serviceId === serviceId && entry.channel === channel)?.count ?? 0;
  return SERVICE_IDS.flatMap((serviceId) => (['business', 'canary'] as const).map((channel) => aggregateServiceMetric({
    trialId, serviceId, channel, spans: snapshot.spans, started: startedFor(serviceId, channel),
    ...(serviceId === 'payment-service' && channel === 'business' ? { gate: snapshot.gate } : {})
  })));
}

/**
 * One trial: fresh mesh, readiness, warmup, reset, fault/healthy acknowledgement,
 * measured window, drain, collection, shutdown. Exit status is the caller's concern.
 */
export async function runTrialHarness(options: TrialHarnessOptions): Promise<TrialOutcome> {
  const { input, outputDir } = options;
  const log = new TerminalLog();
  const startedAt = new Date().toISOString();
  mkdirSync(outputDir, { recursive: true });
  const runtime: Record<string, unknown> = { node: process.version, platform: process.platform, arch: process.arch, startedAt, runId: input.runId, trialId: input.trialId, kind: input.kind };
  const writeRuntime = () => writeFileSync(path.join(outputDir, 'runtime.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  let child: ChildProcess | undefined;
  let mesh: MeshHandle | undefined;

  try {
    const workloadHash = computeWorkloadHash();
    runtime.workloadHash = workloadHash;
    if (workloadHash !== input.workloadHash) throw new HarnessError('WORKLOAD_MISMATCH', 'Bundled workload hash does not match input.json.');
    if (options.cluster.mode === 'child') {
      const payloadHash = computePayloadHashFromDir(options.cluster.payloadDir);
      runtime.payloadHash = payloadHash;
      if (options.verifyPayloadHash && payloadHash !== input.payloadHash) throw new HarnessError('PAYLOAD_MISMATCH', 'Bundle hash does not match input.json.');
      child = startChildCluster(options.cluster.payloadDir, outputDir, log);
    } else {
      if (options.verifyPayloadHash) throw new HarnessError('PAYLOAD_UNVERIFIABLE', 'In-process clusters cannot verify a bundle hash.');
      mesh = await startMesh({ log: (line) => log.write(line) });
    }
    log.write(`trial ${input.trialId} (${input.kind}) on node ${process.version}`);

    await waitForReadiness(log);
    const warmup = await runWarmup(input.trialId);
    const warmupErrors = warmup.filter((sample) => sample.error).length;
    log.write(`warmup: ${warmup.length} checkouts, ${warmupErrors} errors`);
    await resetWhenSettled(log);

    const mode = input.fault ? { mode: 'redis_latency', delayMs: input.fault.delayMs, durationMs: input.fault.durationMs } : { mode: 'healthy' };
    const ack = await control<FaultAck>('POST', '/control/fault', mode);
    if (ack.statusCode !== 200 || ack.body.mode !== mode.mode) throw new HarnessError('FAULT_ACK_FAILED', 'Controller did not acknowledge the requested mode.');
    log.write(`fault: controller acknowledged mode=${ack.body.mode} configHash=${ack.body.configHash}`);

    const workload: WorkloadResult = await runMeasuredWorkload(input.trialId);
    const clientSummary = summarizeClient(workload);
    log.write(`traffic: scheduled=${clientSummary.scheduled} started=${clientSummary.started} completed=${clientSummary.completed} errors=${clientSummary.errors} skipped=${clientSummary.skipped} maxInFlight=${workload.maxInFlight}`);
    await waitForServerSettle(log);

    const snapshot = (await control<MeshSnapshot>('GET', '/control/snapshot')).body;
    runtime.observed = snapshot.runtime;
    const metrics = buildMetrics(input.trialId, snapshot);
    const spanIds = new Set(snapshot.spans.filter((span) => span.faultApplied && span.serviceId === 'redis-cache').map((span) => span.id));
    const businessWitnessSpanIds = snapshot.witnesses.filter((witness) => witness.channel === 'business' && spanIds.has(witness.spanId)).map((witness) => witness.spanId);
    const canaryWitnessSpanIds = snapshot.witnesses.filter((witness) => witness.channel === 'canary' && spanIds.has(witness.spanId)).map((witness) => witness.spanId);
    const faultWitnessed = input.fault !== null && businessWitnessSpanIds.length > 0;

    const warnings: string[] = [];
    let validity: TrialTelemetry['validity'] = 'valid';
    if (warmupErrors) warnings.push(`Warmup recorded ${warmupErrors} errors (excluded from measurement).`);
    if (snapshot.spanOverflow > 0) { validity = 'inconclusive'; warnings.push(`Span cap of ${HARNESS.maxSpans} exceeded by ${snapshot.spanOverflow}; required evidence overflowed.`); }
    if ((clientSummary.businessSkipped ?? 0) > Math.floor(WORKLOAD.businessScheduled * WORKLOAD.maxSkippedBusinessFraction)) { validity = 'inconclusive'; warnings.push('Load-limited: generator skipped more than 5% of user business launches.'); }
    if (snapshot.inFlight > 0) warnings.push(`${snapshot.inFlight} service handlers were still in flight at collection.`);
    if (input.fault && !faultWitnessed) warnings.push('No delayed Redis business request was witnessed during the measured window.');
    for (const serviceId of SERVICE_IDS) {
      const primary = metrics.find((metric) => metric.serviceId === serviceId && metric.channel === PRIMARY_CHANNEL[serviceId]);
      if (primary?.smallSample && primary.sampleCount > 0) warnings.push(`${serviceId} ${primary.channel} tail percentiles are small-sample (N=${primary.sampleCount}).`);
    }

    const finishedAt = new Date().toISOString();
    runtime.finishedAt = finishedAt;
    const report: TrialTelemetry = {
      id: input.trialId, runId: input.runId, kind: input.kind, status: 'COMPLETED',
      // Provider-owned fields are placeholders; the backend overrides them.
      executionMode: 'development-local', cleanupStatus: 'NOT_CREATED', artifacts: [],
      startedAt, finishedAt, sourceSha: input.sourceSha, payloadHash: input.payloadHash, workloadHash: input.workloadHash,
      runtimeIdentity: `node-${snapshot.runtime.node}-${snapshot.runtime.platform}-${snapshot.runtime.arch}`,
      faultWitnessed, metrics, spans: snapshot.spans.slice(0, HARNESS.maxSpans), clientSummary, validity, warnings: warnings.slice(0, 32).map((warning) => warning.slice(0, 512))
    };
    const witnessFile = { fault: snapshot.fault, witnesses: snapshot.witnesses, businessWitnessSpanIds, canaryWitnessSpanIds };

    const reportText = `${JSON.stringify({ schemaVersion: 1, ...report })}\n`;
    if (Buffer.byteLength(reportText) > HARNESS.maxReportBytes) throw new HarnessError('REPORT_TOO_LARGE', 'trial.json exceeds 2 MiB.');
    writeFileSync(path.join(outputDir, 'trial.json'), reportText);
    writeFileSync(path.join(outputDir, 'spans.jsonl'), snapshot.spans.map((span) => JSON.stringify(span)).join('\n') + '\n');
    writeFileSync(path.join(outputDir, 'fault-witness.json'), `${JSON.stringify(witnessFile, null, 2)}\n`);
    log.write(`collected: ${snapshot.spans.length} spans, ${businessWitnessSpanIds.length} business + ${canaryWitnessSpanIds.length} canary fault witnesses`);
    return { report, witnessFile };
  } catch (error) {
    runtime.error = error instanceof HarnessError ? { code: error.code, message: error.message } : { code: 'HARNESS_ERROR', message: error instanceof Error ? error.message : String(error) };
    log.write(`error: ${JSON.stringify(runtime.error)}`);
    throw error;
  } finally {
    await control('POST', '/control/shutdown', {}).catch(() => undefined);
    if (child) await stopChild(child);
    if (mesh) await mesh.close();
    writeRuntime();
    writeFileSync(path.join(outputDir, 'terminal.log'), log.text());
  }
}
