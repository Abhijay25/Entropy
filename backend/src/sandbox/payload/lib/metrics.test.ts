import { describe, expect, it } from 'vitest';

import { aggregateServiceMetric, classifyHealth, nearestRankPercentile } from './metrics.js';
import type { RecordedSpan } from './spans.js';

function serverSpan(serviceId: RecordedSpan['serviceId'], durationMs: number, statusCode: number, overrides: Partial<RecordedSpan> = {}): RecordedSpan {
  return { id: `span-${Math.random().toString(36).slice(2)}`, kind: 'server', traceId: 'trace-1', serviceId, channel: 'business', startedAt: '2026-01-01T00:00:00.000Z', durationMs, statusCode, faultApplied: false, ...overrides };
}

describe('nearestRankPercentile', () => {
  it('returns null for no observations', () => {
    expect(nearestRankPercentile([], 0.95)).toBeNull();
  });

  it('uses index max(0, ceil(p*N)-1) on ascending durations', () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);
    expect(nearestRankPercentile(values, 0.5)).toBe(50);
    expect(nearestRankPercentile(values, 0.95)).toBe(95);
    expect(nearestRankPercentile(values, 0.99)).toBe(99);
    expect(nearestRankPercentile([7], 0.99)).toBe(7);
    expect(nearestRankPercentile([1, 2], 0)).toBe(1);
  });
});

describe('aggregateServiceMetric', () => {
  it('includes failure durations in percentiles and counts errors once', () => {
    const spans = [
      ...Array.from({ length: 18 }, () => serverSpan('order-service', 10, 201)),
      serverSpan('order-service', 1200, 504, { errorClass: 'timeout' }),
      serverSpan('order-service', 1300, 502, { errorClass: 'dependency_error' })
    ];
    const metric = aggregateServiceMetric({ trialId: 'trial-1', serviceId: 'order-service', channel: 'business', spans, started: 20 });
    expect(metric.id).toBe('trial-1:order-service:business');
    expect(metric.requestsCompleted).toBe(20);
    expect(metric.errorsTotal).toBe(2);
    expect(metric.timeoutsTotal).toBe(1);
    expect(metric.errorRate).toBe(0.1);
    expect(metric.latencyP95Ms).toBe(1200);
    expect(metric.latencyP99Ms).toBe(1300);
    expect(metric.smallSample).toBe(false);
  });

  it('ignores client spans and other channels', () => {
    const spans = [serverSpan('auth-service', 5, 200), serverSpan('auth-service', 5, 200, { kind: 'client' }), serverSpan('auth-service', 5, 200, { channel: 'canary' })];
    const metric = aggregateServiceMetric({ trialId: 't', serviceId: 'auth-service', channel: 'business', spans, started: 1 });
    expect(metric.requestsCompleted).toBe(1);
    expect(metric.smallSample).toBe(true);
  });

  it('reports UNKNOWN with null rates when nothing completed', () => {
    const metric = aggregateServiceMetric({ trialId: 't', serviceId: 'postgres-db', channel: 'business', spans: [], started: 0 });
    expect(metric.status).toBe('UNKNOWN');
    expect(metric.errorRate).toBeNull();
    expect(metric.latencyP50Ms).toBeNull();
  });
});

describe('classifyHealth', () => {
  const base = { requestsCompleted: 20, errorRate: 0, latencyP95Ms: 10 };

  it('requires samples before judging', () => {
    expect(classifyHealth({ requestsCompleted: 0, errorRate: null, latencyP95Ms: null })).toBe('UNKNOWN');
  });

  it('marks DOWN only with at least 10 samples and error fraction >= 0.8', () => {
    expect(classifyHealth({ ...base, errorRate: 0.8 })).toBe('DOWN');
    expect(classifyHealth({ requestsCompleted: 9, errorRate: 1, latencyP95Ms: 10 })).toBe('DEGRADED');
  });

  it('marks DEGRADED for errors, slow p95, or queue evidence', () => {
    expect(classifyHealth({ ...base, errorRate: 0.05 })).toBe('DEGRADED');
    expect(classifyHealth({ ...base, latencyP95Ms: 501 })).toBe('DEGRADED');
    expect(classifyHealth({ ...base, latencyP95Ms: 500 })).toBe('HEALTHY');
    expect(classifyHealth({ ...base, gate: { requestsQueued: 1, queueRejected: 0, longestSaturatedIntervalMs: 0 } })).toBe('DEGRADED');
    expect(classifyHealth({ ...base, gate: { requestsQueued: 0, queueRejected: 0, longestSaturatedIntervalMs: 499 } })).toBe('HEALTHY');
    expect(classifyHealth({ ...base, gate: { requestsQueued: 0, queueRejected: 0, longestSaturatedIntervalMs: 500 } })).toBe('DEGRADED');
  });
});
