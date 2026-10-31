// npm run payload:check — local healthy/fault/load correctness of the bundled payload.
// Development check only: it bundles the working tree, so results are never recorded evidence.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { evaluateBaselineTrial, evaluateChaosTrial, evaluateMatchedPairAndBlastRadius, TrialTelemetrySchema, type TrialTelemetry } from '../shared/types.js';
import { CONTROL_PORT, DEMO_TOKEN, SERVICE_PORTS } from '../backend/src/sandbox/payload/lib/constants.js';
import { callJson } from '../backend/src/sandbox/payload/lib/http.js';
import { computeWorkloadHash, type TrialInput } from '../backend/src/sandbox/payload/lib/input.js';
import { bundlePayload } from './lib/bundle.js';

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.entropy', 'payload-check');
const results: Array<{ check: string; pass: boolean; detail: string }> = [];
const record = (check: string, pass: boolean, detail: string) => { results.push({ check, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${check} — ${detail}`); };

function runNode(args: string[], cwd: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${args[0]} exceeded ${timeoutMs} ms`)); }, timeoutMs);
    child.on('exit', (code) => { clearTimeout(timer); if (code !== 0 && stderr) console.error(stderr.trim()); resolve(code ?? 1); });
  });
}

async function runTrial(bundleDir: string, input: TrialInput): Promise<TrialTelemetry> {
  const dir = path.join(WORK, input.trialId);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'input.json'), JSON.stringify(input, null, 2));
  const exitCode = await runNode([path.join(bundleDir, 'runTrial.cjs'), '--input', 'input.json', '--output-dir', 'out'], dir, 60_000);
  if (exitCode !== 0) throw new Error(`runTrial exited ${exitCode}; see ${path.join(dir, 'out', 'terminal.log')}`);
  const { schemaVersion: _schemaVersion, ...report } = JSON.parse(readFileSync(path.join(dir, 'out', 'trial.json'), 'utf8')) as Record<string, unknown>;
  return TrialTelemetrySchema.parse(report);
}

