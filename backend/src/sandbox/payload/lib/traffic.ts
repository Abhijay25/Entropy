import { createHash } from 'node:crypto';

import type { ClientSummary } from '../../../../../shared/types.js';
import { DEMO_TOKEN, SERVICE_PORTS, TIMING, WORKLOAD } from './constants.js';
import { callJson, type CallOutcome } from './http.js';
import { nearestRankPercentile } from './metrics.js';
import { CHANNEL_HEADER, TRACE_HEADER, type Channel } from './spans.js';

export type LaunchKind = 'checkout' | 'session' | 'redis-canary' | 'postgres-canary';

export interface ScheduledLaunch {
  kind: LaunchKind;
  index: number;
  offsetMs: number;
}

export interface RootSample {
  kind: LaunchKind;
  index: number;
  traceId: string;
  offsetMs: number;
  launchedAtMs: number;
  durationMs: number;
  statusCode?: number;
  outcome: 'response' | 'timeout' | 'error';
  error: boolean;
}

export interface WorkloadResult {
  scheduled: ScheduledLaunch[];
  samples: RootSample[];
  skipped: ScheduledLaunch[];
  maxInFlight: number;
  windowStartedAtMs: number;
  windowEndedAtMs: number;
}

const TRACE_CODES: Record<LaunchKind, string> = { checkout: 'co', session: 'se', 'redis-canary': 'rc', 'postgres-canary': 'pc' };

export function traceTag(trialId: string): string {
  return createHash('sha256').update(trialId).digest('hex').slice(0, 12);
}

const pad = (index: number) => String(index + 1).padStart(4, '0');

export function measuredSchedule(): ScheduledLaunch[] {
  const launches: ScheduledLaunch[] = [
    ...WORKLOAD.checkoutOffsetsMs.map((offsetMs, index) => ({ kind: 'checkout' as const, index, offsetMs })),
    ...WORKLOAD.secondaryOffsetsMs.map((offsetMs, index) => ({ kind: 'session' as const, index, offsetMs })),
    ...WORKLOAD.secondaryOffsetsMs.map((offsetMs, index) => ({ kind: 'redis-canary' as const, index, offsetMs })),
    ...WORKLOAD.secondaryOffsetsMs.map((offsetMs, index) => ({ kind: 'postgres-canary' as const, index, offsetMs }))
  ];
  return launches.sort((left, right) => left.offsetMs - right.offsetMs);
}

function send(launch: ScheduledLaunch, traceId: string, orderPrefix = 'order'): Promise<CallOutcome> {
  const channel: Channel = launch.kind === 'checkout' || launch.kind === 'session' ? 'business' : 'canary';
  const headers = { [TRACE_HEADER]: traceId, [CHANNEL_HEADER]: channel };
  const deadlineMs = TIMING.generatorRequestDeadlineMs;
  switch (launch.kind) {
    case 'checkout':
      return callJson({ port: SERVICE_PORTS.frontend, method: 'POST', path: '/checkout', body: { orderId: `${orderPrefix}-${pad(launch.index)}`, token: DEMO_TOKEN, amountCents: WORKLOAD.amountCents }, headers, deadlineMs });
    case 'session':
      return callJson({ port: SERVICE_PORTS.frontend, method: 'GET', path: '/session', headers: { ...headers, authorization: `Bearer ${DEMO_TOKEN}` }, deadlineMs });
    case 'redis-canary':
      return callJson({ port: SERVICE_PORTS['redis-cache'], method: 'POST', path: '/lookup', body: { token: DEMO_TOKEN }, headers, deadlineMs });
    case 'postgres-canary':
      return callJson({ port: SERVICE_PORTS['postgres-db'], method: 'POST', path: '/write', body: { orderId: `canary-${pad(launch.index)}`, authorizationId: `canary-auth-${pad(launch.index)}` }, headers, deadlineMs });
  }
}

function toSample(launch: ScheduledLaunch, traceId: string, launchedAtMs: number, outcome: CallOutcome): RootSample {
  const statusCode = outcome.kind === 'response' ? outcome.statusCode : undefined;
  return {
    kind: launch.kind, index: launch.index, traceId, offsetMs: launch.offsetMs, launchedAtMs, durationMs: outcome.elapsedMs, outcome: outcome.kind,
    ...(statusCode === undefined ? {} : { statusCode }),
    error: outcome.kind !== 'response' || statusCode === undefined || statusCode < 200 || statusCode >= 300
  };
}

