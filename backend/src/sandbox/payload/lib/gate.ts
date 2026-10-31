import type { GateCounters } from './metrics.js';

export type GateRejectionReason = 'queue_full' | 'queue_timeout';

export class GateRejection extends Error {
  constructor(readonly reason: GateRejectionReason) {
    super(reason === 'queue_full' ? 'Payment queue is full.' : 'Payment queue wait exceeded its deadline.');
    this.name = 'GateRejection';
  }
}

interface Waiter {
  grant: () => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GateSnapshot extends GateCounters {
  active: number;
  queued: number;
}

/**
 * Explicit bounded concurrency gate with a real FIFO queue. Node's event loop does not
 * block on async HTTP; this gate is what models scarce service capacity.
 */
export class ConcurrencyGate {
  private active = 0;
  private readonly queue: Waiter[] = [];
  private readonly now: () => number;
  private counters: GateCounters = { activeSlotsPeak: 0, queueLengthPeak: 0, requestsQueued: 0, queueRejected: 0, longestSaturatedIntervalMs: 0 };
  private saturatedSince: number | undefined;

  constructor(private readonly options: { slots: number; queueCapacity: number; maxQueueWaitMs: number; now?: () => number }) {
    this.now = options.now ?? (() => performance.now());
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  snapshot(): GateSnapshot {
    const longest = this.saturatedSince === undefined ? this.counters.longestSaturatedIntervalMs : Math.max(this.counters.longestSaturatedIntervalMs, this.now() - this.saturatedSince);
    return { ...this.counters, longestSaturatedIntervalMs: longest, active: this.active, queued: this.queue.length };
  }

  isIdle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  /** Clears measurement counters; refuses while work is active or queued. */
  resetCounters(): boolean {
    if (!this.isIdle()) return false;
    this.counters = { activeSlotsPeak: 0, queueLengthPeak: 0, requestsQueued: 0, queueRejected: 0, longestSaturatedIntervalMs: 0 };
    this.saturatedSince = undefined;
    return true;
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.slots) {
      this.occupy();
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.queueCapacity) {
      this.counters.queueRejected += 1;
      return Promise.reject(new GateRejection('queue_full'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => { clearTimeout(waiter.timer); this.occupy(); resolve(); },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiter);
          if (index >= 0) this.queue.splice(index, 1);
          this.counters.queueRejected += 1;
          reject(new GateRejection('queue_timeout'));
        }, this.options.maxQueueWaitMs)
      };
      this.queue.push(waiter);
      this.counters.requestsQueued += 1;
      this.counters.queueLengthPeak = Math.max(this.counters.queueLengthPeak, this.queue.length);
    });
  }

  private occupy(): void {
    this.active += 1;
    this.counters.activeSlotsPeak = Math.max(this.counters.activeSlotsPeak, this.active);
    if (this.active === this.options.slots && this.saturatedSince === undefined) this.saturatedSince = this.now();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      // Hand the slot straight to the next waiter: occupancy never drops, so a
      // saturated interval continues uninterrupted.
      this.active -= 1;
      next.grant();
      return;
    }
    if (this.saturatedSince !== undefined) {
      this.counters.longestSaturatedIntervalMs = Math.max(this.counters.longestSaturatedIntervalMs, this.now() - this.saturatedSince);
      this.saturatedSince = undefined;
    }
    this.active -= 1;
  }
}
