// Payload constants. The payload bundles to dependency-free Node JS, so it may only
// `import type` from shared/types.ts (a value import would pull zod into the bundle).
import type { ServiceId } from '../../../../../shared/types.js';

export const DEMO_TOKEN = 'entropy-demo-token';
export const DEMO_SUBJECT = 'demo-user';
export const BODY_LIMIT_BYTES = 16 * 1024;
export const CONTROL_PORT = 4199;
export const LOOPBACK = '127.0.0.1';

export const SERVICE_PORTS: Record<ServiceId, number> = {
  frontend: 4100,
  'order-service': 4101,
  'payment-service': 4102,
  'auth-service': 4103,
  'redis-cache': 4104,
  'postgres-db': 4105
};
export const SERVICE_IDS = Object.keys(SERVICE_PORTS) as ServiceId[];

export const PRIMARY_CHANNEL: Record<ServiceId, 'business' | 'canary'> = {
  frontend: 'business',
  'order-service': 'business',
  'payment-service': 'business',
  'auth-service': 'business',
  'redis-cache': 'canary',
  'postgres-db': 'canary'
};

export const TIMING = {
  healthyRedisDelayMs: 5,
  healthyPostgresDelayMs: 8,
  chaosRedisDelayMs: 3000,
  authToRedisDeadlineMs: 4000,
  paymentToAuthDeadlineMs: 4500,
  orderToPaymentDeadlineMs: 1200,
  frontendToOrderDeadlineMs: 1600,
  frontendToAuthSessionDeadlineMs: 800,
  // Not fixed by the plan; generous relative to the 8 ms healthy write.
  paymentToPostgresDeadlineMs: 1000,
  generatorRequestDeadlineMs: 6000
} as const;

export const PAYMENT_GATE = { slots: 4, queueCapacity: 4, maxQueueWaitMs: 1000 } as const;

export const HEALTH_THRESHOLDS = {
  downMinSamples: 10,
  downErrorFraction: 0.8,
  degradedErrorFraction: 0.05,
  degradedP95Ms: 500,
  saturatedIntervalMs: 500,
  smallSample: 20
} as const;

export const WORKLOAD = {
  checkoutOffsetsMs: Array.from({ length: 100 }, (_, index) => index * 100),
  secondaryOffsetsMs: Array.from({ length: 10 }, (_, index) => index * 1000),
  totalScheduled: 130,
  businessScheduled: 110,
  generatorConcurrencyCap: 32,
  maxSkippedBusinessFraction: 0.05,
  warmupCheckouts: 10,
  warmupConcurrency: 2,
  drainMs: 6000,
  amountCents: 2500
} as const;

export const HARNESS = {
  readinessDeadlineMs: 10_000,
  readinessPollMs: 100,
  settleDeadlineMs: 3000,
  serverSettleAfterDrainMs: 6000,
  maxSpans: 3000,
  maxReportBytes: 2 * 1024 * 1024,
  maxLogBytes: 256 * 1024
} as const;

export const ALLOWED_FAULT = { targetServiceId: 'redis-cache', faultType: 'LATENCY_SPIKE', delayMs: 3000, durationMs: 10_000 } as const;

/** Inputs that must be identical across matched trials; hashed into workloadHash. */
export function workloadDefinition(): unknown {
  return { schemaVersion: 1, token: DEMO_TOKEN, ports: SERVICE_PORTS, timing: TIMING, paymentGate: PAYMENT_GATE, health: HEALTH_THRESHOLDS, workload: WORKLOAD, harness: HARNESS, allowedFault: ALLOWED_FAULT };
}