async function checkAuthFailsClosed(bundleDir: string): Promise<void> {
  const child = spawn(process.execPath, [path.join(bundleDir, 'cluster.cjs'), '--output-dir', path.join(WORK, 'auth')], { stdio: 'ignore' });
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const health = await callJson({ port: CONTROL_PORT, method: 'GET', path: '/health', deadlineMs: 200 });
      if (health.kind === 'response') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (const mode of [{ mode: 'healthy' }, { mode: 'redis_latency', delayMs: 3000, durationMs: 10000 }]) {
      await callJson({ port: CONTROL_PORT, method: 'POST', path: '/control/fault', body: mode, deadlineMs: 2000 });
      const checkout = await callJson({ port: SERVICE_PORTS.frontend, method: 'POST', path: '/checkout', body: { orderId: 'order-9999', token: 'unknown-token', amountCents: 2500 }, deadlineMs: 6000 });
      const session = await callJson({ port: SERVICE_PORTS.frontend, method: 'GET', path: '/session', headers: { authorization: 'Bearer unknown-token' }, deadlineMs: 6000 });
      const valid = await callJson({ port: SERVICE_PORTS['auth-service'], method: 'POST', path: '/verify', body: { token: DEMO_TOKEN }, deadlineMs: 6000 });
      const checkoutStatus = checkout.kind === 'response' ? checkout.statusCode : checkout.kind;
      const sessionStatus = session.kind === 'response' ? session.statusCode : session.kind;
      // Under the fault, a session call may exceed its 800 ms deadline (504): still a failure, never a success.
      const sessionFailedClosed = sessionStatus === 401 || (mode.mode === 'redis_latency' && sessionStatus === 504);
      record(`unknown token rejected (${mode.mode})`, checkoutStatus !== 201 && checkoutStatus !== 200 && sessionFailedClosed, `checkout=${checkoutStatus} session=${sessionStatus}`);
      record(`demo token verifies at auth (${mode.mode})`, valid.kind === 'response' && valid.statusCode === 200, `verify=${valid.kind === 'response' ? valid.statusCode : valid.kind}`);
    }
  } finally {
    await callJson({ port: CONTROL_PORT, method: 'POST', path: '/control/shutdown', body: {}, deadlineMs: 1000 }).catch(() => undefined);
    setTimeout(() => child.kill('SIGKILL'), 1500).unref();
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  const bundle = await bundlePayload(ROOT, path.join(WORK, 'payload'));
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0;
  console.log(`payload ${bundle.payloadHash} (esbuild ${bundle.esbuildVersion}); HEAD ${sourceSha}${dirty ? ' + UNCOMMITTED working tree (development only)' : ''}`);

  const base = { schemaVersion: 1 as const, runId: 'payload-check', sourceSha, payloadHash: bundle.payloadHash, workloadHash: computeWorkloadHash() };
  const control = await runTrial(bundle.outDir, { ...base, trialId: 'check-control', kind: 'control', fault: null });
  const chaos = await runTrial(bundle.outDir, { ...base, trialId: 'check-chaos', kind: 'chaos', fault: { targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', delayMs: 3000, durationMs: 10000 } });

  const healthy = evaluateBaselineTrial(control);
  record('healthy control passes baseline gates', healthy.validity === 'valid', healthy.reasons.join(' ') || `130/130 completed, 0 errors, p95 checkout ${control.clientSummary.checkoutP95Ms?.toFixed(1)} ms`);
  const chaosGate = evaluateChaosTrial(chaos);
  record('chaos measurement passes quality gates', chaosGate.validity === 'valid', chaosGate.reasons.join(' ') || `${chaos.clientSummary.checkoutCompleted} checkouts, witness=${chaos.faultWitnessed}`);
  record('fault witnessed on a business trace', chaos.faultWitnessed, `faultWitnessed=${chaos.faultWitnessed}`);
  const increase = (chaos.clientSummary.checkoutErrorRate ?? 0) - (control.clientSummary.checkoutErrorRate ?? 0);
  record('checkout error fraction rises >= 0.20', increase >= 0.2, `control=${control.clientSummary.checkoutErrorRate} chaos=${chaos.clientSummary.checkoutErrorRate?.toFixed(3)} (+${increase.toFixed(3)})`);
  const payment = chaos.metrics.find((metric) => metric.serviceId === 'payment-service' && metric.channel === 'business');
  const queuePressure = (payment?.requestsQueued ?? 0) > 0 || (payment?.queueRejected ?? 0) > 0 || (payment?.longestSaturatedIntervalMs ?? 0) >= 500;
  record('Payment queues/rejects or saturates >= 500 ms', queuePressure, `queued=${payment?.requestsQueued} rejected=${payment?.queueRejected} longestFull=${payment?.longestSaturatedIntervalMs?.toFixed(0)}ms peakActive=${payment?.activeSlotsPeak} peakQueue=${payment?.queueLengthPeak}`);
  const comparison = evaluateMatchedPairAndBlastRadius(control, chaos);
  record('matched comparison is valid', comparison.comparisonValidity === 'valid', comparison.comparisonReasons.join(' ') || `affected=[${comparison.actualBlastRadiusIds.join(', ')}] observedEdges=${comparison.observedCascadeEdges.length}`);
  for (const metric of chaos.metrics.filter((candidate) => candidate.sampleCount > 0)) {
    console.log(`      ${metric.serviceId.padEnd(16)} ${metric.channel.padEnd(8)} ${metric.status.padEnd(9)} N=${String(metric.sampleCount).padEnd(4)} err=${metric.errorRate?.toFixed(2)} p95=${metric.latencyP95Ms?.toFixed(1)}ms`);
  }

  await checkAuthFailsClosed(bundle.outDir);
  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Artifacts: ${WORK}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