/** Ten healthy checkouts at concurrency two; excluded from measurement by the reset that follows. */
export async function runWarmup(trialId: string): Promise<RootSample[]> {
  const tag = traceTag(trialId);
  const queue = Array.from({ length: WORKLOAD.warmupCheckouts }, (_, index): ScheduledLaunch => ({ kind: 'checkout', index, offsetMs: 0 }));
  const samples: RootSample[] = [];
  const worker = async () => {
    for (let launch = queue.shift(); launch; launch = queue.shift()) {
      const traceId = `${tag}-wu-${pad(launch.index)}`;
      const launchedAtMs = performance.now();
      samples.push(toSample(launch, traceId, launchedAtMs, await send(launch, traceId, 'warmup')));
    }
  };
  await Promise.all(Array.from({ length: WORKLOAD.warmupConcurrency }, worker));
  return samples;
}

/**
 * Open-loop schedule: launches fire on fixed ticks without waiting for earlier
 * responses, capped at the generator concurrency limit (a cap hit is a skip).
 */
export async function runMeasuredWorkload(trialId: string): Promise<WorkloadResult> {
  const tag = traceTag(trialId);
  const scheduled = measuredSchedule();
  const samples: RootSample[] = [];
  const skipped: ScheduledLaunch[] = [];
  const pending = new Set<Promise<void>>();
  const unresolved = new Map<string, { launch: ScheduledLaunch; launchedAtMs: number }>();
  let drained = false;
  let maxInFlight = 0;
  const windowStartedAtMs = performance.now();
  const lastOffset = scheduled[scheduled.length - 1]?.offsetMs ?? 0;

  for (const launch of scheduled) {
    const due = windowStartedAtMs + launch.offsetMs;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (pending.size >= WORKLOAD.generatorConcurrencyCap) { skipped.push(launch); continue; }
    const traceId = `${tag}-${TRACE_CODES[launch.kind]}-${pad(launch.index)}`;
    const launchedAtMs = performance.now();
    unresolved.set(traceId, { launch, launchedAtMs });
    const task: Promise<void> = send(launch, traceId).then((outcome) => {
      if (drained) return;
      unresolved.delete(traceId);
      samples.push(toSample(launch, traceId, launchedAtMs, outcome));
    }).finally(() => { pending.delete(task); });
    pending.add(task);
    maxInFlight = Math.max(maxInFlight, pending.size);
  }

  // Each root call has its own 6 s deadline, so this drain is bounded; the race is a backstop.
  const drainDeadline = windowStartedAtMs + lastOffset + 100 + WORKLOAD.drainMs;
  await Promise.race([Promise.all([...pending]), new Promise((resolve) => setTimeout(resolve, Math.max(0, drainDeadline - performance.now()) + 250))]);
  drained = true;
  // Anything still unresolved becomes an explicit client timeout, never a missing success.
  for (const [traceId, { launch, launchedAtMs }] of unresolved) {
    samples.push(toSample(launch, traceId, launchedAtMs, { kind: 'timeout', elapsedMs: performance.now() - launchedAtMs }));
  }
  return { scheduled, samples, skipped, maxInFlight, windowStartedAtMs, windowEndedAtMs: performance.now() };
}

export function summarizeClient(result: WorkloadResult): ClientSummary {
  const completed = result.samples.length;
  const errors = result.samples.filter((sample) => sample.error).length;
  const checkouts = result.samples.filter((sample) => sample.kind === 'checkout');
  const checkoutErrors = checkouts.filter((sample) => sample.error).length;
  const checkoutScheduled = result.scheduled.filter((launch) => launch.kind === 'checkout').length;
  const checkoutSkipped = result.skipped.filter((launch) => launch.kind === 'checkout').length;
  const count = (kind: LaunchKind) => result.samples.filter((sample) => sample.kind === kind).length;
  return {
    scheduled: result.scheduled.length,
    started: result.scheduled.length - result.skipped.length,
    completed,
    skipped: result.skipped.length,
    errors,
    checkoutStarted: checkoutScheduled - checkoutSkipped,
    checkoutCompleted: checkouts.length,
    checkoutErrors,
    checkoutErrorRate: checkouts.length === 0 ? null : checkoutErrors / checkouts.length,
    checkoutP95Ms: nearestRankPercentile(checkouts.map((sample) => sample.durationMs), 0.95),
    businessSkipped: result.skipped.filter((launch) => launch.kind === 'checkout' || launch.kind === 'session').length,
    sessionCompleted: count('session'),
    redisCanaryCompleted: count('redis-canary'),
    postgresCanaryCompleted: count('postgres-canary')
  };
}
