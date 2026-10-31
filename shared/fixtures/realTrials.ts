// Test fixtures built from REAL payload reports (npm run payload:check output), so comparator
// tests exercise genuine metric/span/witness relationships instead of hand-written approximations.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { classifyMetricHealth, REQUIRED_EVIDENCE_KINDS, TrialTelemetrySchema, type TrialKind, type TrialTelemetry } from '../types.js';

export interface RealTrialIdentity {
  id: string;
  runId: string;
  kind?: TrialKind;
  sourceSha?: string;
  payloadHash?: string;
  workloadHash?: string;
  runtimeIdentity?: string;
  executionMode?: TrialTelemetry['executionMode'];
}

const raw = (role: 'control' | 'chaos'): Record<string, unknown> => {
  const { schemaVersion: _schemaVersion, ...report } = JSON.parse(readFileSync(path.join(__dirname, `real-${role}.trial.json`), 'utf8')) as Record<string, unknown>;
  return report;
};

/** A healthy control ('control') or Redis-delay chaos ('chaos') report, re-identified for a test. */
export function realTrial(role: 'control' | 'chaos', identity: RealTrialIdentity): TrialTelemetry {
  const report = raw(role) as unknown as TrialTelemetry;
  return TrialTelemetrySchema.parse({
    ...report,
    id: identity.id,
    runId: identity.runId,
    kind: identity.kind ?? role,
    sourceSha: identity.sourceSha ?? 'a'.repeat(40),
    payloadHash: identity.payloadHash ?? 'b'.repeat(64),
    workloadHash: identity.workloadHash ?? 'b'.repeat(64),
    runtimeIdentity: identity.runtimeIdentity ?? 'node-22',
    executionMode: identity.executionMode ?? 'development-local',
    cleanupStatus: 'DELETED',
    metrics: report.metrics.map((metric) => ({ ...metric, id: `${identity.id}:${metric.serviceId}:${metric.channel}` })),
    artifacts: REQUIRED_EVIDENCE_KINDS.map((kind) => ({ id: `${identity.id}:${kind}`, kind, sizeBytes: 1, sha256: 'c'.repeat(64), truncated: false, available: true }))
  });
}

const nearestRank = (values: readonly number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
};

/**
 * Recomputes every metric from the trial's retained server spans exactly as the payload does, so a
 * test that edits evidence (spans) gets a self-consistent report instead of a contradictory one.
 * Payment gate counters are kept as reported unless overridden.
 */
export function withRecomputedMetrics(trial: TrialTelemetry, gate?: Partial<Pick<TrialTelemetry['metrics'][number], 'requestsQueued' | 'queueRejected' | 'longestSaturatedIntervalMs' | 'activeSlotsPeak' | 'queueLengthPeak'>>): TrialTelemetry {
  const metrics = trial.metrics.map((metric) => {
    const server = trial.spans.filter((span) => span.kind === 'server' && span.serviceId === metric.serviceId && span.channel === metric.channel);
    const durations = server.map((span) => span.durationMs);
    const errors = server.filter((span) => span.statusCode === undefined || span.statusCode < 200 || span.statusCode >= 300).length;
    const timeouts = server.filter((span) => span.errorClass === 'timeout').length;
    const completed = server.length;
    const next = {
      ...metric, ...(gate && metric.serviceId === 'payment-service' && metric.channel === 'business' ? gate : {}),
      requestsStarted: completed, requestsCompleted: completed, errorsTotal: errors, timeoutsTotal: timeouts, errorRate: completed ? errors / completed : null,
      latencyP50Ms: nearestRank(durations, 0.5), latencyP95Ms: nearestRank(durations, 0.95), latencyP99Ms: nearestRank(durations, 0.99), sampleCount: completed, smallSample: completed < 20
    };
    return { ...next, status: classifyMetricHealth(next) };
  });
  return TrialTelemetrySchema.parse({ ...trial, metrics });
}
