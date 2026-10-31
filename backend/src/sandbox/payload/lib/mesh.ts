import { createHash } from 'node:crypto';
import http from 'node:http';

import type { ServiceId } from '../../../../../shared/types.js';
import { CONTROL_PORT, DEMO_SUBJECT, DEMO_TOKEN, HARNESS, PAYMENT_GATE, SERVICE_IDS, SERVICE_PORTS, TIMING } from './constants.js';
import { ConcurrencyGate, GateRejection, type GateSnapshot } from './gate.js';
import { callJson, close, hasOnlyKeys, HttpInputError, isPlainObject, listen, readJsonBody, sendJson, type CallOutcome } from './http.js';
import { CHANNEL_HEADER, isSafeId, PARENT_HEADER, SpanStore, TRACE_HEADER, wallIso, type Channel, type RecordedSpan } from './spans.js';

export type FaultMode = { mode: 'healthy' } | { mode: 'redis_latency'; delayMs: 3000; durationMs: 10_000 };

export interface FaultAck {
  mode: FaultMode['mode'];
  delayMs: number;
  durationMs: number;
  configHash: string;
  activatedAtMonotonicMs: number;
  activatedAt: string;
}

export interface FaultWitness {
  spanId: string;
  traceId: string;
  channel: Channel;
  enteredAtMonotonicMs: number;
  delayMs: number;
}

export interface MeshSnapshot {
  spans: RecordedSpan[];
  spanOverflow: number;
  started: Array<{ serviceId: ServiceId; channel: Channel; count: number }>;
  gate: GateSnapshot;
  fault: FaultAck;
  witnesses: FaultWitness[];
  inFlight: number;
  runtime: { node: string; platform: string; arch: string; pid: number };
}

export interface MeshHandle {
  close(): Promise<void>;
  /** Resolves when POST /control/shutdown is received. */
  shutdownRequested: Promise<void>;
}

type ErrorClass = NonNullable<RecordedSpan['errorClass']>;
interface HandlerResult { statusCode: number; body: unknown; errorClass?: ErrorClass; faultApplied?: boolean }
interface RequestContext { traceId: string; serverSpanId: string; channel: Channel; serviceId: ServiceId }

const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function errorBody(code: string, requestId: string): { error: { code: string; requestId: string } } {
  return { error: { code, requestId } };
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface OrderInput { orderId: string; token: string; amountCents: number }

function parseOrder(value: unknown): OrderInput | undefined {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['orderId', 'token', 'amountCents'])) return undefined;
  const { orderId, token, amountCents } = value;
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return undefined;
  if (typeof token !== 'string' || token.length < 1 || token.length > 256) return undefined;
  if (typeof amountCents !== 'number' || !Number.isSafeInteger(amountCents) || amountCents <= 0) return undefined;
  return { orderId, token, amountCents };
}

function parseToken(value: unknown): string | undefined {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['token'])) return undefined;
  return typeof value.token === 'string' && value.token.length >= 1 && value.token.length <= 256 ? value.token : undefined;
}

export function parseFaultMode(value: unknown): FaultMode | undefined {
  if (!isPlainObject(value)) return undefined;
  if (value.mode === 'healthy' && hasOnlyKeys(value, ['mode'])) return { mode: 'healthy' };
  if (value.mode === 'redis_latency' && hasOnlyKeys(value, ['mode', 'delayMs', 'durationMs']) && value.delayMs === TIMING.chaosRedisDelayMs && value.durationMs === 10_000) {
    return { mode: 'redis_latency', delayMs: 3000, durationMs: 10_000 };
  }
  return undefined;
}

