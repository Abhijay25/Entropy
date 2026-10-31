import { describe, expect, it } from 'vitest';

import { ConcurrencyGate, GateRejection } from './gate.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('ConcurrencyGate', () => {
  it('never exceeds active slots or queue capacity and rejects overflow immediately', async () => {
    const gate = new ConcurrencyGate({ slots: 4, queueCapacity: 4, maxQueueWaitMs: 1000 });
    const blockers = Array.from({ length: 4 }, deferred);
    const running = blockers.map((blocker) => gate.run(() => blocker.promise));
    const queued = Array.from({ length: 4 }, () => gate.run(async () => undefined));
    const overflow = gate.run(async () => undefined);

    await expect(overflow).rejects.toMatchObject({ reason: 'queue_full' });
    expect(gate.snapshot()).toMatchObject({ active: 4, queued: 4, activeSlotsPeak: 4, queueLengthPeak: 4, queueRejected: 1, requestsQueued: 4 });

    blockers.forEach((blocker) => blocker.resolve());
    await Promise.all([...running, ...queued]);
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0, activeSlotsPeak: 4, queueLengthPeak: 4 });
  });

  it('serves the queue in FIFO order', async () => {
    const gate = new ConcurrencyGate({ slots: 1, queueCapacity: 4, maxQueueWaitMs: 1000 });
    const blocker = deferred();
    const order: number[] = [];
    const first = gate.run(() => blocker.promise);
    const waiting = [1, 2, 3].map((value) => gate.run(async () => { order.push(value); }));
    blocker.resolve();
    await Promise.all([first, ...waiting]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('times out queued work after the maximum wait', async () => {
    const gate = new ConcurrencyGate({ slots: 1, queueCapacity: 4, maxQueueWaitMs: 30 });
    const blocker = deferred();
    const first = gate.run(() => blocker.promise);
    const waiting = gate.run(async () => 'never');
    const error = await waiting.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GateRejection);
    expect((error as GateRejection).reason).toBe('queue_timeout');
    expect(gate.snapshot()).toMatchObject({ queued: 0, queueRejected: 1 });
    blocker.resolve();
    await first;
  });

  it('releases the slot when the guarded work throws', async () => {
    const gate = new ConcurrencyGate({ slots: 1, queueCapacity: 1, maxQueueWaitMs: 1000 });
    await expect(gate.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(gate.snapshot().active).toBe(0);
    await expect(gate.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('measures the longest continuous full-occupancy interval', async () => {
    let clock = 0;
    const gate = new ConcurrencyGate({ slots: 2, queueCapacity: 0, maxQueueWaitMs: 1000, now: () => clock });
    const a = deferred(); const b = deferred();
    const first = gate.run(() => a.promise);
    clock = 100;
    const second = gate.run(() => b.promise);
    clock = 700;
    a.resolve(); await first;
    expect(gate.snapshot().longestSaturatedIntervalMs).toBe(600);
    b.resolve(); await second;
  });

  it('resets counters only when idle', async () => {
    const gate = new ConcurrencyGate({ slots: 1, queueCapacity: 0, maxQueueWaitMs: 1000 });
    const blocker = deferred();
    const work = gate.run(() => blocker.promise);
    expect(gate.resetCounters()).toBe(false);
    blocker.resolve(); await work;
    expect(gate.resetCounters()).toBe(true);
    expect(gate.snapshot()).toMatchObject({ activeSlotsPeak: 0, requestsQueued: 0, queueRejected: 0 });
  });
});
