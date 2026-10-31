import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CONTROL_PORT, DEMO_TOKEN, SERVICE_PORTS } from './constants.js';
import { callJson } from './http.js';
import { startMesh, type MeshHandle, type MeshSnapshot } from './mesh.js';
import { CHANNEL_HEADER, TRACE_HEADER } from './spans.js';

let mesh: MeshHandle;
const order = (orderId: string, token = DEMO_TOKEN) => ({ orderId, token, amountCents: 2500 });
const checkout = (body: unknown, traceId: string) => callJson({ port: SERVICE_PORTS.frontend, method: 'POST', path: '/checkout', body, headers: { [TRACE_HEADER]: traceId, [CHANNEL_HEADER]: 'business' }, deadlineMs: 6000 });
const snapshot = async () => { const result = await callJson({ port: CONTROL_PORT, method: 'GET', path: '/control/snapshot', deadlineMs: 2000 }); return (result.kind === 'response' ? result.body : undefined) as MeshSnapshot; };
const controlPost = (path: string, body: unknown) => callJson({ port: CONTROL_PORT, method: 'POST', path, body, deadlineMs: 2000 });

beforeAll(async () => { mesh = await startMesh(); });
afterAll(async () => { await mesh.close(); });

describe('mock mesh', () => {
  it('completes a healthy checkout with the plan wire format and linked spans', async () => {
    const result = await checkout(order('order-0001'), 'test-co-0001');
    expect(result).toMatchObject({ kind: 'response', statusCode: 201, body: { orderId: 'order-0001', authorizationId: 'auth-order-0001' } });
    const spans = (await snapshot()).spans.filter((span) => span.traceId === 'test-co-0001');
    const servers = spans.filter((span) => span.kind === 'server').map((span) => span.serviceId).sort();
    expect(servers).toEqual(['auth-service', 'frontend', 'order-service', 'payment-service', 'postgres-db', 'redis-cache']);
    for (const span of spans.filter((candidate) => candidate.kind === 'server' && candidate.serviceId !== 'frontend')) {
      const parent = spans.find((candidate) => candidate.id === span.parentSpanId);
      expect(parent?.kind).toBe('client');
      expect(parent?.downstreamId).toBe(span.serviceId);
    }
  });

  it('fails closed on an unknown token and never writes a payment record', async () => {
    const result = await checkout(order('order-0002', 'not-a-token'), 'test-co-0002');
    expect(result).toMatchObject({ kind: 'response', statusCode: 401, body: { error: { code: 'AUTH_DENIED' } } });
    const spans = (await snapshot()).spans.filter((span) => span.traceId === 'test-co-0002');
    expect(spans.some((span) => span.serviceId === 'postgres-db')).toBe(false);
  });

  it('rejects malformed and unknown-field input', async () => {
    expect(await checkout({ ...order('order-0003'), extra: true }, 'test-co-0003')).toMatchObject({ statusCode: 400, body: { error: { code: 'INVALID_INPUT' } } });
    expect(await checkout({ orderId: 'order-0004', token: DEMO_TOKEN, amountCents: -1 }, 'test-co-0004')).toMatchObject({ statusCode: 400 });
  });

  it('rejects any fault other than the fixed Redis latency command', async () => {
    expect(await controlPost('/control/fault', { mode: 'redis_latency', delayMs: 10, durationMs: 10000 })).toMatchObject({ statusCode: 400 });
    expect(await controlPost('/control/fault', { mode: 'kill' })).toMatchObject({ statusCode: 400 });
  });

  it('applies the Redis delay to business requests, keeps /health independent, and records witnesses', async () => {
    expect(await controlPost('/control/reset', {})).toMatchObject({ statusCode: 200 });
    const ack = await controlPost('/control/fault', { mode: 'redis_latency', delayMs: 3000, durationMs: 10000 });
    expect(ack).toMatchObject({ statusCode: 200, body: { mode: 'redis_latency', delayMs: 3000 } });

    const lookup = callJson({ port: SERVICE_PORTS['redis-cache'], method: 'POST', path: '/lookup', body: { token: DEMO_TOKEN }, headers: { [TRACE_HEADER]: 'test-rc-0001', [CHANNEL_HEADER]: 'canary' }, deadlineMs: 6000 });
    const health = await callJson({ port: SERVICE_PORTS['redis-cache'], method: 'GET', path: '/health', deadlineMs: 500 });
    expect(health).toMatchObject({ kind: 'response', statusCode: 200, body: { ok: true, serviceId: 'redis-cache' } });
    expect(health.elapsedMs).toBeLessThan(500);

    const delayed = await lookup;
    expect(delayed).toMatchObject({ kind: 'response', statusCode: 200 });
    expect(delayed.elapsedMs).toBeGreaterThanOrEqual(2900);

    const state = await snapshot();
    const span = state.spans.find((candidate) => candidate.traceId === 'test-rc-0001' && candidate.kind === 'server');
    expect(span?.faultApplied).toBe(true);
    expect(state.witnesses.map((witness) => witness.spanId)).toContain(span?.id);
    expect(state.spans.some((candidate) => candidate.serviceId === 'redis-cache' && candidate.channel === 'business')).toBe(false);
    expect(await controlPost('/control/fault', { mode: 'healthy' })).toMatchObject({ statusCode: 200 });
  }, 10_000);
});