/** Six loopback HTTP services plus a private controller, all in one Node process. */
export async function startMesh(options: { log?: (line: string) => void } = {}): Promise<MeshHandle> {
  const log = options.log ?? (() => undefined);
  const spans = new SpanStore(HARNESS.maxSpans);
  const startedCounts = new Map<string, number>();
  const paymentGate = new ConcurrencyGate(PAYMENT_GATE);
  const tokens = new Map<string, string>();
  const paymentRecords = new Map<string, string>();
  let witnesses: FaultWitness[] = [];
  let inFlight = 0;
  let adhocTrace = 0;
  let fault: { mode: FaultMode; activatedAt: number; expiresAt: number } = { mode: { mode: 'healthy' }, activatedAt: performance.now(), expiresAt: Infinity };

  const seedStores = () => {
    tokens.clear();
    tokens.set(DEMO_TOKEN, DEMO_SUBJECT);
    paymentRecords.clear();
  };
  seedStores();

  const faultAck = (): FaultAck => {
    const delayMs = fault.mode.mode === 'redis_latency' ? fault.mode.delayMs : 0;
    const durationMs = fault.mode.mode === 'redis_latency' ? fault.mode.durationMs : 0;
    return { mode: fault.mode.mode, delayMs, durationMs, configHash: hashJson(fault.mode), activatedAtMonotonicMs: fault.activatedAt, activatedAt: wallIso(fault.activatedAt) };
  };

  const call = async (context: RequestContext, target: ServiceId, method: 'GET' | 'POST', path: string, body: unknown, deadlineMs: number): Promise<CallOutcome> => {
    const clientSpanId = spans.nextId(context.traceId);
    const startedAt = performance.now();
    const outcome = await callJson({
      port: SERVICE_PORTS[target], method, path, body, deadlineMs,
      headers: { [TRACE_HEADER]: context.traceId, [PARENT_HEADER]: clientSpanId, [CHANNEL_HEADER]: context.channel }
    });
    const statusCode = outcome.kind === 'response' ? outcome.statusCode : undefined;
    const errorClass: ErrorClass | undefined = outcome.kind === 'timeout' ? 'timeout' : outcome.kind === 'error' || (statusCode !== undefined && statusCode >= 500) ? 'dependency_error' : undefined;
    spans.add({
      id: clientSpanId, kind: 'client', traceId: context.traceId, parentSpanId: context.serverSpanId, serviceId: context.serviceId, downstreamId: target, channel: context.channel,
      startedAt: wallIso(startedAt), durationMs: outcome.elapsedMs, ...(statusCode !== undefined && statusCode >= 100 && statusCode <= 599 ? { statusCode } : {}), ...(errorClass ? { errorClass } : {}), faultApplied: false
    });
    return outcome;
  };

  /** Maps a dependency outcome to this service's response. 401 is preserved: auth stays fail-closed. */
  const fromDependency = (outcome: CallOutcome, context: RequestContext, onSuccess: (body: unknown) => HandlerResult): HandlerResult => {
    if (outcome.kind === 'timeout') return { statusCode: 504, body: errorBody('DEPENDENCY_TIMEOUT', context.serverSpanId), errorClass: 'timeout' };
    if (outcome.kind === 'error') return { statusCode: 502, body: errorBody('DEPENDENCY_ERROR', context.serverSpanId), errorClass: 'dependency_error' };
    if (outcome.statusCode === 401) return { statusCode: 401, body: errorBody('AUTH_DENIED', context.serverSpanId) };
    if (outcome.statusCode < 200 || outcome.statusCode >= 300) return { statusCode: 502, body: errorBody('DEPENDENCY_ERROR', context.serverSpanId), errorClass: 'dependency_error' };
    return onSuccess(outcome.body);
  };

  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  type Route = (context: RequestContext, request: http.IncomingMessage) => Promise<HandlerResult>;
  const invalid = (context: RequestContext): HandlerResult => ({ statusCode: 400, body: errorBody('INVALID_INPUT', context.serverSpanId) });
  const verifyToken = async (context: RequestContext, token: string, deadlineMs: number) =>
    fromDependency(await call(context, 'auth-service', 'POST', '/verify', { token }, deadlineMs), context, () => ({ statusCode: 200, body: { valid: true, subject: DEMO_SUBJECT } }));

  const routes: Record<ServiceId, Record<string, Route>> = {
    frontend: {
      'POST /checkout': async (context, request) => {
        const order = parseOrder(await readJsonBody(request));
        if (!order) return invalid(context);
        return fromDependency(await call(context, 'order-service', 'POST', '/orders', order, TIMING.frontendToOrderDeadlineMs), context, () => ({ statusCode: 201, body: { orderId: order.orderId, authorizationId: `auth-${order.orderId}` } }));
      },
      'GET /session': async (context, request) => {
        const header = request.headers.authorization;
        const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
        if (!token) return { statusCode: 401, body: errorBody('AUTH_DENIED', context.serverSpanId) };
        return verifyToken(context, token, TIMING.frontendToAuthSessionDeadlineMs);
      }
    },
    'order-service': {
      'POST /orders': async (context, request) => {
        const order = parseOrder(await readJsonBody(request));
        if (!order) return invalid(context);
        return fromDependency(await call(context, 'payment-service', 'POST', '/authorize', order, TIMING.orderToPaymentDeadlineMs), context, () => ({ statusCode: 201, body: { orderId: order.orderId, authorizationId: `auth-${order.orderId}` } }));
      }
    },
    'payment-service': {
      'POST /authorize': async (context, request) => {
        const order = parseOrder(await readJsonBody(request));
        if (!order) return invalid(context);
        try {
          return await paymentGate.run(async () => {
            const verified = await verifyToken(context, order.token, TIMING.paymentToAuthDeadlineMs);
            // Never write a payment record after failed verification.
            if (verified.statusCode !== 200) return verified;
            const authorizationId = `auth-${order.orderId}`;
            return fromDependency(await call(context, 'postgres-db', 'POST', '/write', { orderId: order.orderId, authorizationId }, TIMING.paymentToPostgresDeadlineMs), context, () => ({ statusCode: 201, body: { orderId: order.orderId, authorizationId } }));
          });
        } catch (error) {
          if (error instanceof GateRejection) {
            return { statusCode: 503, body: errorBody(error.reason === 'queue_full' ? 'QUEUE_FULL' : 'QUEUE_TIMEOUT', context.serverSpanId), errorClass: error.reason };
          }
          throw error;
        }
      }
    },
    'auth-service': {
      'POST /verify': async (context, request) => {
        const token = parseToken(await readJsonBody(request));
        if (!token) return invalid(context);
        return fromDependency(await call(context, 'redis-cache', 'POST', '/lookup', { token }, TIMING.authToRedisDeadlineMs), context, (body) => ({ statusCode: 200, body: { valid: true, subject: isPlainObject(body) && typeof body.subject === 'string' ? body.subject : DEMO_SUBJECT } }));
      }
    },
    'redis-cache': {
      'POST /lookup': async (context, request) => {
        const token = parseToken(await readJsonBody(request));
        if (!token) return invalid(context);
        // The delay is fixed at entry: a request entering during the fault keeps its 3,000 ms.
        const enteredAt = performance.now();
        const faultActive = fault.mode.mode === 'redis_latency' && enteredAt >= fault.activatedAt && enteredAt < fault.expiresAt;
        const delayMs = faultActive && fault.mode.mode === 'redis_latency' ? fault.mode.delayMs : TIMING.healthyRedisDelayMs;
        if (faultActive) witnesses.push({ spanId: context.serverSpanId, traceId: context.traceId, channel: context.channel, enteredAtMonotonicMs: enteredAt, delayMs });
        await sleep(delayMs);
        const subject = tokens.get(token);
        if (!subject) return { statusCode: 401, body: errorBody('AUTH_DENIED', context.serverSpanId), faultApplied: faultActive };
        return { statusCode: 200, body: { valid: true, subject }, faultApplied: faultActive };
      }
    },
    'postgres-db': {
      'POST /write': async (context, request) => {
        const body = await readJsonBody(request);
        if (!isPlainObject(body) || !hasOnlyKeys(body, ['orderId', 'authorizationId']) || typeof body.orderId !== 'string' || !ORDER_ID.test(body.orderId) || typeof body.authorizationId !== 'string' || body.authorizationId.length > 80) return invalid(context);
        await sleep(TIMING.healthyPostgresDelayMs);
        if (!paymentRecords.has(body.orderId)) paymentRecords.set(body.orderId, body.authorizationId);
        return { statusCode: 200, body: { stored: true } };
      }
    }
  };

  const serviceServer = (serviceId: ServiceId) => http.createServer((request, response) => {
    const route = `${request.method ?? ''} ${(request.url ?? '').split('?')[0] ?? ''}`;
    if (request.method === 'GET' && route === 'GET /health') return sendJson(response, 200, { ok: true, serviceId });
    const headerTrace = request.headers[TRACE_HEADER];
    const traceId = isSafeId(headerTrace) ? headerTrace : `adhoc-${++adhocTrace}`;
    const parentHeader = request.headers[PARENT_HEADER];
    const channel: Channel = request.headers[CHANNEL_HEADER] === 'canary' ? 'canary' : 'business';
    const context: RequestContext = { traceId, serverSpanId: spans.nextId(traceId), channel, serviceId };
    const handler = routes[serviceId][route];
    if (!handler) return sendJson(response, 404, errorBody('NOT_FOUND', context.serverSpanId));
    const key = `${serviceId}|${channel}`;
    startedCounts.set(key, (startedCounts.get(key) ?? 0) + 1);
    inFlight += 1;
    const startedAt = performance.now();
    void handler(context, request)
      .catch((error: unknown): HandlerResult => error instanceof HttpInputError
        ? { statusCode: error.statusCode, body: errorBody(error.code, context.serverSpanId) }
        : { statusCode: 500, body: errorBody('INTERNAL_ERROR', context.serverSpanId) })
      .then((result) => {
        sendJson(response, result.statusCode, result.body);
        spans.add({
          id: context.serverSpanId, kind: 'server', traceId, ...(isSafeId(parentHeader) ? { parentSpanId: parentHeader } : {}), serviceId, channel,
          startedAt: wallIso(startedAt), durationMs: performance.now() - startedAt, statusCode: result.statusCode, ...(result.errorClass ? { errorClass: result.errorClass } : {}), faultApplied: result.faultApplied ?? false
        });
      })
      .finally(() => { inFlight -= 1; });
  });

  let requestShutdown!: () => void;
  const shutdownRequested = new Promise<void>((resolve) => { requestShutdown = resolve; });

  const controlServer = http.createServer((request, response) => {
    const route = `${request.method ?? ''} ${request.url ?? ''}`;
    const requestId = `control-${Date.now()}`;
    void (async () => {
      if (route === 'GET /health') return sendJson(response, 200, { ok: true, serviceId: 'control' });
      if (route === 'GET /control/snapshot') {
        const snapshot: MeshSnapshot = {
          spans: spans.all(), spanOverflow: spans.overflowed,
          started: [...startedCounts].map(([key, count]) => { const [serviceId, channel] = key.split('|') as [ServiceId, Channel]; return { serviceId, channel, count }; }),
          gate: paymentGate.snapshot(), fault: faultAck(), witnesses: [...witnesses], inFlight,
          runtime: { node: process.version, platform: process.platform, arch: process.arch, pid: process.pid }
        };
        return sendJson(response, 200, snapshot);
      }
      const body = await readJsonBody(request).catch(() => undefined);
      if (route === 'POST /control/reset') {
        if (!isPlainObject(body) || Object.keys(body).length) return sendJson(response, 400, errorBody('INVALID_INPUT', requestId));
        if (inFlight > 0 || !paymentGate.isIdle()) return sendJson(response, 409, errorBody('NOT_SETTLED', requestId));
        paymentGate.resetCounters();
        spans.clear();
        startedCounts.clear();
        witnesses = [];
        seedStores();
        log('controller: counters, traces, and stores reset');
        return sendJson(response, 200, { reset: true });
      }
      if (route === 'POST /control/fault') {
        const mode = parseFaultMode(body);
        if (!mode) return sendJson(response, 400, errorBody('INVALID_INPUT', requestId));
        const now = performance.now();
        fault = { mode, activatedAt: now, expiresAt: mode.mode === 'redis_latency' ? now + mode.durationMs : Infinity };
        log(`controller: fault mode ${mode.mode} acknowledged`);
        return sendJson(response, 200, faultAck());
      }
      if (route === 'POST /control/shutdown') {
        sendJson(response, 200, { shuttingDown: true });
        requestShutdown();
        return;
      }
      return sendJson(response, 404, errorBody('NOT_FOUND', requestId));
    })().catch(() => sendJson(response, 500, errorBody('INTERNAL_ERROR', requestId)));
  });

  const servers = SERVICE_IDS.map((serviceId) => ({ serviceId, server: serviceServer(serviceId) }));
  const started: http.Server[] = [];
  try {
    for (const { serviceId, server } of servers) { await listen(server, SERVICE_PORTS[serviceId]); started.push(server); }
    await listen(controlServer, CONTROL_PORT);
    started.push(controlServer);
  } catch (error) {
    await Promise.all(started.map(close));
    throw error;
  }
  log(`mesh: six services on ${Object.values(SERVICE_PORTS).join(',')} and controller on ${CONTROL_PORT}`);
  return { close: () => Promise.all(started.map(close)).then(() => undefined), shutdownRequested };
}
