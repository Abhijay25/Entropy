import type { NodeHealthStatus, ServiceId, ServiceMetric } from '../../../../../shared/types.js';
import { HEALTH_THRESHOLDS } from './constants.js';
import type { Channel, RecordedSpan } from './spans.js';

export interface GateEvidence {
  requestsQueued: number;
  queueRejected: number;
  longestSaturatedIntervalMs: number;
}

export interface GateCounters extends GateEvidence {
  activeSlotsPeak: number;
  queueLengthPeak: number;
}

/** Nearest rank: sort ascending, take index max(0, ceil(p * N) - 1). Null when empty. */
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
}

export function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function hasSaturationEvidence(gate: GateEvidence): boolean {
  return gate.requestsQueued > 0 || gate.queueRejected > 0 || gate.longestSaturatedIntervalMs >= HEALTH_THRESHOLDS.saturatedIntervalMs;
}

export function classifyHealth(input: { requestsCompleted: number; errorRate: number | null; latencyP95Ms: number | null; gate?: GateEvidence }): NodeHealthStatus {
  if (input.requestsCompleted === 0 || input.errorRate === null) return 'UNKNOWN';
  if (input.requestsCompleted >= HEALTH_THRESHOLDS.downMinSamples && input.errorRate >= HEALTH_THRESHOLDS.downErrorFraction) return 'DOWN';
  if (input.errorRate >= HEALTH_THRESHOLDS.degradedErrorFraction) return 'DEGRADED';
  if (input.latencyP95Ms !== null && input.latencyP95Ms > HEALTH_THRESHOLDS.degradedP95Ms) return 'DEGRADED';
  if (input.gate && hasSaturationEvidence(input.gate)) return 'DEGRADED';
  return 'HEALTHY';
}

export function isErrorStatus(statusCode: number | undefined): boolean {
  return statusCode === undefined || statusCode < 200 || statusCode >= 300;
}

/** Service-handler aggregate from receiving-side (kind=server) spans only. */
export function aggregateServiceMetric(input: { trialId: string; serviceId: ServiceId; channel: Channel; spans: readonly RecordedSpan[]; started: number; gate?: GateCounters }): ServiceMetric {
  const samples = input.spans.filter((span) => span.kind === 'server' && span.serviceId === input.serviceId && span.channel === input.channel);
  const completed = samples.length;
  const errors = samples.filter((span) => isErrorStatus(span.statusCode)).length;
  const timeouts = samples.filter((span) => span.errorClass === 'timeout').length;
  const durations = samples.map((span) => span.durationMs);
  const errorRate = completed === 0 ? null : errors / completed;
  const latencyP95Ms = nearestRankPercentile(durations, 0.95);
  const gate = input.gate;
  return {
    id: `${input.trialId}:${input.serviceId}:${input.channel}`,
    serviceId: input.serviceId,
    channel: input.channel,
    status: classifyHealth({ requestsCompleted: completed, errorRate, latencyP95Ms, gate }),
    requestsStarted: Math.max(input.started, completed),
    requestsCompleted: completed,
    errorsTotal: errors,
    timeoutsTotal: timeouts,
    errorRate,
    latencyP50Ms: nearestRankPercentile(durations, 0.5),
    latencyP95Ms,
    latencyP99Ms: nearestRankPercentile(durations, 0.99),
    sampleCount: completed,
    smallSample: completed < HEALTH_THRESHOLDS.smallSample,
    ...(gate ? {
      activeSlotsPeak: gate.activeSlotsPeak,
      longestSaturatedIntervalMs: roundMs(gate.longestSaturatedIntervalMs),
      queueLengthPeak: gate.queueLengthPeak,
      requestsQueued: gate.requestsQueued,
      queueRejected: gate.queueRejected
    } : {})
  };
}
